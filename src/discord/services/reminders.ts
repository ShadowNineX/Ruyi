import type { Client, SendableChannels, TextBasedChannel } from 'discord.js';
import type { ConfigScope } from '../../config';
import type { IReminder, ReminderKind } from '../../db/models';
import { Agent } from '@openai/agents';
import { agentsRuntimeManager } from '../../ai/client';
import { conversationContext } from '../../ai/context';
import { systemPrompt } from '../../ai/prompt';
import {
  REMINDER_DELIVERY_RETRY_DELAY_MS,
  REMINDER_DUE_BATCH_SIZE,
  REMINDER_LIST_LIMIT,
  REMINDER_LIST_TEXT_MAX_LENGTH,
  REMINDER_MAX_DELIVERY_ATTEMPTS,
  REMINDER_MESSAGE_GENERATION_TIMEOUT_MS,
  REMINDER_MESSAGE_MAX_LENGTH,
  REMINDER_PROCESSING_STALE_MS,
  REMINDER_SCHEDULER_ERROR_RETRY_MS,
  REMINDER_SCHEDULER_MAX_SLEEP_MS,
  REMINDER_TEXT_MAX_LENGTH,
} from '../../constants';
import { Reminder } from '../../db/models';
import { aiLogger, botLogger } from '../../logger';
import {
  getReminderSchedulerNextDueAt,
  getReminderSchedulerTimeout,
  isReminderServiceRunning,
  setReminderSchedulerTimeout,
  setReminderServiceRunning,
} from '../../stores';
import { fetchRecentChatMessages, splitMessage } from '../utils/messages';

const ACTIVE_REMINDER_STATUS = 'scheduled';
interface ReminderConfigScope {
  kind: Extract<ConfigScope['kind'], 'discord:guild' | 'discord:dm'>;
  id: string;
}
const REMINDER_DELIVERY_INSTRUCTIONS = [
  'Compose one short reminder delivery message from Ruyi to the target Discord user.',
  'The reminder/timer is due now. Tell the user what is due in Ruyi\'s own voice.',
  'Do not mention schedulers, databases, background jobs, automation, tool calls, or implementation details.',
  'Do not ask if they still want the reminder. Do not apologize for reminding them.',
  'Keep it warm, direct, and human-feeling. One or two short sentences is enough.',
  'Return only the message text. The Discord mention will be added outside your response.',
].join('\n');

interface CreateReminderInput {
  kind: ReminderKind;
  text: string;
  dueAt: Date;
  scope: ReminderConfigScope;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  createdByMessageId: string | null;
}

interface ReminderCancelResult {
  cancelled: boolean;
  reminder: IReminder | null;
}

function truncateReminderText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= REMINDER_TEXT_MAX_LENGTH) { return trimmed; }
  return `${trimmed.slice(0, REMINDER_TEXT_MAX_LENGTH - 3)}...`;
}

function formatReminderKind(kind: ReminderKind): string {
  return kind === 'timer' ? 'Timer' : 'Reminder';
}

export function formatReminderId(reminder: Pick<IReminder, '_id'>): string {
  return reminder._id.toString();
}

