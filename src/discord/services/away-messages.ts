import type { Message } from 'discord.js';
import type { ConfigScope } from '../../config';
import type { DiscordPresenceInfo } from '../utils/discord-profile';
import { Agent } from '@openai/agents';
import { agentsRuntimeManager } from '../../ai/client';
import { conversationContext } from '../../ai/context';
import { systemPrompt } from '../../ai/prompt';
import {
  configManager,

  configScopeKey,
  userConfigScope,
} from '../../config';
import {
  AWAY_MESSAGE_GENERATION_TIMEOUT_MS,
  AWAY_MESSAGE_MAX_LENGTH,
} from '../../constants';
import { aiLogger, botLogger } from '../../logger';
import {
  deleteAwayTimer,
  getAwayTimer,
  getAwayTimerEntries,
  getLastChannelActivityAt,
  getLastScopedUserActivityAt,
  getLastUserActivityAt,
  setAwayTimer,
  setLastChannelActivityAt,
  setLastScopedUserActivityAt,
  setLastUserActivityAt,
} from '../../stores';
import {
  buildDiscordPresence,

  formatPresenceContext,
} from '../utils/discord-profile';
import {
  fetchRecentChatMessages,
  formatMessageForAI,
  splitMessage,
} from '../utils/messages';

interface AwayTarget {
  channel: Message['channel'];
  scope: ConfigScope;
  channelId: string;
  userId: string;
  username: string;
  displayName: string;
  sourceMessageContent: string;
  sourceMessageId: string;
  assistantReply: string | null;
  scheduledAt: number;
}

const AWAY_LIVE_HISTORY_LIMIT = 12;
const AWAY_CONTEXT_TEXT_MAX_LENGTH = 1_200;

const AWAY_MESSAGE_INSTRUCTIONS = [
  'Compose one short Character.AI-style away message from Ruyi to the current user.',
  'This is a proactive message after a quiet gap in an existing conversation.',
  'Do not mention timers, automation, inactivity tracking, settings, or that this was triggered by a service.',
  'Do not perform or promise actions. Do not ask multiple questions.',
  'Stay in Ruyi\'s formal, warm Nine Sols voice. Keep it human-feeling and gentle.',
  'Ground the message in the most recent handled turn. Do not resurrect older topics unless they appear in the provided recent turn or live Discord messages.',
  'Return only the message text. The Discord mention will be added outside your response.',
].join('\n');

function awayKey(
  scope: ConfigScope,
  channelId: string,
  userId: string,
): string {
  return `${configScopeKey(scope)}:${channelId}:${userId}`;
}

function scopedUserActivityKey(scope: ConfigScope, userId: string): string {
  return `${configScopeKey(scope)}:${userId}`;
}

function sanitizeAwayMessage(content: string): string {
  const withoutMassMentions = content
    .replaceAll('@everyone', 'everyone')
    .replaceAll('@here', 'here')
    .trim();
  return withoutMassMentions.length > AWAY_MESSAGE_MAX_LENGTH
    ? `${withoutMassMentions.slice(0, AWAY_MESSAGE_MAX_LENGTH - 3).trimEnd()}...`
    : withoutMassMentions;
}

function truncateAwayContextText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > AWAY_CONTEXT_TEXT_MAX_LENGTH
    ? `${trimmed.slice(0, AWAY_CONTEXT_TEXT_MAX_LENGTH - 3).trimEnd()}...`
    : trimmed;
}

function buildMostRecentHandledTurn(target: AwayTarget): string {
  const lines = [
    'Most recent handled Discord turn that scheduled this away ping:',
    `${target.username}: ${truncateAwayContextText(target.sourceMessageContent)}`,
  ];

  if (target.assistantReply) {
    lines.push(`Ruyi: ${truncateAwayContextText(target.assistantReply)}`);
  }

  return lines.join('\n');
}

