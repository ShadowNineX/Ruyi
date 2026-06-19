import type { ChatInputCommandInteraction, StringSelectMenuInteraction } from 'discord.js';
import type { AiModelPreset, AiModelPresetId, ConfigScope } from '../../config';
import {
  ActionRowBuilder,

  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,

  StringSelectMenuOptionBuilder,
} from 'discord.js';
import {
  AI_MODEL_PRESETS,

  configManager,

  formatConfigScope,
  isAiModelPresetId,
  userConfigScope,
} from '../../config';
import { botLogger } from '../../logger';

const MODEL_SELECT_ID = 'model_preset_select';

export const modelCommand = new SlashCommandBuilder()
  .setName('model')
  .setDescription('Choose Ruyi\'s intelligence level');

function canManageScope(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  scope: ConfigScope,
): boolean {
  return (
    scope.kind === 'discord:dm'
    || (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      ?? false)
  );
}

function buildModelOption(
  preset: AiModelPreset,
  currentPreset: AiModelPresetId,
): StringSelectMenuOptionBuilder {
  return new StringSelectMenuOptionBuilder()
    .setLabel(preset.label)
    .setDescription(preset.description)
    .setValue(preset.id)
    .setDefault(preset.id === currentPreset);
}

function buildModelRow(
  scope: ConfigScope,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const currentPreset = configManager.getModelPreset(scope);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(MODEL_SELECT_ID)
      .setPlaceholder('Choose Ruyi\'s intelligence')
      .addOptions(
        AI_MODEL_PRESETS.map(preset =>
          buildModelOption(preset, currentPreset),
        ),
      ),
  );
}

function formatPreset(preset: AiModelPreset): string {
  return [
    `**${preset.label}**`,
    `Model: \`${preset.model}\``,
    `Reasoning: \`${preset.reasoningEffort}\``,
    `Verbosity: \`${preset.textVerbosity}\``,
  ].join('\n');
}

function currentPreset(scope: ConfigScope): AiModelPreset {
  return configManager.getModelConfig(scope);
}

export async function handleModelCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const scope = userConfigScope(interaction.guildId, interaction.user.id);
  if (!canManageScope(interaction, scope)) {
    await interaction.reply({
      content:
        'You need **Manage Server** to change this server\'s intelligence level.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `Current intelligence for ${formatConfigScope(scope)}:\n${formatPreset(
      currentPreset(scope),
    )}`,
    components: [buildModelRow(scope)],
    flags: MessageFlags.Ephemeral,
  });
}

async function applySelectedPreset(
  interaction: StringSelectMenuInteraction,
  selectedPreset: AiModelPresetId,
): Promise<void> {
  const scope = userConfigScope(interaction.guildId, interaction.user.id);
  if (!canManageScope(interaction, scope)) {
    await interaction.editReply({
      content:
        'You need **Manage Server** to change this server\'s intelligence level.',
      components: [],
    });
    return;
  }

  const oldPreset = configManager.getModelConfig(scope);

  if (oldPreset.id === selectedPreset) {
    await interaction.editReply({
      content: `Ruyi is already using:\n${formatPreset(oldPreset)}`,
      components: [buildModelRow(scope)],
    });
    return;
  }

  await configManager.setModelPreset(scope, selectedPreset);
  const newPreset = configManager.getModelConfig(scope);

  botLogger.info(
    {
      scope: scope.kind,
      scopeId: scope.id,
      oldPreset: oldPreset.id,
      oldModel: oldPreset.model,
      newPreset: newPreset.id,
      newModel: newPreset.model,
      user: interaction.user.username,
    },
    'AI intelligence level changed',
  );

  await interaction.editReply({
    content: [
      `Intelligence changed from **${oldPreset.label}** to **${newPreset.label}** for ${formatConfigScope(scope)}.`,
      '',
      formatPreset(newPreset),
      '',
      `The next reply in ${formatConfigScope(scope)} will use this intelligence level.`,
    ].join('\n'),
    components: [buildModelRow(scope)],
  });
}

export async function handleModelSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (interaction.customId !== MODEL_SELECT_ID) { return; }

  const selectedValue = interaction.values[0];
  if (!selectedValue || !isAiModelPresetId(selectedValue)) {
    await interaction.update({
      content: 'Invalid intelligence level selected.',
      components: [],
    });
    return;
  }

  try {
    await interaction.deferUpdate();
    await applySelectedPreset(interaction, selectedValue);
  } catch (error) {
    const err = error as Error;
    botLogger.error(
      {
        error: err.message,
        stack: err.stack,
        name: err.name,
        user: interaction.user.username,
        selectedValue,
        guildId: interaction.guildId,
      },
      'Failed to change AI intelligence level',
    );

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content:
          'Forgive me, my lord - I could not change the intelligence level.',
        components: [
          buildModelRow(userConfigScope(interaction.guildId, interaction.user.id)),
        ],
      });
      return;
    }

    await interaction.update({
      content: 'Forgive me, my lord - I could not change the intelligence level.',
      components: [],
    });
  }
}

export function isModelSelect(customId: string): boolean {
  return customId === MODEL_SELECT_ID;
}
