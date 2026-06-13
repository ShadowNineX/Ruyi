import { Agent } from "@openai/agents";
import type { Message } from "discord.js";
import { configManager } from "../config";
import {
  AWAY_MESSAGE_GENERATION_TIMEOUT_MS,
  AWAY_MESSAGE_MAX_LENGTH,
} from "../constants";
import { Conversation } from "../db/models";
import { aiLogger, botLogger } from "../logger";
import { agentsRuntimeManager } from "../ai/client";
import { conversationContext, type ChatMessage } from "../ai/context";
import { systemPrompt } from "../ai/prompt";
import { formatMessageForAI, splitMessage } from "../utils/messages";

interface AwayTimer {
  timer: ReturnType<typeof setTimeout>;
  dueAt: number;
  userId: string;
}

interface AwayTarget {
  channel: Message["channel"];
  channelId: string;
  userId: string;
  username: string;
  displayName: string;
  scheduledAt: number;
}

const AWAY_MESSAGE_INSTRUCTIONS = [
  "Compose one short Character.AI-style away message from Ruyi to the current user.",
  "This is a proactive message after a quiet gap in an existing conversation.",
  "Do not mention timers, automation, inactivity tracking, settings, or that this was triggered by a service.",
  "Do not perform or promise actions. Do not ask multiple questions.",
  "Stay in Ruyi's formal, warm Nine Sols voice. Keep it human-feeling, gentle, and specific to the recent context when possible.",
  "Return only the message text. The Discord mention will be added outside your response.",
].join("\n");

function awayKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`;
}

function sanitizeAwayMessage(content: string): string {
  const withoutMassMentions = content
    .replace(/@everyone/g, "everyone")
    .replace(/@here/g, "here")
    .trim();
  return withoutMassMentions.length > AWAY_MESSAGE_MAX_LENGTH
    ? `${withoutMassMentions.slice(0, AWAY_MESSAGE_MAX_LENGTH - 3).trimEnd()}...`
    : withoutMassMentions;
}

export class AwayMessageService {
  private readonly timers = new Map<string, AwayTimer>();
  private readonly lastUserActivityAt = new Map<string, number>();
  private readonly lastChannelActivityAt = new Map<string, number>();

  recordUserActivity(message: Message): void {
    if (message.author.bot || !message.inGuild()) return;

    const now = Date.now();
    this.lastUserActivityAt.set(message.author.id, now);
    this.lastChannelActivityAt.set(message.channel.id, now);
    this.clearTimersForUser(message.author.id);
  }

  async scheduleAfterHandledTurn(message: Message): Promise<void> {
    if (message.author.bot || !message.inGuild() || !("send" in message.channel)) {
      return;
    }

    const settings = configManager.getAwaySettings();
    if (!settings.globalEnabled) return;
    if (!(await configManager.isAwayEnabledForUser(message.author.id))) return;
    if (await this.isOnCooldown(message.author.id, settings.cooldownMs)) return;

    const key = awayKey(message.channel.id, message.author.id);
    this.clearTimer(key);

    const scheduledAt = Date.now();
    const dueAt = scheduledAt + settings.delayMs;
    const target: AwayTarget = {
      channel: message.channel,
      channelId: message.channel.id,
      userId: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName,
      scheduledAt,
    };
    const timer = setTimeout(() => {
      void this.sendAwayMessageIfStillInactive(key, target);
    }, settings.delayMs);

    this.timers.set(key, { timer, dueAt, userId: message.author.id });
    botLogger.debug(
      {
        channelId: target.channelId,
        userId: target.userId,
        username: target.username,
        dueAt,
        delayMinutes: settings.delayMinutes,
      },
      "Scheduled away message",
    );
  }

  private clearTimer(key: string): void {
    const existing = this.timers.get(key);
    if (!existing) return;

    clearTimeout(existing.timer);
    this.timers.delete(key);
  }

  private clearTimersForUser(userId: string): void {
    for (const [key, timer] of this.timers) {
      if (timer.userId === userId) this.clearTimer(key);
    }
  }

  private async isOnCooldown(
    userId: string,
    cooldownMs: number,
  ): Promise<boolean> {
    const lastSentAt = await configManager.getAwayLastSentAt(userId);
    return lastSentAt !== null && Date.now() - lastSentAt < cooldownMs;
  }

  private async sendAwayMessageIfStillInactive(
    key: string,
    target: AwayTarget,
  ): Promise<void> {
    this.timers.delete(key);

    try {
      const settings = configManager.getAwaySettings();
      if (!settings.globalEnabled) return;
      if (!(await configManager.isAwayEnabledForUser(target.userId))) return;
      if (await this.isOnCooldown(target.userId, settings.cooldownMs)) return;

      if (!this.isStillAway(target, settings.delayMs)) {
        botLogger.debug(
          {
            channelId: target.channelId,
            userId: target.userId,
            username: target.username,
          },
          "Skipped away message because activity resumed",
        );
        return;
      }

      const generated = await this.generateAwayMessage(target);
      if (!generated) return;

      const chunks = splitMessage(
        `<@${target.userId}> ${generated}`,
        AWAY_MESSAGE_MAX_LENGTH + 32,
      );
      const firstChunk = chunks[0];
      if (!firstChunk || !("send" in target.channel)) return;

      await target.channel.send({
        content: firstChunk,
        allowedMentions: { users: [target.userId] },
      });
      await configManager.setAwayLastSentAt(target.userId, Date.now());

      botLogger.info(
        {
          channelId: target.channelId,
          userId: target.userId,
          username: target.username,
        },
        "Sent away message",
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
        "Failed to send away message",
      );
    }
  }

  private isStillAway(target: AwayTarget, delayMs: number): boolean {
    const now = Date.now();
    const lastUserActivity = this.lastUserActivityAt.get(target.userId) ?? 0;
    const lastChannelActivity =
      this.lastChannelActivityAt.get(target.channelId) ?? 0;

    if (lastUserActivity > target.scheduledAt) return false;
    if (lastChannelActivity > target.scheduledAt) return false;

    return now - lastUserActivity >= delayMs && now - lastChannelActivity >= delayMs;
  }

  private async generateAwayMessage(target: AwayTarget): Promise<string | null> {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      AWAY_MESSAGE_GENERATION_TIMEOUT_MS,
    );

    try {
      const [dynamicContext, recentHistory] = await Promise.all([
        conversationContext.buildDynamicContext(
          target.username,
          target.channelId,
          await this.fetchRecentChannelHistory(target),
        ),
        this.fetchPersistedConversationSnippet(target.channelId),
      ]);
      const prompt = [
        dynamicContext,
        recentHistory,
        `<instructions>\n${AWAY_MESSAGE_INSTRUCTIONS}\nTarget user display name: ${target.displayName}\n</instructions>`,
      ]
        .filter((section) => section.length > 0)
        .join("\n\n");

      const agent = new Agent({
        name: "Ruyi Away Message",
        instructions: systemPrompt,
        model: agentsRuntimeManager.model,
        modelSettings: agentsRuntimeManager.modelSettings,
        tools: [],
      });
      const runner = agentsRuntimeManager.getRunner();
      const result = await runner.run(agent, prompt, {
        maxTurns: 1,
        signal: abortController.signal,
      });
      const finalOutput = result.finalOutput;
      const content =
        typeof finalOutput === "string" ? sanitizeAwayMessage(finalOutput) : "";

      return content.length > 0 ? content : null;
    } catch (error) {
      aiLogger.warn(
        {
          error: (error as Error).message,
          name: (error as Error).name,
          channelId: target.channelId,
          username: target.username,
        },
        "Away message generation failed",
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchRecentChannelHistory(
    target: AwayTarget,
  ): Promise<ChatMessage[]> {
    if (!("messages" in target.channel)) return [];

    try {
      const messages = await target.channel.messages.fetch({ limit: 20 });
      return [...messages.values()].reverse().map((message) => ({
        author: message.author.username,
        content: formatMessageForAI(message),
        isBot: message.author.bot,
      }));
    } catch (error) {
      botLogger.debug(
        {
          error: (error as Error).message,
          channelId: target.channelId,
          userId: target.userId,
        },
        "Could not fetch live history for away message",
      );
      return [];
    }
  }

  private async fetchPersistedConversationSnippet(
    channelId: string,
  ): Promise<string> {
    try {
      const conversation = await Conversation.findOne({ channelId });
      const messages = conversation?.messages.slice(-12) ?? [];
      if (messages.length === 0) return "";

      const lines = messages.map(
        (message) => `${message.author}: ${message.content}`,
      );
      return `Recent archived conversation:\n${lines.join("\n")}`;
    } catch (error) {
      botLogger.debug(
        { error: (error as Error).message, channelId },
        "Could not fetch archived history for away message",
      );
      return "";
    }
  }
}

export const awayMessageService = new AwayMessageService();
