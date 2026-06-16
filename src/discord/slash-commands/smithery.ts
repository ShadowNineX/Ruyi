import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { formatConfigScope, userConfigScope } from "../../config";
import {
  clearSmitheryConnection,
  getSmitheryConnection,
  isSmitheryConnectionScope,
  type SmitheryConnectionScope,
  type SmitheryServerId,
} from "../../db/models";
import { botLogger } from "../../logger";
import {
  createOrUpdateSmitheryConnection,
  deleteSmitheryConnection,
  isSmitheryConfigured,
  refreshSmitheryConnection,
  type SmitheryConnectionSnapshot,
} from "../../mcp/smithery-api";
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

type SmitheryInteraction =
  | ChatInputCommandInteraction
  | StringSelectMenuInteraction
  | ButtonInteraction;

type SmitheryComponentInteraction =
  | StringSelectMenuInteraction
  | ButtonInteraction;

interface AuthorizedSmitherySelection {
  scope: SmitheryConnectionScope;
  serverId: SmitheryServerId;
}

function getInteractionScope(
  interaction: SmitheryInteraction,
): SmitheryConnectionScope {
  const scope = userConfigScope(interaction.guildId, interaction.user.id);
  if (isSmitheryConnectionScope(scope)) return scope;
  throw new Error("Smithery is only available in Discord scopes.");
}

function canManageScope(
  interaction: SmitheryInteraction,
  scope: SmitheryConnectionScope,
): boolean {
  return (
    scope.kind === "discord:dm" ||
    (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ??
      false)
  );
}

async function rejectUnauthorizedSmitheryScope(
  interaction: SmitheryInteraction,
  scope: SmitheryConnectionScope,
): Promise<boolean> {
  if (canManageScope(interaction, scope)) return false;

  const content =
    "You need **Manage Server** to change this server's Smithery links.";

  if (interaction.isChatInputCommand()) {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } else if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, components: [] });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  return true;
}

async function resolveAuthorizedSmitherySelection(
  interaction: StringSelectMenuInteraction,
  expectedCustomId: string,
): Promise<AuthorizedSmitherySelection | null> {
  if (interaction.customId !== expectedCustomId) return null;

  await interaction.deferUpdate();
  const scope = getInteractionScope(interaction);
  if (await rejectUnauthorizedSmitheryScope(interaction, scope)) return null;

  const selectedValue = interaction.values[0];
  const serverId = selectedValue ? parseSmitheryServerId(selectedValue) : null;
  if (!serverId) {
    await interaction.editReply({
      embeds: [buildInvalidSmitheryServerEmbed(selectedValue ?? "unknown")],
      components: [],
    });
    return null;
  }

  return { scope, serverId };
}

async function editSmitheryErrorReply(
  interaction: SmitheryComponentInteraction,
  title: string,
  error: unknown,
  components: ActionRowBuilder<ButtonBuilder>[] = [],
): Promise<void> {
  await interaction.editReply({
    embeds: [buildSmitheryErrorEmbed(title, error)],
    components,
  });
}

