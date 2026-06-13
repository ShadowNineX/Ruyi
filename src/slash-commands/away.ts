import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { configManager } from "../config";
import {
  AWAY_MESSAGE_MAX_COOLDOWN_HOURS,
  AWAY_MESSAGE_MAX_DELAY_MINUTES,
  AWAY_MESSAGE_MIN_COOLDOWN_HOURS,
  AWAY_MESSAGE_MIN_DELAY_MINUTES,
} from "../constants";
import { botLogger } from "../logger";

export const awayCommand = new SlashCommandBuilder()
  .setName("away")
  .setDescription("Configure c.ai-style away messages")
  .addSubcommand((subcommand) =>
    subcommand.setName("status").setDescription("Show away message settings"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("enable")
      .setDescription("Opt yourself into away-message pings"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("disable")
      .setDescription("Opt yourself out of away-message pings"),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("server")
      .setDescription("Manage server-wide away message settings")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("enable")
          .setDescription("Enable away messages server-wide"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("disable")
          .setDescription("Disable away messages server-wide"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("timing")
          .setDescription("Set away message delay and cooldown")
          .addIntegerOption((option) =>
            option
              .setName("delay_minutes")
              .setDescription("Quiet time before an away ping")
              .setMinValue(AWAY_MESSAGE_MIN_DELAY_MINUTES)
              .setMaxValue(AWAY_MESSAGE_MAX_DELAY_MINUTES),
          )
          .addIntegerOption((option) =>
            option
              .setName("cooldown_hours")
              .setDescription("Minimum time between away pings for a user")
              .setMinValue(AWAY_MESSAGE_MIN_COOLDOWN_HOURS)
              .setMaxValue(AWAY_MESSAGE_MAX_COOLDOWN_HOURS),
          ),
      ),
  );

function hasManageGuild(interaction: ChatInputCommandInteraction): boolean {
  return (
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false
  );
}

async function formatStatus(userId: string): Promise<string> {
  const settings = configManager.getAwaySettings();
  const userEnabled = await configManager.isAwayEnabledForUser(userId);
  const lastSentAt = await configManager.getAwayLastSentAt(userId);
  const lastSentLine = lastSentAt
    ? `Last ping to you: <t:${Math.floor(lastSentAt / 1000)}:R>`
    : "Last ping to you: never";

  return [
    `Server away messages: **${settings.globalEnabled ? "enabled" : "disabled"}**`,
    `Your away pings: **${userEnabled ? "enabled" : "disabled"}**`,
    `Delay: **${settings.delayMinutes} minutes**`,
    `Cooldown: **${settings.cooldownHours} hours**`,
    lastSentLine,
  ].join("\n");
}

async function requireManageGuild(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (hasManageGuild(interaction)) return true;

  await interaction.reply({
    content: "You need **Manage Server** to change server-wide away settings.",
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

async function handleServerSubcommand(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
): Promise<void> {
  if (!(await requireManageGuild(interaction))) return;

  if (subcommand === "enable" || subcommand === "disable") {
    const enabled = subcommand === "enable";
    await configManager.setAwayGlobalEnabled(enabled);
    await interaction.reply({
      content: `Server away messages are now **${enabled ? "enabled" : "disabled"}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = configManager.getAwaySettings();
  const delayMinutes =
    interaction.options.getInteger("delay_minutes") ?? settings.delayMinutes;
  const cooldownHours =
    interaction.options.getInteger("cooldown_hours") ?? settings.cooldownHours;
  await configManager.setAwayTiming(delayMinutes, cooldownHours);

  const updated = configManager.getAwaySettings();
  await interaction.reply({
    content: [
      "Away message timing updated.",
      `Delay: **${updated.delayMinutes} minutes**`,
      `Cooldown: **${updated.cooldownHours} hours**`,
    ].join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleAwayCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    if (group === "server") {
      await handleServerSubcommand(interaction, subcommand);
      return;
    }

    if (subcommand === "status") {
      await interaction.reply({
        content: await formatStatus(interaction.user.id),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const enabled = subcommand === "enable";
    await configManager.setAwayUserEnabled(interaction.user.id, enabled);
    await interaction.reply({
      content: enabled
        ? "Away pings are enabled for you. I will only send them after the quiet delay and cooldown."
        : "Away pings are disabled for you.",
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    const err = error as Error;
    botLogger.error(
      {
        error: err.message,
        stack: err.stack,
        name: err.name,
        user: interaction.user.username,
      },
      "Away command failed",
    );

    const content =
      "Forgive me, my lord - I could not update away message settings.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
      return;
    }

    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}
