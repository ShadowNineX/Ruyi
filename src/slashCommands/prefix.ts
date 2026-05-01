import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { configManager } from "../config";
import { botLogger } from "../logger";

export const prefixCommand = new SlashCommandBuilder()
  .setName("prefix")
  .setDescription("View or change the bot command prefix")
  .addStringOption((option) =>
    option
      .setName("new_prefix")
      .setDescription("The new prefix to use (leave empty to view current)")
      .setRequired(false)
      .setMaxLength(5),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function handlePrefixCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const newPrefix = interaction.options.getString("new_prefix");

  if (!newPrefix) {
    await interaction.reply({
      content: `Current prefix: \`${configManager.getPrefix()}\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const oldPrefix = configManager.getPrefix();
  configManager.setPrefix(newPrefix);

  botLogger.info(
    { oldPrefix, newPrefix, user: interaction.user.username },
    "Prefix changed",
  );
  await interaction.reply({
    content: `Prefix changed from \`${oldPrefix}\` to \`${newPrefix}\``,
    flags: MessageFlags.Ephemeral,
  });
}
