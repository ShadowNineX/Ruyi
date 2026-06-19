import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { IReminder, ReminderKind } from '../../db/models';
import {

  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,

} from 'discord.js';
import { REMINDER_LIST_LIMIT } from '../../constants';
import { botLogger } from '../../logger';
import { formatReminderLine, reminderService } from '../services/reminders';

const REMINDER_COLORS = {
  neutral: 0x5865F2,
  success: 0x57F287,
  warning: 0xFFAA00,
  error: 0xCC3333,
} as const;

const DURATION_UNITS = ['seconds', 'minutes', 'hours', 'days', 'weeks'] as const;
type DurationUnit = (typeof DURATION_UNITS)[number];

export const remindCommand = new SlashCommandBuilder()
  .setName('remind')
  .setDescription('Set a reminder or timer')
  .addIntegerOption(option =>
    option
      .setName('amount')
      .setDescription('How long from now')
      .setMinValue(1)
      .setRequired(true),
  )
  .addStringOption(option =>
    option
      .setName('unit')
      .setDescription('Time unit')
      .setRequired(true)
      .addChoices(
        { name: 'seconds', value: 'seconds' },
        { name: 'minutes', value: 'minutes' },
        { name: 'hours', value: 'hours' },
        { name: 'days', value: 'days' },
        { name: 'weeks', value: 'weeks' },
      ),
  )
  .addStringOption(option =>
    option
      .setName('text')
      .setDescription('What to remind you about')
      .setRequired(true)
      .setMaxLength(500),
  )
  .addStringOption(option =>
    option
      .setName('kind')
      .setDescription('Reminder type')
      .addChoices(
        { name: 'reminder', value: 'reminder' },
        { name: 'timer', value: 'timer' },
      ),
  );

export const timersCommand = new SlashCommandBuilder()
  .setName('timers')
  .setDescription('List your active reminders and timers');

export const cancelReminderCommand = new SlashCommandBuilder()
  .setName('cancel-reminder')
  .setDescription('Cancel one of your active reminders or timers')
  .addStringOption(option =>
    option
      .setName('reminder')
      .setDescription('Which reminder or timer to cancel')
      .setRequired(true)
      .setAutocomplete(true),
  );

function buildReminderEmbed(
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

function getDurationUnit(value: string): DurationUnit {
  if (DURATION_UNITS.includes(value as DurationUnit)) {
    return value as DurationUnit;
  }

  throw new TypeError('Invalid reminder duration unit');
}

function getReminderKind(value: string | null): ReminderKind {
  return value === 'timer' ? 'timer' : 'reminder';
}

function addDuration(amount: number, unit: DurationUnit): Date {
  const dueAt = new Date();
  switch (unit) {
    case 'seconds':
      dueAt.setSeconds(dueAt.getSeconds() + amount);
      break;
    case 'minutes':
      dueAt.setMinutes(dueAt.getMinutes() + amount);
      break;
    case 'hours':
      dueAt.setHours(dueAt.getHours() + amount);
      break;
    case 'days':
      dueAt.setDate(dueAt.getDate() + amount);
      break;
    case 'weeks':
      dueAt.setDate(dueAt.getDate() + amount * 7);
      break;
  }

  return dueAt;
}

async function replyWithEmbed(
  interaction: ChatInputCommandInteraction,
  embed: EmbedBuilder,
): Promise<void> {
  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  });
}

function formatReminderChoiceName(
  reminder: IReminder,
): string {
  const text
    = reminder.text.length <= 58
      ? reminder.text
      : `${reminder.text.slice(0, 55).trimEnd()}...`;
  const line = `${getReminderKindLabel(reminder.kind)}: ${text} - ${formatRelativeDue(reminder.dueAt)}`;
  return line.length <= 100 ? line : `${line.slice(0, 97).trimEnd()}...`;
}

function getReminderKindLabel(kind: ReminderKind): string {
  return kind === 'timer' ? 'Timer' : 'Reminder';
}

function formatRelativeDue(dueAt: Date): string {
  const remainingMs = dueAt.getTime() - Date.now();
  if (remainingMs <= 0) { return 'due now'; }

  const remainingSeconds = Math.ceil(remainingMs / 1000);
  if (remainingSeconds < 60) { return `in ${remainingSeconds}s`; }

  const remainingMinutes = Math.ceil(remainingSeconds / 60);
  if (remainingMinutes < 60) { return `in ${remainingMinutes}m`; }

  const remainingHours = Math.ceil(remainingMinutes / 60);
  if (remainingHours < 24) { return `in ${remainingHours}h`; }

  const remainingDays = Math.ceil(remainingHours / 24);
  return `in ${remainingDays}d`;
}

