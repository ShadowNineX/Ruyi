import type { ChatInputCommandInteraction } from 'discord.js';
import type { ConfigScope } from '../../config';
import {

  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  configManager,

  formatConfigScope,
  userConfigScope,
} from '../../config';
import { botLogger } from '../../logger';

export const prefixCommand = new SlashCommandBuilder()
  .setName('prefix')
  .setDescription('View or change the bot command prefix')
  .addStringOption(option =>
    option
      .setName('new_prefix')
      .setDescription('The new prefix to use (leave empty to view current)')
      .setRequired(false)
      .setMaxLength(5),
  );

function canManageScope(
  interaction: ChatInputCommandInteraction,
  scope: ConfigScope,
): boolean {
  return (
    scope.kind === 'discord:dm'
    || (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      ?? false)
  );
}

export async function handlePrefixCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const scope = userConfigScope(interaction.guildId, interaction.user.id);
  if (!canManageScope(interaction, scope)) {
    await interaction.reply({
      content: 'You need **Manage Server** to change this server\'s prefix.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const newPrefix = interaction.options.getString('new_prefix');

  if (!newPrefix) {
    await interaction.reply({
      content: `Current prefix for ${formatConfigScope(scope)}: \`${configManager.getPrefix(scope)}\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const oldPrefix = configManager.getPrefix(scope);
  await configManager.setPrefix(scope, newPrefix);

  botLogger.info(
    {
      scope: scope.kind,
      scopeId: scope.id,
      oldPrefix,
      newPrefix,
      user: interaction.user.username,
    },
    'Prefix changed',
  );
  await interaction.reply({
    content: `Prefix for ${formatConfigScope(scope)} changed from \`${oldPrefix}\` to \`${newPrefix}\``,
    flags: MessageFlags.Ephemeral,
  });
}
