import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  configManager,
  formatConfigScope,
  userConfigScope,
  type ConfigScope,
} from "../config";
import {
  AWAY_MESSAGE_MAX_COOLDOWN_HOURS,
  AWAY_MESSAGE_MAX_DELAY_MINUTES,
  AWAY_MESSAGE_MIN_COOLDOWN_HOURS,
  AWAY_MESSAGE_MIN_DELAY_MINUTES,
} from "../constants";
import { botLogger } from "../logger";

const AWAY_COLORS = {
  neutral: 0x5865f2,
  success: 0x57f287,
  warning: 0xffaa00,
  error: 0xcc3333,
} as const;

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

function formatEnabled(enabled: boolean): string {
  return enabled ? "Enabled" : "Disabled";
}

function formatLastSent(lastSentAt: number | null): string {
  if (!lastSentAt) return "Never";
  return `<t:${Math.floor(lastSentAt / 1000)}:R>`;
}

function buildAwayEmbed(
  title: string,
  description: string,
  color: number,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

async function buildStatusEmbed(
  scope: ConfigScope,
  userId: string,
): Promise<EmbedBuilder> {
  const settings = configManager.getAwaySettings(scope);
  const userEnabled = await configManager.isAwayEnabledForUser(scope, userId);
  const lastSentAt = await configManager.getAwayLastSentAt(scope, userId);
  const scopeLabel =
    scope.kind === "guild" ? "Server away messages" : "Private-chat away messages";

  return buildAwayEmbed(
    "Away Messages",
    `Current away-message settings for ${formatConfigScope(scope)}.`,
    AWAY_COLORS.neutral,
  ).addFields(
    {
      name: scopeLabel,
      value: formatEnabled(settings.scopeEnabled),
      inline: true,
    },
    {
      name: "Your away pings",
      value: formatEnabled(userEnabled),
      inline: true,
    },
    {
      name: "Delay",
      value: `${settings.delayMinutes} minutes`,
      inline: true,
    },
    {
      name: "Cooldown",
      value: `${settings.cooldownHours} hours`,
      inline: true,
    },
    {
      name: "Last ping to you",
      value: formatLastSent(lastSentAt),
      inline: true,
    },
  );
}

function buildPermissionEmbed(): EmbedBuilder {
  return buildAwayEmbed(
    "Away Messages",
    "You need Manage Server to change server-wide away settings.",
    AWAY_COLORS.warning,
  );
}

function buildServerOnlyEmbed(): EmbedBuilder {
  return buildAwayEmbed(
    "Away Messages",
    "Server-wide away settings can only be changed in a server.",
    AWAY_COLORS.warning,
  );
}

function buildScopeToggleEmbed(
  enabled: boolean,
  scopeLabel: string,
): EmbedBuilder {
  return buildAwayEmbed(
    "Away Messages",
    `${scopeLabel} are now ${enabled ? "enabled" : "disabled"}.`,
    AWAY_COLORS.success,
  );
}

function buildTimingEmbed(scope: ConfigScope): EmbedBuilder {
  const settings = configManager.getAwaySettings(scope);
  return buildAwayEmbed(
    "Away Message Timing Updated",
    `Away-message timing for ${formatConfigScope(scope)} has been updated.`,
    AWAY_COLORS.success,
  ).addFields(
    {
      name: "Delay",
      value: `${settings.delayMinutes} minutes`,
      inline: true,
    },
    {
      name: "Cooldown",
      value: `${settings.cooldownHours} hours`,
      inline: true,
    },
  );
}

function buildUserToggleEmbed(scope: ConfigScope, enabled: boolean): EmbedBuilder {
  const description = enabled
    ? `Away pings are enabled for you in ${formatConfigScope(scope)}. Ruyi will only send them after the quiet delay and cooldown.`
    : `Away pings are disabled for you in ${formatConfigScope(scope)}.`;

  return buildAwayEmbed(
    "Away Messages",
    description,
    enabled ? AWAY_COLORS.success : AWAY_COLORS.warning,
  ).addFields({
    name: "Your away pings",
    value: formatEnabled(enabled),
    inline: true,
  });
}

function buildErrorEmbed(): EmbedBuilder {
  return buildAwayEmbed(
    "Away Messages Unavailable",
    "Forgive me, my lord - I could not update away message settings.",
    AWAY_COLORS.error,
  );
}

async function requireManageGuild(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (hasManageGuild(interaction)) return true;

  await interaction.reply({
    embeds: [buildPermissionEmbed()],
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

async function handleServerSubcommand(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      embeds: [buildServerOnlyEmbed()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scope = userConfigScope(guildId, interaction.user.id);
  if (!(await requireManageGuild(interaction))) return;

  if (subcommand === "enable" || subcommand === "disable") {
    const enabled = subcommand === "enable";
    await configManager.setAwayScopeEnabled(scope, enabled);
    await interaction.reply({
      embeds: [buildScopeToggleEmbed(enabled, "Server away messages")],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = configManager.getAwaySettings(scope);
  const delayMinutes =
    interaction.options.getInteger("delay_minutes") ?? settings.delayMinutes;
  const cooldownHours =
    interaction.options.getInteger("cooldown_hours") ?? settings.cooldownHours;
  await configManager.setAwayTiming(scope, delayMinutes, cooldownHours);

  await interaction.reply({
    embeds: [buildTimingEmbed(scope)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleAwayCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    const scope = userConfigScope(interaction.guildId, interaction.user.id);

    if (group === "server") {
      await handleServerSubcommand(interaction, subcommand);
      return;
    }

    if (subcommand === "status") {
      await interaction.reply({
        embeds: [await buildStatusEmbed(scope, interaction.user.id)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const enabled = subcommand === "enable";
    await configManager.setAwayUserEnabled(scope, interaction.user.id, enabled);
    await interaction.reply({
      embeds: [buildUserToggleEmbed(scope, enabled)],
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

    const embed = buildErrorEmbed();
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: null, embeds: [embed] });
      return;
    }

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
  }
}
