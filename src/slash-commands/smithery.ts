import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  clearSmitheryConnection,
  getSmitheryConnection,
  type SmitheryServerId,
} from "../db/models";
import { botLogger } from "../logger";
import {
  createOrUpdateSmitheryConnection,
  deleteSmitheryConnection,
  isSmitheryConfigured,
  refreshSmitheryConnection,
  type SmitheryConnectionSnapshot,
} from "../mcp/smithery-api";
import {
  parseSmitheryServerId,
  SMITHERY_SERVERS,
} from "./smithery/constants";
import { getSmitheryLinkState } from "./smithery/state";
import {
  addAuthorizationButtons,
  buildAuthorizationDescription,
  buildInvalidSmitheryServerEmbed,
  buildSmitheryManagerEmbed,
  buildSmitheryManagerRows,
} from "./smithery/ui";

export const smitheryCommand = new SlashCommandBuilder()
  .setName("smithery")
  .setDescription("Authorize Smithery MCP servers (YouTube)");

export async function handleSmitheryCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  botLogger.debug(
    { user: interaction.user.username },
    "Smithery authorize command",
  );

  if (!isSmitheryConfigured()) {
    await interaction.reply({
      embeds: [buildSmitheryConfigMissingEmbed()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const linkState = await getSmitheryLinkState();

  await interaction.reply({
    embeds: [
      buildSmitheryManagerEmbed(
        linkState.linkedServerIds,
        linkState.needsSetupServerIds,
        linkState.unlinkedServerIds,
      ),
    ],
    components: buildSmitheryManagerRows(
      linkState.linkedServerIds,
      linkState.needsSetupServerIds,
      linkState.unlinkedServerIds,
    ),
    flags: MessageFlags.Ephemeral,
  });
}

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
    await startSmitherySetup(interaction, serverId);
  } catch (error) {
    botLogger.error({ error, serverId }, "Failed to start Smithery setup");
    await interaction.editReply({
      embeds: [buildSmitheryErrorEmbed("Setup Failed", error)],
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
        buildSmitheryErrorEmbed(`Unlink ${serverInfo.name} Failed`, error),
      ],
      components: [],
    });
  }
}

export async function handleSmitheryCheckButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const serverId = parseSmitheryCheckCustomId(interaction.customId);
  if (!serverId) return;

  await interaction.deferUpdate();

  try {
    const snapshot = await refreshSmitheryConnection(serverId);
    await showConnectionState(interaction, serverId, snapshot);
  } catch (error) {
    botLogger.error(
      { error, serverId, user: interaction.user.username },
      "Failed to refresh Smithery connection",
    );
    await interaction.editReply({
      embeds: [buildSmitheryErrorEmbed("Status Check Failed", error)],
      components: buildSetupRetryComponents(serverId),
    });
  }
}

async function startSmitherySetup(
  interaction: StringSelectMenuInteraction,
  serverId: SmitheryServerId,
): Promise<void> {
  const serverInfo = SMITHERY_SERVERS[serverId];
  const linkState = await getSmitheryLinkState();

  if (linkState.linkedServerIds.includes(serverId)) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${serverInfo.emoji} ${serverInfo.name} Already Linked`)
          .setDescription(
            `**${serverInfo.name}** is already linked, so it is hidden from the setup menu.`,
          )
          .setColor(0x5865f2),
        buildSmitheryManagerEmbed(
          linkState.linkedServerIds,
          linkState.needsSetupServerIds,
          linkState.unlinkedServerIds,
        ),
      ],
      components: buildSmitheryManagerRows(
        linkState.linkedServerIds,
        linkState.needsSetupServerIds,
        linkState.unlinkedServerIds,
      ),
    });
    return;
  }

  const snapshot = await createOrUpdateSmitheryConnection(serverId);
  botLogger.info(
    { serverId, status: snapshot.status },
    "Smithery connection created or updated",
  );
  await showConnectionState(interaction, serverId, snapshot);
}

async function unlinkSmitheryServer(
  interaction: StringSelectMenuInteraction,
  serverId: SmitheryServerId,
): Promise<void> {
  const serverInfo = SMITHERY_SERVERS[serverId];
  const localConnection = await getSmitheryConnection(serverId);

  if (isSmitheryConfigured() && localConnection) {
    await deleteSmitheryConnection(serverId);
  }

  await clearSmitheryConnection(serverId);

  botLogger.info(
    { serverId, user: interaction.user.username },
    "Smithery service unlinked",
  );

  const linkState = await getSmitheryLinkState();

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${serverInfo.emoji} ${serverInfo.name} Unlinked`)
        .setDescription(
          `Ruyi's saved Smithery connection for **${serverInfo.name}** has been removed.\n\n` +
            "You can set it up again from the menu below.",
        )
        .setColor(0x00aa88),
      buildSmitheryManagerEmbed(
        linkState.linkedServerIds,
        linkState.needsSetupServerIds,
        linkState.unlinkedServerIds,
      ),
    ],
    components: buildSmitheryManagerRows(
      linkState.linkedServerIds,
      linkState.needsSetupServerIds,
      linkState.unlinkedServerIds,
    ),
  });
}

