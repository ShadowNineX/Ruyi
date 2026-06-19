import { tool } from '@openai/agents';
import { z } from 'zod';
import { toolLogger } from '../../logger';
import { formatError, toolContextManager } from '../../utils/types';
import {
  formatReminderId,
  formatReminderLine,
  reminderService,
} from '../services/reminders';

const ReminderActionSchema = z.enum(['create', 'list', 'cancel']);

function unixToDate(unix: number): Date {
  return new Date(unix * 1000);
}

export const manageReminderTool = tool({
  name: 'manage_reminder',
  description:
    'Create, list, or cancel reminders and timers for the current Discord user/channel. Requires exact due_unix for creation; use resolve_time or current context before calling if needed.',
  parameters: z.object({
    action: ReminderActionSchema.describe('Create, list, or cancel reminders.'),
    kind: z
      .enum(['reminder', 'timer'])
      .default('reminder')
      .describe('Use timer for countdown-style requests, reminder otherwise.'),
    due_unix: z
      .number()
      .int()
      .nullable()
      .describe(
        'Exact future Unix timestamp in seconds for create. Do not pass natural-language text here.',
      ),
    text: z
      .string()
      .nullable()
      .describe('Reminder text for create, such as what the user wants to do.'),
    reminder_id: z
      .string()
      .nullable()
      .describe('Exact reminder ID for cancel.'),
  }),
  execute: async ({ action, kind, due_unix, text, reminder_id }) => {
    const { message } = toolContextManager.get();
    if (!message) {
      return { error: 'Reminder tools require an active Discord message.' };
    }

    const scope = reminderService.getScope(
      message.guild?.id ?? null,
      message.author.id,
    );

    try {
      if (action === 'list') {
        const reminders = await reminderService.listActiveReminders(
          scope,
          message.author.id,
        );
        return {
          reminders: reminders.map(reminder => ({
            id: formatReminderId(reminder),
            kind: reminder.kind,
            text: reminder.text,
            due_unix: Math.floor(reminder.dueAt.getTime() / 1000),
            due_discord: `<t:${Math.floor(reminder.dueAt.getTime() / 1000)}:F>`,
            line: formatReminderLine(reminder),
          })),
          count: reminders.length,
          guidance:
            reminders.length === 0
              ? 'Tell the user they have no active reminders in this server/private chat.'
              : 'Show the active reminders concisely, including IDs only if the user may cancel one.',
        };
      }

      if (action === 'cancel') {
        if (!reminder_id) {
          return { error: 'reminder_id is required to cancel a reminder.' };
        }

        const result = await reminderService.cancelReminder(
          scope,
          message.author.id,
          reminder_id,
        );
        return {
          cancelled: result.cancelled,
          reminder_id,
          guidance: result.cancelled
            ? 'Tell the user the reminder was cancelled.'
            : 'Tell the user no active reminder with that ID was found in this server/private chat.',
        };
      }

      if (!due_unix) {
        return {
          error: 'due_unix is required to create a reminder.',
          guidance:
            'Resolve or calculate the due time first, then call manage_reminder again with the exact Unix timestamp.',
        };
      }
      if (!text?.trim()) {
        return { error: 'text is required to create a reminder.' };
      }

      const reminder = await reminderService.createReminder({
        kind,
        text,
        dueAt: unixToDate(due_unix),
        scope,
        guildId: message.guild?.id ?? null,
        channelId: message.channel.id,
        userId: message.author.id,
        username: message.author.username,
        createdByMessageId: message.id,
      });
      const dueUnix = Math.floor(reminder.dueAt.getTime() / 1000);

      toolLogger.info(
        {
          reminderId: formatReminderId(reminder),
          kind: reminder.kind,
          channelId: reminder.channelId,
          userId: reminder.userId,
          dueUnix,
        },
        'Created reminder',
      );

      return {
        created: true,
        id: formatReminderId(reminder),
        kind: reminder.kind,
        text: reminder.text,
        due_unix: dueUnix,
        due_discord: `<t:${dueUnix}:F>`,
        due_relative: `<t:${dueUnix}:R>`,
        guidance:
          'Confirm the reminder naturally. Mention when it is due; include the ID only if useful for cancellation.',
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        {
          action,
          kind,
          due_unix,
          reminder_id,
          userId: message.author.id,
          channelId: message.channel.id,
          error: errorMessage,
        },
        'Reminder tool failed',
      );
      return { error: errorMessage };
    }
  },
});