class AwayMessageService {
  recordUserActivity(message: Message): void {
    if (message.author.bot) { return; }

    const scope = userConfigScope(message.guild?.id ?? null, message.author.id);
    const now = Date.now();
    setLastUserActivityAt(message.author.id, now);
    setLastScopedUserActivityAt(
      scopedUserActivityKey(scope, message.author.id),
      now,
    );
    setLastChannelActivityAt(message.channel.id, now);
    this.clearTimersForUser(message.author.id);
  }

  async scheduleAfterHandledTurn(
    message: Message,
    assistantReply: string | null = null,
  ): Promise<void> {
    if (message.author.bot || !('send' in message.channel)) {
      return;
    }

    const scope = userConfigScope(message.guild?.id ?? null, message.author.id);
    const settings = configManager.getAwaySettings(scope);
    if (!settings.scopeEnabled) { return; }
    if (!(await configManager.isAwayEnabledForUser(scope, message.author.id))) {
      return;
    }
    if (
      await this.isOnCooldown(scope, message.author.id, settings.cooldownMs)
    ) {
      return;
    }

    const key = awayKey(scope, message.channel.id, message.author.id);
    this.clearTimer(key);

    const scheduledAt = Date.now();
    const dueAt = scheduledAt + settings.delayMs;
    const target: AwayTarget = {
      channel: message.channel,
      scope,
      channelId: message.channel.id,
      userId: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName,
      sourceMessageContent: formatMessageForAI(message),
      sourceMessageId: message.id,
      assistantReply,
      scheduledAt,
    };
    const timer = setTimeout(() => {
      void this.sendAwayMessageIfStillInactive(key, target);
    }, settings.delayMs);

    setAwayTimer(key, {
      timer,
      dueAt,
      userId: message.author.id,
    });
    botLogger.debug(
      {
        channelId: target.channelId,
        userId: target.userId,
        username: target.username,
        dueAt,
        delayMinutes: settings.delayMinutes,
      },
      'Scheduled away message',
    );
  }

  private clearTimer(key: string): void {
    const existing = getAwayTimer(key);
    if (!existing) { return; }

    clearTimeout(existing.timer);
    deleteAwayTimer(key);
  }

  private clearTimersForUser(userId: string): void {
    for (const [key, timer] of getAwayTimerEntries()) {
      if (timer.userId === userId) { this.clearTimer(key); }
    }
  }

  private async isOnCooldown(
    scope: ConfigScope,
    userId: string,
    cooldownMs: number,
  ): Promise<boolean> {
    const lastSentAt = await configManager.getAwayLastSentAt(scope, userId);
    return lastSentAt !== null && Date.now() - lastSentAt < cooldownMs;
  }

  private async sendAwayMessageIfStillInactive(
    key: string,
    target: AwayTarget,
  ): Promise<void> {
    deleteAwayTimer(key);

    try {
      const settings = configManager.getAwaySettings(target.scope);
      if (!settings.scopeEnabled) { return; }
      if (
        !(await configManager.isAwayEnabledForUser(target.scope, target.userId))
      ) {
        return;
      }
      if (
        await this.isOnCooldown(
          target.scope,
          target.userId,
          settings.cooldownMs,
        )
      ) {
        return;
      }

      if (!this.isStillAway(target, settings.delayMs)) {
        botLogger.debug(
          {
            channelId: target.channelId,
            userId: target.userId,
            username: target.username,
          },
          'Skipped away message because activity resumed',
        );
        return;
      }

      const presence = await this.fetchTargetPresence(target);
      const generated = await this.generateAwayMessage(target, presence);
      if (!generated) { return; }

      const chunks = splitMessage(
        `<@${target.userId}> ${generated}`,
        AWAY_MESSAGE_MAX_LENGTH + 32,
      );
      const firstChunk = chunks[0];
      if (!firstChunk || !('send' in target.channel)) { return; }

      await target.channel.send({
        content: firstChunk,
        allowedMentions: { users: [target.userId] },
      });
      await configManager.setAwayLastSentAt(
        target.scope,
        target.userId,
        Date.now(),
      );

      botLogger.info(
        {
          channelId: target.channelId,
          userId: target.userId,
          username: target.username,
        },
        'Sent away message',
      );
    } catch (error) {
      botLogger.error(
        {
          error: (error as Error).message,
          stack: (error as Error).stack,
          name: (error as Error).name,
          channelId: target.channelId,
          userId: target.userId,
        },
        'Failed to send away message',
      );
    }
  }