function truncateReminderListText(text: string, maxLength: number): string {
  if (text.length <= maxLength) { return text; }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function formatReminderLine(
  reminder: IReminder,
  maxTextLength = REMINDER_LIST_TEXT_MAX_LENGTH,
): string {
  const unix = Math.floor(reminder.dueAt.getTime() / 1000);
  const text = truncateReminderListText(reminder.text, maxTextLength);
  return `${formatReminderKind(reminder.kind)}: ${text} - <t:${unix}:F> (<t:${unix}:R>)`;
}

function getReminderErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertFutureDueAt(dueAt: Date): void {
  if (Number.isNaN(dueAt.getTime())) {
    throw new TypeError('Reminder due time is invalid');
  }
  if (dueAt.getTime() <= Date.now()) {
    throw new RangeError('Reminder due time must be in the future');
  }
}

function reminderScopeFilter(scope: ReminderConfigScope, userId: string) {
  return {
    scopeKind: scope.kind,
    scopeId: scope.id,
    userId,
  };
}

function isTextSendableChannel(
  channel: Awaited<ReturnType<Client['channels']['fetch']>>,
): channel is SendableChannels {
  return Boolean(channel && 'send' in channel);
}

function sanitizeGeneratedReminderMessage(content: string): string {
  const cleaned = content
    .replaceAll('@everyone', 'everyone')
    .replaceAll('@here', 'here')
    .trim();
  if (cleaned.length <= REMINDER_MESSAGE_MAX_LENGTH) { return cleaned; }
  return `${cleaned.slice(0, REMINDER_MESSAGE_MAX_LENGTH - 3).trimEnd()}...`;
}

function getSchedulerDelay(wakeAt: Date): number {
  const delay = Math.max(0, wakeAt.getTime() - Date.now());
  return Math.min(delay, REMINDER_SCHEDULER_MAX_SLEEP_MS);
}

function getEarlierDate(first: Date | null, second: Date | null): Date | null {
  if (!first) { return second; }
  if (!second) { return first; }
  return first.getTime() <= second.getTime() ? first : second;
}

function getProcessingRecoveryWakeAt(
  reminder: Pick<IReminder, 'processingStartedAt'>,
): Date {
  const processingStartedAt = reminder.processingStartedAt ?? new Date();
  return new Date(processingStartedAt.getTime() + REMINDER_PROCESSING_STALE_MS);
}

class ReminderService {
  private client: Client | null = null;

  async createReminder(input: CreateReminderInput): Promise<IReminder> {
    assertFutureDueAt(input.dueAt);
    const text = truncateReminderText(input.text);
    if (!text) { throw new TypeError('Reminder text cannot be empty'); }

    const reminder = await Reminder.create({
      kind: input.kind,
      text,
      dueAt: input.dueAt,
      status: ACTIVE_REMINDER_STATUS,
      scopeKind: input.scope.kind,
      scopeId: input.scope.id,
      guildId: input.guildId,
      channelId: input.channelId,
      userId: input.userId,
      username: input.username,
      createdByMessageId: input.createdByMessageId,
      deliveryAttempts: 0,
      processingStartedAt: null,
      lastDeliveryError: null,
    });

    this.scheduleCreatedReminder(reminder);
    return reminder;
  }

  private scheduleCreatedReminder(reminder: IReminder): void {
    if (!this.client) { return; }

    const nextDueAt = getReminderSchedulerNextDueAt();
    if (nextDueAt && nextDueAt.getTime() <= reminder.dueAt.getTime()) { return; }

    this.scheduleWakeAt(reminder.dueAt, 'reminder-created');
  }

  private clearScheduledWake(): void {
    const timeout = getReminderSchedulerTimeout();
    if (timeout) { clearTimeout(timeout); }
    setReminderSchedulerTimeout(null, null);
  }

  private scheduleWakeAt(wakeAt: Date, reason: string): void {
    this.clearScheduledWake();

    const delayMs = getSchedulerDelay(wakeAt);
    const timeout = setTimeout(() => {
      setReminderSchedulerTimeout(null, null);
      const activeClient = this.client;
      if (!activeClient) { return; }
      void this.runDueCheck(activeClient);
    }, delayMs);

    setReminderSchedulerTimeout(timeout, wakeAt);
    botLogger.debug(
      {
        wakeAt: wakeAt.toISOString(),
        delayMs,
        reason,
      },
      'Scheduled reminder service wake',
    );
  }

  private async findNextWakeAt(): Promise<Date | null> {
    const nextScheduled = await Reminder.findOne({
      status: ACTIVE_REMINDER_STATUS,
    })
      .sort({ dueAt: 1 })
      .select('dueAt');
    const nextProcessing = await Reminder.findOne({ status: 'processing' })
      .sort({ processingStartedAt: 1 })
      .select('processingStartedAt');

    return getEarlierDate(
      nextScheduled?.dueAt ?? null,
      nextProcessing ? getProcessingRecoveryWakeAt(nextProcessing) : null,
    );
  }

  private async scheduleNextWake(reason: string): Promise<void> {
    try {
      const nextWakeAt = await this.findNextWakeAt();
      if (!nextWakeAt) {
        this.clearScheduledWake();
        botLogger.debug({ reason }, 'Reminder queue is idle');
        return;
      }

      this.scheduleWakeAt(nextWakeAt, reason);
    } catch (error) {
      const retryAt = new Date(Date.now() + REMINDER_SCHEDULER_ERROR_RETRY_MS);
      this.scheduleWakeAt(retryAt, 'scheduler-error-retry');
      botLogger.error(
        {
          reason,
          retryAt: retryAt.toISOString(),
          error: getReminderErrorMessage(error),
        },
        'Failed to schedule next reminder wake',
      );
    }
  }

  async listActiveReminders(
    scope: ReminderConfigScope,
    userId: string,
    limit = REMINDER_LIST_LIMIT,
  ): Promise<IReminder[]> {
    return Reminder.find({
      ...reminderScopeFilter(scope, userId),
      status: ACTIVE_REMINDER_STATUS,
    })
      .sort({ dueAt: 1 })
      .limit(limit);
  }

  async cancelReminder(
    scope: ReminderConfigScope,
    userId: string,
    reminderId: string,
  ): Promise<ReminderCancelResult> {
    const reminder = await Reminder.findOneAndDelete(
      {
        _id: reminderId,
        ...reminderScopeFilter(scope, userId),
        status: ACTIVE_REMINDER_STATUS,
      },
    );

    if (reminder && this.client) {
      await this.scheduleNextWake('reminder-cancelled');
    }

    return { cancelled: Boolean(reminder), reminder };
  }

  private async claimReminder(reminder: IReminder): Promise<IReminder | null> {
    return Reminder.findOneAndUpdate(
      { _id: reminder._id, status: ACTIVE_REMINDER_STATUS },
      { $set: { status: 'processing', processingStartedAt: new Date() } },
      { new: true },
    );
  }

  private async recoverStaleProcessingReminders(): Promise<void> {
    const staleBefore = new Date(Date.now() - REMINDER_PROCESSING_STALE_MS);
    const result = await Reminder.updateMany(
      {
        status: 'processing',
        $or: [
          { processingStartedAt: null },
          { processingStartedAt: { $lte: staleBefore } },
        ],
      },
      {
        $set: {
          status: ACTIVE_REMINDER_STATUS,
          processingStartedAt: null,
        },
      },
    );

    if (result.modifiedCount > 0) {
      botLogger.warn(
        {
          recoveredCount: result.modifiedCount,
          staleBefore: staleBefore.toISOString(),
        },
        'Recovered stale processing reminders',
      );
    }
  }

  private async deliverReminder(
    client: Client,
    reminder: IReminder,
  ): Promise<void> {
    const channel = await client.channels.fetch(reminder.channelId);
    if (!isTextSendableChannel(channel)) {
      throw new Error('Reminder channel is not sendable');
    }
    const generated = await this.generateReminderMessage(channel, reminder);
    if (!generated) {
      throw new Error('Reminder message generation returned empty content');
    }

    const chunks = splitMessage(
      `<@${reminder.userId}> ${generated}`,
      REMINDER_MESSAGE_MAX_LENGTH + 32,
    );
    const firstChunk = chunks[0];
    if (!firstChunk) { throw new Error('Reminder message was empty after split'); }

    await channel.send({
      content: firstChunk,
      allowedMentions: { users: [reminder.userId] },
    });
  }

  private async generateReminderMessage(
    channel: TextBasedChannel,
    reminder: IReminder,
  ): Promise<string | null> {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      REMINDER_MESSAGE_GENERATION_TIMEOUT_MS,
    );

    try {
      const scope = this.getScope(reminder.guildId, reminder.userId);
      const dynamicContext = await conversationContext.buildDynamicContext(
        reminder.username,
        reminder.userId,
        reminder.channelId,
        await fetchRecentChatMessages(channel, {
          context: {
            reminderId: formatReminderId(reminder),
            userId: reminder.userId,
          },
          failureMessage: 'Could not fetch live history for reminder message',
        }),
        scope,
      );
      const dueUnix = Math.floor(reminder.dueAt.getTime() / 1000);
      const prompt = [
        dynamicContext,
        `<reminder_due>`,
        `Kind: ${formatReminderKind(reminder.kind)}`,
        `Text: ${reminder.text}`,
        `Due timestamp: <t:${dueUnix}:F>`,
        `</reminder_due>`,
        `<instructions>\n${REMINDER_DELIVERY_INSTRUCTIONS}\n</instructions>`,
      ].join('\n');

      const agent = new Agent({
        name: 'Ruyi Reminder Delivery',
        instructions: systemPrompt,
        model: agentsRuntimeManager.getProactiveTaskModel(),
        modelSettings: agentsRuntimeManager.getProactiveTaskModelSettings(),
        tools: [],
      });
      const result = await agentsRuntimeManager.getRunner().run(agent, prompt, {
        maxTurns: 1,
        signal: abortController.signal,
      });
      const finalOutput = result.finalOutput;
      const content
        = typeof finalOutput === 'string'
          ? sanitizeGeneratedReminderMessage(finalOutput)
          : '';

      return content.length > 0 ? content : null;
    } catch (error) {
      aiLogger.warn(
        {
          reminderId: formatReminderId(reminder),
          error: getReminderErrorMessage(error),
          name: error instanceof Error ? error.name : undefined,
        },
        'Reminder message generation failed',
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async markDelivered(reminder: IReminder): Promise<void> {
    await Reminder.deleteOne({ _id: reminder._id });
  }

  private async markDeliveryFailed(
    reminder: IReminder,
    error: unknown,
  ): Promise<void> {
    const attempts = reminder.deliveryAttempts + 1;
    const exhausted = attempts >= REMINDER_MAX_DELIVERY_ATTEMPTS;
    if (exhausted) {
      await Reminder.deleteOne({ _id: reminder._id });
      return;
    }

    await Reminder.updateOne(
      { _id: reminder._id },
      {
        $set: {
          dueAt: new Date(Date.now() + REMINDER_DELIVERY_RETRY_DELAY_MS),
          status: ACTIVE_REMINDER_STATUS,
          processingStartedAt: null,
          lastDeliveryError: getReminderErrorMessage(error),
        },
        $inc: { deliveryAttempts: 1 },
      },
    );
  }

  private async processDueReminder(
    client: Client,
    reminder: IReminder,
  ): Promise<void> {
    const claimed = await this.claimReminder(reminder);
    if (!claimed) { return; }

    try {
      await this.deliverReminder(client, claimed);
      await this.markDelivered(claimed);
      botLogger.info(
        {
          reminderId: formatReminderId(claimed),
          channelId: claimed.channelId,
          userId: claimed.userId,
        },
        'Delivered reminder',
      );
    } catch (error) {
      await this.markDeliveryFailed(claimed, error);
      botLogger.error(
        {
          reminderId: formatReminderId(claimed),
          channelId: claimed.channelId,
          userId: claimed.userId,
          error: getReminderErrorMessage(error),
        },
        'Reminder delivery failed',
      );
    }
  }

  private async runDueCheck(client: Client): Promise<void> {
    if (isReminderServiceRunning()) { return; }

    setReminderServiceRunning(true);
    try {
      await this.recoverStaleProcessingReminders();
      const dueReminders = await Reminder.find({
        status: ACTIVE_REMINDER_STATUS,
        dueAt: { $lte: new Date() },
      })
        .sort({ dueAt: 1 })
        .limit(REMINDER_DUE_BATCH_SIZE);

      for (const reminder of dueReminders) {
        await this.processDueReminder(client, reminder);
      }
    } catch (error) {
      botLogger.error(
        { error: getReminderErrorMessage(error) },
        'Reminder due-check failed',
      );
    } finally {
      setReminderServiceRunning(false);
      if (this.client) {
        await this.scheduleNextWake('due-check-complete');
      }
    }
  }

  start(client: Client): void {
    if (this.client) {
      botLogger.warn('Reminder service already running');
      return;
    }

    this.client = client;
    botLogger.info('Starting reminder service');
    void this.runDueCheck(client);
  }

  stop(): void {
    if (!this.client) { return; }

    this.client = null;
    this.clearScheduledWake();
    setReminderServiceRunning(false);
    botLogger.info('Reminder service stopped');
  }

  getScope(guildId: string | null, userId: string): ReminderConfigScope {
    return guildId
      ? { kind: 'discord:guild', id: guildId }
      : { kind: 'discord:dm', id: userId };
  }
}

export const reminderService = new ReminderService();