async function showConnectionState(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  serverId: SmitheryServerId,
  snapshot: SmitheryConnectionSnapshot,
): Promise<void> {
  const serverInfo = SMITHERY_SERVERS[serverId];

  if (snapshot.status === "connected") {
    const linkState = await getSmitheryLinkState();
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${serverInfo.emoji} ${serverInfo.name} Connected`)
          .setDescription(
            `**${serverInfo.name}** is connected through Smithery.\n\n` +
              "Smithery now owns the downstream authorization for this service.",
          )
          .setColor(0x00ff00),
        buildSmitheryManagerEmbed(
          linkState.linkedServerIds,
          linkState.needsSetupServerIds,
          linkState.unlinkedServerIds,
        ),
      ],
      components: buildSmitheryManagerRows(
        linkState.linkedServerIds,
        linkState.needsSetupServerIds,
        linkState.unlinkedServerIds,
      ),
    });
    return;
  }

  const title =
    snapshot.status === "auth_required" || snapshot.status === "input_required"
      ? `${serverInfo.emoji} Finish ${serverInfo.name} Setup`
      : `${serverInfo.emoji} ${serverInfo.name} Needs Attention`;
  const description =
    snapshot.setupUrl !== undefined
      ? buildAuthorizationDescription(snapshot.setupUrl)
      : `Smithery returned status **${snapshot.status}**, but did not include a setup URL.`;

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(title)
        .setDescription(
          `${description}\n\n` +
            `Current status: **${snapshot.status}**` +
            (snapshot.errorMessage ? `\n${snapshot.errorMessage}` : ""),
        )
        .setColor(snapshot.status === "error" ? 0xff0000 : 0xffa500),
    ],
    components: snapshot.setupUrl
      ? buildSetupComponents(snapshot.setupUrl, serverId)
      : buildSetupRetryComponents(serverId),
  });
}

function buildSetupComponents(
  setupUrl: string,
  serverId: SmitheryServerId,
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  addAuthorizationButtons(row, setupUrl, serverId);
  return [row];
}

function buildSetupRetryComponents(
  serverId: SmitheryServerId,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`smithery_check:${serverId}`)
        .setLabel("Check Status")
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

function parseSmitheryCheckCustomId(customId: string): SmitheryServerId | null {
  if (!customId.startsWith("smithery_check:")) return null;
  return parseSmitheryServerId(customId.slice("smithery_check:".length));
}

function buildSmitheryConfigMissingEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Smithery Connect Not Configured")
    .setDescription(
      "Set `SMITHERY_API_KEY` and `SMITHERY_NAMESPACE` in the bot environment, then restart Ruyi.\n\n" +
        "After that, `/smithery` can create hosted setup links instead of asking you to paste authorization codes.",
    )
    .setColor(0xffa500);
}

function buildSmitheryErrorEmbed(title: string, error: unknown): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(error instanceof Error ? error.message : "Unknown error")
    .setColor(0xff0000);
}
