import type { SmitheryServerId } from '../../../db/models';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import {
  DISCORD_BUTTON_URL_MAX_LENGTH,
  DISCORD_EMBED_DESCRIPTION_MAX_LENGTH,
  SMITHERY_SERVERS,
} from './constants';

export function buildSmitheryManagerEmbed(
  linkedServerIds: SmitheryServerId[],
  needsSetupServerIds: SmitheryServerId[],
  unlinkedServerIds: SmitheryServerId[],
): EmbedBuilder {
  const linkedText
    = linkedServerIds.length > 0
      ? linkedServerIds.map(formatServerName).join('\n')
      : 'No services linked yet.';
  const setupText
    = needsSetupServerIds.length > 0
      ? needsSetupServerIds.map(formatServerName).join('\n')
      : 'No services are waiting for setup.';
  const unlinkedText
    = unlinkedServerIds.length > 0
      ? unlinkedServerIds.map(formatServerName).join('\n')
      : 'All supported services are already linked.';

  const embed = new EmbedBuilder()
    .setTitle('🔐 Smithery Connections')
    .setDescription(
      '**Linked services:**\n'
      + `${linkedText}\n\n`
      + '**Needs setup:**\n'
      + `${setupText}\n\n`
      + '**Available to link:**\n'
      + `${unlinkedText}\n\n`
      + 'Authorize a service to let Ruyi use its MCP tools. Unlinking removes Ruyi\'s saved Smithery connection for that service.',
    )
    .setColor(0x5865F2);

  if (unlinkedServerIds.length > 0 || needsSetupServerIds.length > 0) {
    embed.setFooter({
      text: 'Linked services are hidden from the setup menu',
    });
  }

  return embed;
}

export function buildSmitheryManagerRows(
  linkedServerIds: SmitheryServerId[],
  needsSetupServerIds: SmitheryServerId[],
  unlinkedServerIds: SmitheryServerId[],
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  const setupServerIds = [...needsSetupServerIds, ...unlinkedServerIds];
  const unlinkServerIds = [...linkedServerIds, ...needsSetupServerIds];

  if (setupServerIds.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('smithery_select_server')
          .setPlaceholder('Choose a service to set up...')
          .addOptions(setupServerIds.map(buildServerOption)),
      ),
    );
  }

  if (unlinkServerIds.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('smithery_unlink_server')
          .setPlaceholder('Choose a service to unlink...')
          .addOptions(unlinkServerIds.map(buildUnlinkServerOption)),
      ),
    );
  }

  return rows;
}

export function buildAuthorizationDescription(authUrl: string): string {
  const description
    = `**Step 1:** Open [Smithery setup](${authUrl})\n`
      + '**Step 2:** Finish the Smithery permission screen\n'
      + '**Step 3:** Come back here and click Check Status';

  if (description.length <= DISCORD_EMBED_DESCRIPTION_MAX_LENGTH) {
    return description;
  }

  return (
    '**Step 1:** Open the Smithery setup URL from the bot logs\n'
    + '**Step 2:** Finish the Smithery permission screen\n'
    + '**Step 3:** Come back here and click Check Status'
  );
}

export function addAuthorizationButtons(
  row: ActionRowBuilder<ButtonBuilder>,
  authUrl: string,
  serverId: SmitheryServerId,
): void {
  if (authUrl.length <= DISCORD_BUTTON_URL_MAX_LENGTH) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Open Smithery Setup')
        .setStyle(ButtonStyle.Link)
        .setURL(authUrl),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`smithery_check:${serverId}`)
      .setLabel('Check Status')
      .setStyle(ButtonStyle.Success),
  );
}

export function buildInvalidSmitheryServerEmbed(serverId: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('❌ Invalid Server')
    .setDescription(`Unknown server: ${serverId}`)
    .setColor(0xFF0000);
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