function formatCancelledReminderDescription(reminder: IReminder | null): string {
  if (!reminder) { return 'Cancelled that reminder.'; }
  return `Cancelled ${formatReminderLine(reminder)}`;
}

export async function handleRemindCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const amount = interaction.options.getInteger('amount', true);
    const unit = getDurationUnit(interaction.options.getString('unit', true));
    const text = interaction.options.getString('text', true);
    const kind = getReminderKind(interaction.options.getString('kind'));
    const scope = reminderService.getScope(
      interaction.guildId,
      interaction.user.id,
    );
    const reminder = await reminderService.createReminder({
      kind,
      text,
      dueAt: addDuration(amount, unit),
      scope,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      username: interaction.user.username,
      createdByMessageId: null,
    });
    const dueUnix = Math.floor(reminder.dueAt.getTime() / 1000);

    await replyWithEmbed(
      interaction,
      buildReminderEmbed(
        kind === 'timer' ? 'Timer Set' : 'Reminder Set',
        `${reminder.text}\n\nDue <t:${dueUnix}:F> (<t:${dueUnix}:R>)`,
        REMINDER_COLORS.success,
      ),
    );
  } catch (error) {
    await handleReminderCommandError(interaction, error, 'set reminder');
  }
}

export async function handleTimersCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const scope = reminderService.getScope(
      interaction.guildId,
      interaction.user.id,
    );
    const reminders = await reminderService.listActiveReminders(
      scope,
      interaction.user.id,
      REMINDER_LIST_LIMIT,
    );

    const description
      = reminders.length === 0
        ? 'You have no active reminders or timers in this server/private chat.'
        : reminders.map(reminder => formatReminderLine(reminder)).join('\n');

    await replyWithEmbed(
      interaction,
      buildReminderEmbed(
        'Active Reminders',
        description,
        reminders.length === 0
          ? REMINDER_COLORS.neutral
          : REMINDER_COLORS.success,
      ),
    );
  } catch (error) {
    await handleReminderCommandError(interaction, error, 'list reminders');
  }
}

export async function handleCancelReminderCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const reminderId = interaction.options.getString('reminder', true);
    const scope = reminderService.getScope(
      interaction.guildId,
      interaction.user.id,
    );
    const result = await reminderService.cancelReminder(
      scope,
      interaction.user.id,
      reminderId,
    );

    const embed = result.cancelled
      ? buildReminderEmbed(
          'Reminder Cancelled',
          formatCancelledReminderDescription(result.reminder),
          REMINDER_COLORS.success,
        )
      : buildReminderEmbed(
          'Reminder Not Found',
          'No active reminder matched that selection in this server/private chat.',
          REMINDER_COLORS.warning,
        );

    await replyWithEmbed(interaction, embed);
  } catch (error) {
    await handleReminderCommandError(interaction, error, 'cancel reminder');
  }
}

export async function handleReminderAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  try {
    if (interaction.commandName !== 'cancel-reminder') { return; }

    const focusedValue = interaction.options.getFocused().toLowerCase();
    const scope = reminderService.getScope(
      interaction.guildId,
      interaction.user.id,
    );
    const reminders = await reminderService.listActiveReminders(
      scope,
      interaction.user.id,
      25,
    );
    const choices = reminders
      .map(reminder => ({
        name: formatReminderChoiceName(reminder),
        value: reminder._id.toString(),
      }))
      .filter(choice => choice.name.toLowerCase().includes(focusedValue))
      .slice(0, 25);

    await interaction.respond(choices);
  } catch (error) {
    botLogger.error(
      {
        error: (error as Error).message,
        stack: (error as Error).stack,
        name: (error as Error).name,
        user: interaction.user.username,
        command: interaction.commandName,
      },
      'Failed to autocomplete reminders',
    );
    await interaction.respond([]);
  }
}

async function handleReminderCommandError(
  interaction: ChatInputCommandInteraction,
  error: unknown,
  action: string,
): Promise<void> {
  const err = error as Error;
  botLogger.error(
    {
      error: err.message,
      stack: err.stack,
      name: err.name,
      user: interaction.user.username,
      command: interaction.commandName,
    },
    `Failed to ${action}`,
  );

  const embed = buildReminderEmbed(
    'Reminders Unavailable',
    'Forgive me, my lord - I could not update reminders just now.',
    REMINDER_COLORS.error,
  );

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: null, embeds: [embed] });
    return;
  }

  await replyWithEmbed(interaction, embed);
}
