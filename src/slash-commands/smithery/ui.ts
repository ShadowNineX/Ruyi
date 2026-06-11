import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import type { SmitheryServerId } from "../../db/models";
import {
  DISCORD_BUTTON_URL_MAX_LENGTH,
  DISCORD_EMBED_DESCRIPTION_MAX_LENGTH,
  SMITHERY_SERVERS,
} from "./constants";

export function buildSmitheryManagerEmbed(
  linkedServerIds: SmitheryServerId[],
  unlinkedServerIds: SmitheryServerId[],
): EmbedBuilder {
  const linkedText =
    linkedServerIds.length > 0
      ? linkedServerIds.map(formatServerName).join("\n")
      : "No services linked yet.";
  const unlinkedText =
    unlinkedServerIds.length > 0
      ? unlinkedServerIds.map(formatServerName).join("\n")
      : "All supported services are already linked.";

  const embed = new EmbedBuilder()
    .setTitle("🔐 Smithery Connections")
    .setDescription(
      "**Linked services:**\n" +
        `${linkedText}\n\n` +
        "**Available to link:**\n" +
        `${unlinkedText}\n\n` +
        "Authorize a service to let Ruyi use its MCP tools. Unlinking removes Ruyi's saved token for that service.",
    )
    .setColor(0x5865f2);

  if (unlinkedServerIds.length > 0) {
    embed.setFooter({
      text: "Linked services are hidden from the authorize menu",
    });
  }

  return embed;
}

export function buildSmitheryManagerRows(
  linkedServerIds: SmitheryServerId[],
  unlinkedServerIds: SmitheryServerId[],
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  if (unlinkedServerIds.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("smithery_select_server")
          .setPlaceholder("Choose a service to authorize...")
          .addOptions(unlinkedServerIds.map(buildServerOption)),
      ),
    );
  }

  if (linkedServerIds.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("smithery_unlink_server")
          .setPlaceholder("Choose a service to unlink...")
          .addOptions(linkedServerIds.map(buildUnlinkServerOption)),
      ),
    );
  }

  return rows;
}

export function buildAuthorizationDescription(authUrl: string): string {
  const description =
    `**Step 1:** Open [Smithery authorization](${authUrl})\n` +
    "**Step 2:** After authorizing, you'll be redirected to a page with a code\n" +
    "**Step 3:** Click Enter Authorization Code and paste the code";

  if (description.length <= DISCORD_EMBED_DESCRIPTION_MAX_LENGTH) {
    return description;
  }

  return (
    "**Step 1:** Copy the Smithery authorization URL from the bot logs\n" +
    "**Step 2:** After authorizing, you'll be redirected to a page with a code\n" +
    "**Step 3:** Click Enter Authorization Code and paste the code"
  );
}

export function addAuthorizationButtons(
  row: ActionRowBuilder<ButtonBuilder>,
  authUrl: string,
): void {
  if (authUrl.length <= DISCORD_BUTTON_URL_MAX_LENGTH) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel("Open Smithery")
        .setStyle(ButtonStyle.Link)
        .setURL(authUrl),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId("smithery_enter_code")
      .setLabel("Enter Authorization Code")
      .setStyle(ButtonStyle.Success),
  );
}

export function buildInvalidSmitheryServerEmbed(serverId: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("❌ Invalid Server")
    .setDescription(`Unknown server: ${serverId}`)
    .setColor(0xff0000);
}

function buildServerOption(
  serverId: SmitheryServerId,
): StringSelectMenuOptionBuilder {
  const serverInfo = SMITHERY_SERVERS[serverId];
  return new StringSelectMenuOptionBuilder()
    .setLabel(serverInfo.name)
    .setDescription(serverInfo.description)
    .setValue(serverId)
    .setEmoji(serverInfo.emoji);
}

function buildUnlinkServerOption(
  serverId: SmitheryServerId,
): StringSelectMenuOptionBuilder {
  const serverInfo = SMITHERY_SERVERS[serverId];
  return new StringSelectMenuOptionBuilder()
    .setLabel(serverInfo.name)
    .setDescription(`Unlink ${serverInfo.name} from Ruyi`)
    .setValue(serverId)
    .setEmoji(serverInfo.emoji);
}

function formatServerName(serverId: SmitheryServerId): string {
  const serverInfo = SMITHERY_SERVERS[serverId];
  return `• ${serverInfo.emoji} **${serverInfo.name}**`;
}
