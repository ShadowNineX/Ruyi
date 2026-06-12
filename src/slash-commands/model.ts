import {
  ActionRowBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  AI_MODEL_PRESETS,
  configManager,
  isAiModelPresetId,
  type AiModelPreset,
  type AiModelPresetId,
} from "../config";
import { agentsRuntimeManager, sessionManager } from "../ai";
import { botLogger } from "../logger";

const MODEL_SELECT_ID = "model_preset_select";

export const modelCommand = new SlashCommandBuilder()
  .setName("model")
  .setDescription("Choose Ruyi's intelligence level")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

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

function buildModelRow(): ActionRowBuilder<StringSelectMenuBuilder> {
  const currentPreset = configManager.getModelPreset();
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(MODEL_SELECT_ID)
      .setPlaceholder("Choose Ruyi's intelligence")
      .addOptions(
        AI_MODEL_PRESETS.map((preset) =>
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
  ].join("\n");
}

function currentPreset(): AiModelPreset {
  return configManager.getModelConfig();
}

export async function handleModelCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    content: `Current intelligence:\n${formatPreset(currentPreset())}`,
    components: [buildModelRow()],
    flags: MessageFlags.Ephemeral,
  });
}

async function applySelectedPreset(
  interaction: StringSelectMenuInteraction,
  selectedPreset: AiModelPresetId,
): Promise<void> {
  const oldPreset = configManager.getModelConfig();

  if (oldPreset.id === selectedPreset) {
    await interaction.editReply({
      content: `Ruyi is already using:\n${formatPreset(oldPreset)}`,
      components: [buildModelRow()],
    });
    return;
  }

  await configManager.setModelPreset(selectedPreset);
  const newPreset = configManager.getModelConfig();
  await sessionManager.invalidateAll("model_preset_changed");
  await agentsRuntimeManager.stop();

  botLogger.info(
    {
      oldPreset: oldPreset.id,
      oldModel: oldPreset.model,
      newPreset: newPreset.id,
      newModel: newPreset.model,
      user: interaction.user.username,
    },
    "AI intelligence level changed",
  );

  await interaction.editReply({
    content: [
      `Intelligence changed from **${oldPreset.label}** to **${newPreset.label}**.`,
      "",
      formatPreset(newPreset),
      "",
      "Active chat sessions were refreshed so the next reply uses this intelligence level.",
    ].join("\n"),
    components: [buildModelRow()],
  });
}

export async function handleModelSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (interaction.customId !== MODEL_SELECT_ID) return;

  const selectedValue = interaction.values[0];
  if (!selectedValue || !isAiModelPresetId(selectedValue)) {
    await interaction.update({
      content: "Invalid intelligence level selected.",
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
      },
      "Failed to change AI intelligence level",
    );

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content:
          "Forgive me, my lord - I could not change the intelligence level.",
        components: [buildModelRow()],
      });
      return;
    }

    await interaction.update({
      content: "Forgive me, my lord - I could not change the intelligence level.",
      components: [],
    });
  }
}

export function isModelSelect(customId: string): boolean {
  return customId === MODEL_SELECT_ID;
}
