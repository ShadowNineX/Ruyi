import {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { botLogger } from "../logger";
import {
  clearSmitheryTokens,
  saveSmitheryTokens,
  type SmitheryServerId,
} from "../db/models";
import { mcpConnectionManager } from "../mcp/client";
import { SmitheryMCPServer } from "../mcp/smithery";
import {
  parseSmitheryServerId,
  SMITHERY_SERVERS,
} from "./smithery/constants";
import { SmitheryOAuthProvider } from "./smithery/oauth-provider";
import {
  getSmitheryLinkState,
  pendingSmitheryFlows,
} from "./smithery/state";
import {
  addAuthorizationButtons,
  buildAuthorizationDescription,
  buildInvalidSmitheryServerEmbed,
  buildSmitheryManagerEmbed,
  buildSmitheryManagerRows,
} from "./smithery/ui";

export const smitheryCommand = new SlashCommandBuilder()
  .setName("smithery")
  .setDescription("Authorize Smithery MCP servers (YouTube, Brave, etc.)");

export async function handleSmitheryCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  botLogger.debug(
    { user: interaction.user.username },
    "Smithery authorize command",
  );

  const { linkedServerIds, unlinkedServerIds } = await getSmitheryLinkState();

  await interaction.reply({
    embeds: [buildSmitheryManagerEmbed(linkedServerIds, unlinkedServerIds)],
    components: buildSmitheryManagerRows(linkedServerIds, unlinkedServerIds),
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Handle server selection from dropdown.
 */
export async function handleSmitherySelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (interaction.customId !== "smithery_select_server") return;

  await interaction.deferUpdate();

  const selectedValue = interaction.values[0];
  const serverId = selectedValue ? parseSmitheryServerId(selectedValue) : null;
  if (!serverId) {
    await interaction.editReply({
      embeds: [buildInvalidSmitheryServerEmbed(selectedValue ?? "unknown")],
      components: [],
    });
    return;
  }

  try {
    await startSmitheryAuthorization(interaction, serverId);
  } catch (error) {
    botLogger.error({ error, serverId }, "Failed to start Smithery OAuth");
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Authorization Failed")
          .setDescription(
            `Failed to start OAuth flow: ${error instanceof Error ? error.message : "Unknown error"}`,
          )
          .setColor(0xff0000),
      ],
      components: [],
    });
  }
}

export async function handleSmitheryUnlinkSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (interaction.customId !== "smithery_unlink_server") return;

  await interaction.deferUpdate();

  const selectedValue = interaction.values[0];
  const serverId = selectedValue ? parseSmitheryServerId(selectedValue) : null;
  if (!serverId) {
    await interaction.editReply({
      embeds: [buildInvalidSmitheryServerEmbed(selectedValue ?? "unknown")],
      components: [],
    });
    return;
  }

  try {
    await unlinkSmitheryServer(interaction, serverId);
  } catch (error) {
    const serverInfo = SMITHERY_SERVERS[serverId];
    botLogger.error(
      { error, serverId, user: interaction.user.username },
      "Failed to unlink Smithery service",
    );
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Unlink Failed")
          .setDescription(
            `Failed to unlink ${serverInfo.name}: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          )
          .setColor(0xff0000),
      ],
      components: [],
    });
  }
}

/**
 * Handle the "Enter Code" button - show modal.
 */
export async function handleSmitheryCodeButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (interaction.customId !== "smithery_enter_code") return;

  const modal = new ModalBuilder({
    custom_id: "smithery_code_modal",
    title: "Enter Authorization Code",
    components: [
      new ActionRowBuilder<TextInputBuilder>({
        components: [
          new TextInputBuilder({
            custom_id: "auth_code",
            label: "Authorization Code",
            placeholder: "Paste the code from the redirect URL here...",
            style: TextInputStyle.Short,
            required: true,
            min_length: 10,
            max_length: 500,
          }),
        ],
      }),
    ],
  });

  await interaction.showModal(modal);
}

/**
 * Handle the modal submission with the auth code.
 */
export async function handleSmitheryModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (interaction.customId !== "smithery_code_modal") return;

  await interaction.deferUpdate();

  const userId = interaction.user.id;
  const authCode = interaction.fields.getTextInputValue("auth_code").trim();
  const pendingFlow = pendingSmitheryFlows.get(userId);

  if (!pendingFlow) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Session Expired")
          .setDescription(
            "Your authorization session has expired. Please run `/smithery` again.",
          )
          .setColor(0xff0000),
      ],
      components: [],
    });
    return;
  }

  try {
    const result = await auth(pendingFlow.provider, {
      serverUrl: pendingFlow.serverUrl,
      authorizationCode: authCode,
    });

    if (result !== "AUTHORIZED") {
      throw new Error("Authorization failed - unexpected result");
    }

    await showSuccess(interaction, pendingFlow.provider, pendingFlow.serverId);
    pendingSmitheryFlows.delete(userId);
  } catch (error) {
    botLogger.error(
      { error, serverId: pendingFlow.serverId, user: interaction.user.username },
      "Failed to exchange Smithery auth code",
    );
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Code Exchange Failed")
          .setDescription(
            `Failed to exchange authorization code: ${error instanceof Error ? error.message : "Unknown error"}\n\n` +
              "Make sure you copied the entire code from the URL.",
          )
          .setColor(0xff0000),
      ],
      components: [],
    });
  }
}

async function startSmitheryAuthorization(
  interaction: StringSelectMenuInteraction,
  serverId: SmitheryServerId,
): Promise<void> {
  const serverInfo = SMITHERY_SERVERS[serverId];
  const { linkedServerIds, unlinkedServerIds } = await getSmitheryLinkState();

  if (linkedServerIds.includes(serverId)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${serverInfo.emoji} ${serverInfo.name} Already Linked`)
          .setDescription(
            `**${serverInfo.name}** is already linked, so it is no longer available to authorize.`,
          )
          .setColor(0x5865f2),
        buildSmitheryManagerEmbed(linkedServerIds, unlinkedServerIds),
      ],
      components: buildSmitheryManagerRows(linkedServerIds, unlinkedServerIds),
    });
    return;
  }

  const provider = new SmitheryOAuthProvider();
  const serverUrl = `https://server.smithery.ai/${serverId}`;
  const result = await auth(provider, { serverUrl });

  if (result === "AUTHORIZED") {
    await showSuccess(interaction, provider, serverId);
    return;
  }

  if (result !== "REDIRECT" || !provider.capturedAuthUrl) {
    throw new Error("Authorization failed - unexpected result");
  }

  pendingSmitheryFlows.set(interaction.user.id, {
    provider,
    serverUrl,
    serverId,
    authUrl: provider.capturedAuthUrl,
  });

  const authUrl = provider.capturedAuthUrl.toString();
  const row = new ActionRowBuilder<ButtonBuilder>();
  addAuthorizationButtons(row, authUrl);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${serverInfo.emoji} Authorize ${serverInfo.name}`)
        .setDescription(buildAuthorizationDescription(authUrl))
        .setColor(0xffa500)
        .setFooter({
          text: "The authorization code is in the URL after 'code='",
        }),
    ],
    components: [row],
  });
}

async function unlinkSmitheryServer(
  interaction: StringSelectMenuInteraction,
  serverId: SmitheryServerId,
): Promise<void> {
  const serverInfo = SMITHERY_SERVERS[serverId];

  await clearSmitheryTokens(serverId);
  SmitheryMCPServer.clearCachedToken(serverId);
  await mcpConnectionManager.initialize();

  const pendingFlow = pendingSmitheryFlows.get(interaction.user.id);
  if (pendingFlow?.serverId === serverId) {
    pendingSmitheryFlows.delete(interaction.user.id);
  }

  botLogger.info(
    { serverId, user: interaction.user.username },
    "Smithery service unlinked",
  );

  const { linkedServerIds, unlinkedServerIds } = await getSmitheryLinkState();

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${serverInfo.emoji} ${serverInfo.name} Unlinked`)
        .setDescription(
          `Ruyi's saved token for **${serverInfo.name}** has been removed.\n\n` +
            "You can authorize it again from the menu below.",
        )
        .setColor(0x00aa88),
      buildSmitheryManagerEmbed(linkedServerIds, unlinkedServerIds),
    ],
    components: buildSmitheryManagerRows(linkedServerIds, unlinkedServerIds),
  });
}

async function showSuccess(
  interaction: ModalSubmitInteraction | StringSelectMenuInteraction,
  provider: SmitheryOAuthProvider,
  serverId: SmitheryServerId,
): Promise<void> {
  const accessToken = provider.getAccessToken();
  const refreshToken = provider.getRefreshToken();
  const expiresIn = provider.getExpiresIn();
  const serverInfo = SMITHERY_SERVERS[serverId];

  if (!accessToken) {
    throw new Error("No access token received");
  }

  const savedTokens = await saveSmitheryTokens(serverId, {
    accessToken,
    refreshToken,
    expiresIn,
  });
  SmitheryMCPServer.setCachedToken(serverId, savedTokens);
  await mcpConnectionManager.initialize();

  botLogger.info({ serverId }, "Smithery tokens saved to database");

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${serverInfo.emoji} ${serverInfo.name} Authorized!`)
        .setDescription(
          `You've successfully authorized **${serverInfo.name}**!\n\n` +
            "Tokens have been saved and will be used automatically.\n" +
            (refreshToken
              ? "🔄 Tokens will refresh automatically when they expire."
              : "⚠️ No refresh token received - you may need to re-authorize later."),
        )
        .setColor(0x00ff00)
        .setFooter({
          text: "Run /smithery again to authorize other servers",
        }),
    ],
    components: [],
  });
}