  private isStillAway(target: AwayTarget, delayMs: number): boolean {
    const now = Date.now();
    const lastGlobalUserActivity = getLastUserActivityAt(target.userId);
    const lastUserActivity = getLastScopedUserActivityAt(
      scopedUserActivityKey(target.scope, target.userId),
    );
    const lastChannelActivity = getLastChannelActivityAt(target.channelId);

    if (lastGlobalUserActivity > target.scheduledAt) { return false; }
    if (lastUserActivity > target.scheduledAt) { return false; }
    if (lastChannelActivity > target.scheduledAt) { return false; }

    return (
      now - lastUserActivity >= delayMs && now - lastChannelActivity >= delayMs
    );
  }

  private async fetchTargetPresence(
    target: AwayTarget,
  ): Promise<DiscordPresenceInfo | null> {
    if (!('guild' in target.channel)) { return null; }

    try {
      const member = await target.channel.guild.members.fetch(target.userId);
      return buildDiscordPresence(member);
    } catch (error) {
      botLogger.debug(
        {
          error: (error as Error).message,
          channelId: target.channelId,
          userId: target.userId,
        },
        'Could not fetch Discord presence for away message',
      );
      return null;
    }
  }

  private async generateAwayMessage(
    target: AwayTarget,
    presence: DiscordPresenceInfo | null,
  ): Promise<string | null> {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      AWAY_MESSAGE_GENERATION_TIMEOUT_MS,
    );

    try {
      const [dynamicContext, recentHistory] = await Promise.all([
        conversationContext.buildDynamicContext(
          target.username,
          target.userId,
          target.channelId,
          await fetchRecentChatMessages(target.channel, {
            limit: AWAY_LIVE_HISTORY_LIMIT,
            context: {
              channelId: target.channelId,
              userId: target.userId,
              sourceMessageId: target.sourceMessageId,
            },
            failureMessage: 'Could not fetch live history for away message',
          }),
          target.scope,
          { includeConversationSummary: false },
        ),
        Promise.resolve(buildMostRecentHandledTurn(target)),
      ]);
      const presenceContext = formatPresenceContext(presence);
      const prompt = [
        dynamicContext,
        presenceContext,
        recentHistory,
        `<instructions>\n${AWAY_MESSAGE_INSTRUCTIONS}\nTarget user display name: ${target.displayName}\n</instructions>`,
      ]
        .filter(section => section.length > 0)
        .join('\n\n');

      const agent = new Agent({
        name: 'Ruyi Away Message',
        instructions: systemPrompt,
        model: agentsRuntimeManager.getProactiveTaskModel(),
        modelSettings: agentsRuntimeManager.getProactiveTaskModelSettings(),
        tools: [],
      });
      const runner = agentsRuntimeManager.getRunner();
      const result = await runner.run(agent, prompt, {
        maxTurns: 1,
        signal: abortController.signal,
      });
      const finalOutput = result.finalOutput;
      const content
        = typeof finalOutput === 'string' ? sanitizeAwayMessage(finalOutput) : '';

      return content.length > 0 ? content : null;
    } catch (error) {
      aiLogger.warn(
        {
          error: (error as Error).message,
          name: (error as Error).name,
          channelId: target.channelId,
          username: target.username,
        },
        'Away message generation failed',
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const awayMessageService = new AwayMessageService();