async function editSmitheryManagerReply(
  interaction: SmitheryComponentInteraction,
  scope: SmitheryConnectionScope,
  leadingEmbed: EmbedBuilder,
): Promise<void> {
  const linkState = await getSmitheryLinkState(scope);
  await interaction.editReply({
    embeds: [
      leadingEmbed,
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

export async function handleSmitheryCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const scope = getInteractionScope(interaction);
  botLogger.debug(
    { user: interaction.user.username, scope: scope.kind, scopeId: scope.id },
    "Smithery authorize command",
  );

  if (await rejectUnauthorizedSmitheryScope(interaction, scope)) return;

  if (!isSmitheryConfigured()) {
    await interaction.reply({
      embeds: [buildSmitheryConfigMissingEmbed()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const linkState = await getSmitheryLinkState(scope);

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
  const selection = await resolveAuthorizedSmitherySelection(
    interaction,
    "smithery_select_server",
  );
  if (!selection) return;
  const { scope, serverId } = selection;

  try {
    await startSmitherySetup(interaction, scope, serverId);
  } catch (error) {
    botLogger.error({ error, serverId }, "Failed to start Smithery setup");
    await editSmitheryErrorReply(interaction, "Setup Failed", error);
  }
}

export async function handleSmitheryUnlinkSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const selection = await resolveAuthorizedSmitherySelection(
    interaction,
    "smithery_unlink_server",
  );
  if (!selection) return;
  const { scope, serverId } = selection;

  try {
    await unlinkSmitheryServer(interaction, scope, serverId);
  } catch (error) {
    const serverInfo = SMITHERY_SERVERS[serverId];
    botLogger.error(
      { error, serverId, user: interaction.user.username },
      "Failed to unlink Smithery service",
    );
    await editSmitheryErrorReply(
      interaction,
      `Unlink ${serverInfo.name} Failed`,
      error,
    );
  }
}

export async function handleSmitheryCheckButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const serverId = parseSmitheryCheckCustomId(interaction.customId);
  if (!serverId) return;

  await interaction.deferUpdate();
  const scope = getInteractionScope(interaction);
  if (await rejectUnauthorizedSmitheryScope(interaction, scope)) return;

  try {
    const snapshot = await refreshSmitheryConnection(scope, serverId);
    await showConnectionState(interaction, scope, serverId, snapshot);
  } catch (error) {
    botLogger.error(
      { error, serverId, user: interaction.user.username },
      "Failed to refresh Smithery connection",
    );
    await editSmitheryErrorReply(
      interaction,
      "Status Check Failed",
      error,
      buildSetupRetryComponents(serverId),
    );
  }
}

async function startSmitherySetup(
  interaction: StringSelectMenuInteraction,
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
): Promise<void> {
  const serverInfo = SMITHERY_SERVERS[serverId];
  const linkState = await getSmitheryLinkState(scope);

  if (linkState.linkedServerIds.includes(serverId)) {
    await editSmitheryManagerReply(
      interaction,
      scope,
      new EmbedBuilder()
        .setTitle(`${serverInfo.emoji} ${serverInfo.name} Already Linked`)
        .setDescription(
          `**${serverInfo.name}** is already linked, so it is hidden from the setup menu.`,
        )
        .setColor(0x5865f2),
    );
    return;
  }

  const snapshot = await createOrUpdateSmitheryConnection(scope, serverId);
  botLogger.info(
    {
      scope: scope.kind,
      scopeId: scope.id,
      serverId,
      status: snapshot.status,
    },
    "Smithery connection created or updated",
  );
  await showConnectionState(interaction, scope, serverId, snapshot);
}

async function unlinkSmitheryServer(
  interaction: StringSelectMenuInteraction,
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
): Promise<void> {
  const serverInfo = SMITHERY_SERVERS[serverId];
  const localConnection = await getSmitheryConnection(scope, serverId);

  if (isSmitheryConfigured() && localConnection) {
    await deleteSmitheryConnection(scope, serverId);
  }

  await clearSmitheryConnection(scope, serverId);

  botLogger.info(
    { scope: scope.kind, scopeId: scope.id, serverId, user: interaction.user.username },
    "Smithery service unlinked",
  );

  await editSmitheryManagerReply(
    interaction,
    scope,
    new EmbedBuilder()
      .setTitle(`${serverInfo.emoji} ${serverInfo.name} Unlinked`)
      .setDescription(
        `Ruyi's saved Smithery connection for **${serverInfo.name}** has been removed.\n\n` +
          "You can set it up again from the menu below.",
      )
      .setColor(0x00aa88),
  );
}

async function showConnectionState(
  interaction: SmitheryComponentInteraction,
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
  snapshot: SmitheryConnectionSnapshot,
): Promise<void> {
  const serverInfo = SMITHERY_SERVERS[serverId];

  if (snapshot.status === "connected") {
    await editSmitheryManagerReply(
      interaction,
      scope,
      new EmbedBuilder()
        .setTitle(`${serverInfo.emoji} ${serverInfo.name} Connected`)
        .setDescription(
          `**${serverInfo.name}** is connected through Smithery for ${formatConfigScope(scope)}.\n\n` +
            "Smithery now owns the downstream authorization for this service.",
        )
        .setColor(0x00ff00),
    );
    return;
  }

  const title =
    snapshot.status === "auth_required" || snapshot.status === "input_required"
      ? `${serverInfo.emoji} Finish ${serverInfo.name} Setup`
      : `${serverInfo.emoji} ${serverInfo.name} Needs Attention`;
  const setupUrl = snapshot.setupUrl;

  if (setupUrl) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(title)
          .setDescription(
            `${buildAuthorizationDescription(setupUrl)}\n\n` +
              `Current status: **${snapshot.status}**` +
              (snapshot.errorMessage ? `\n${snapshot.errorMessage}` : ""),
          )
          .setColor(snapshot.status === "error" ? 0xff0000 : 0xffa500),
      ],
      components: buildSetupComponents(setupUrl, serverId),
    });
    return;
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(title)
        .setDescription(
          `Smithery returned status **${snapshot.status}**, but did not include a setup URL.\n\n` +
            `Current status: **${snapshot.status}**` +
            (snapshot.errorMessage ? `\n${snapshot.errorMessage}` : ""),
        )
        .setColor(snapshot.status === "error" ? 0xff0000 : 0xffa500),
    ],
    components: buildSetupRetryComponents(serverId),
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
