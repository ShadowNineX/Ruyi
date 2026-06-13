import { AgentSession, Conversation, Memory } from "../db/models";
import type { IMemory } from "../db/models/memory";
import type { ConfigScope } from "../config";
import { aiLogger } from "../logger";
import {
  buildCurrentTemporalContext,
  formatTemporalContext,
  resolveTimeZone,
} from "../utils/natural-time";
import { buildUserMemoryFilter } from "../utils/memory-scope";
import {
  AUTO_EXTRACT_COOLDOWN_MS,
  AUTO_EXTRACT_THRESHOLD,
  CHANNEL_SUMMARY_CONTEXT_MAX_LEN,
  ONGOING_CONVERSATION_WINDOW_MS,
  PINNED_CONTEXT_LIMIT,
  RECENT_USER_MEMORY_LIMIT,
} from "../constants";

export interface ChatMessage {
  author: string;
  content: string;
  isBot: boolean;
  isReplyContext?: boolean;
}

interface ConversationMessageUpdateResult {
  found: boolean;
  changed: boolean;
  oldContent: string | null;
  newContent: string;
}

class ConversationContext {
  private readonly lastInteractionCache = new Map<string, number>();
  private readonly userMessageCounters = new Map<string, number>();
  private readonly lastExtractionAt = new Map<string, number>();

  private userKey(channelId: string, userId: string): string {
    return `${channelId}::${userId}`;
  }

  async rememberMessage(
    channelId: string,
    author: string,
    content: string,
    isBot: boolean,
    messageId: string,
  ): Promise<void> {
    if (isBot) {
      aiLogger.debug(
        { channelId, author, messageId },
        "Skipping bot message for human conversation archive",
      );
      return;
    }

    try {
      const existingResult = await Conversation.updateOne(
        { channelId, "messages.messageId": messageId },
        {
          $set: {
            "messages.$.author": author,
            "messages.$.content": content,
            "messages.$.isBot": isBot,
          },
        },
      );
      if (existingResult.matchedCount > 0) {
        this.lastInteractionCache.set(channelId, Date.now());
        return;
      }

      await Conversation.updateOne(
        { channelId },
        {
          $push: {
            messages: {
              $each: [
                {
                  messageId,
                  author,
                  content,
                  isBot,
                  timestamp: new Date(),
                  editedAt: null,
                  editCount: 0,
                },
              ],
              $slice: -100,
            },
          },
          $set: { lastInteraction: new Date() },
        },
        { upsert: true },
      );
      this.lastInteractionCache.set(channelId, Date.now());
    } catch (error) {
      aiLogger.error({ error }, "Failed to save message to memory");
    }
  }

  async updateMessageContent(
    channelId: string,
    messageId: string,
    author: string,
    content: string,
  ): Promise<ConversationMessageUpdateResult> {
    try {
      const conversation = await Conversation.findOne(
        { channelId, "messages.messageId": messageId },
        { "messages.$": 1 },
      );
      const archivedMessage = conversation?.messages[0];
      if (!archivedMessage) {
        return {
          found: false,
          changed: false,
          oldContent: null,
          newContent: content,
        };
      }

      if (archivedMessage.content === content) {
        return {
          found: true,
          changed: false,
          oldContent: archivedMessage.content,
          newContent: content,
        };
      }

      await Conversation.updateOne(
        { channelId, "messages.messageId": messageId },
        {
          $set: {
            "messages.$.author": author,
            "messages.$.content": content,
            "messages.$.isBot": false,
            "messages.$.editedAt": new Date(),
            lastInteraction: new Date(),
          },
          $inc: { "messages.$.editCount": 1 },
        },
      );
      this.lastInteractionCache.set(channelId, Date.now());

      return {
        found: true,
        changed: true,
        oldContent: archivedMessage.content,
        newContent: content,
      };
    } catch (error) {
      aiLogger.error(
        { error, channelId, messageId },
        "Failed to update archived message content",
      );
      return {
        found: false,
        changed: false,
        oldContent: null,
        newContent: content,
      };
    }
  }

  async getMemoryContext(channelId: string, limit = 20): Promise<string> {
    try {
      const conversation = await Conversation.findOne({ channelId });
      if (!conversation || conversation.messages.length === 0) return "";

      const recent = conversation.messages
        .filter((m) => !m.isBot)
        .slice(-limit);
      return recent.map((m) => `${m.author}: ${m.content}`).join("\n");
    } catch (error) {
      aiLogger.error({ error }, "Failed to get memory context");
      return "";
    }
  }

  isOngoingConversation(channelId: string): boolean {
    const lastTime = this.lastInteractionCache.get(channelId);
    if (!lastTime) return false;
    return Date.now() - lastTime < ONGOING_CONVERSATION_WINDOW_MS;
  }

  trackUserMessage(
    channelId: string,
    userId: string,
  ): { shouldExtract: boolean } {
    const key = this.userKey(channelId, userId);
    const next = (this.userMessageCounters.get(key) ?? 0) + 1;
    this.userMessageCounters.set(key, next);

    if (next < AUTO_EXTRACT_THRESHOLD) return { shouldExtract: false };

    const last = this.lastExtractionAt.get(key) ?? 0;
    if (Date.now() - last < AUTO_EXTRACT_COOLDOWN_MS) {
      return { shouldExtract: false };
    }

    return { shouldExtract: true };
  }

  markExtracted(channelId: string, userId: string): void {
    const key = this.userKey(channelId, userId);
    this.userMessageCounters.set(key, 0);
    this.lastExtractionAt.set(key, Date.now());
  }

  async loadLastInteractions(): Promise<void> {
    try {
      const conversations = await Conversation.find(
        {},
        { channelId: 1, lastInteraction: 1 },
      );
      for (const conv of conversations) {
        if (conv.lastInteraction) {
          this.lastInteractionCache.set(
            conv.channelId,
            conv.lastInteraction.getTime(),
          );
        }
      }
      aiLogger.info(
        { count: conversations.length },
        "Loaded last interaction times",
      );
    } catch (error) {
      aiLogger.error({ error }, "Failed to load last interactions");
    }
  }

  private formatMemorySection(
    title: string,
    memories: Pick<IMemory, "key" | "value">[],
  ): string[] {
    if (memories.length === 0) return [];
    const lines = [title];
    for (const m of memories) lines.push(`  - ${m.key}: ${m.value}`);
    return lines;
  }

  /**
   * Tiered user memory context for the current Discord scope:
   *   1. Pinned facts about the current user (always loaded)
   *   2. Recently-updated user memories (auto + manual, non-pinned)
   */
  async fetchUserMemories(
    userId: string,
    username: string,
    scope: ConfigScope | null,
  ): Promise<string> {
    try {
      if (!scope) return "";

      const userFilter = buildUserMemoryFilter(userId, scope);
      const [pinnedUser, recentUser] = await Promise.all([
        Memory.find({ ...userFilter, pinned: true })
          .sort({ updatedAt: -1 })
          .limit(PINNED_CONTEXT_LIMIT),
        Memory.find({ ...userFilter, pinned: false })
          .sort({ updatedAt: -1 })
          .limit(RECENT_USER_MEMORY_LIMIT),
      ]);

      const lines: string[] = [
        ...this.formatMemorySection(
          `Pinned facts about ${username} (always relevant, treat as core persona context):`,
          pinnedUser,
        ),
        ...this.formatMemorySection(
          `Recent memories about ${username}:`,
          recentUser,
        ),
      ];

      if (lines.length === 0) return "";

      aiLogger.debug(
        {
          username,
          pinnedUser: pinnedUser.length,
          recentUser: recentUser.length,
          scopeKind: scope?.kind,
          scopeId: scope?.id,
        },
        "Fetched memories for context",
      );

      return "\n\n" + lines.join("\n");
    } catch (error) {
      aiLogger.error({ error }, "Failed to fetch user memories");
      return "";
    }
  }

  async fetchChannelSummary(channelId: string): Promise<string> {
    try {
      const session = await AgentSession.findOne(
        {
          channelId,
          isActive: true,
          provider: "openai-agents",
        },
        { summary: 1, _id: 0 },
      );
      const summary = session?.summary?.trim();
      if (!summary) return "";

      return `\n\nChannel summary (compacted older context):\n${summary.slice(
        0,
        CHANNEL_SUMMARY_CONTEXT_MAX_LEN,
      )}`;
    } catch (error) {
      aiLogger.error({ error, channelId }, "Failed to fetch channel summary");
      return "";
    }
  }

  private resolveMemoryTimeZone(
    memory: Pick<IMemory, "key" | "value">,
  ): { timeZone: string; source: string } | null {
    const key = memory.key.toLowerCase();
    const value = memory.value.trim();
    if (!value) return null;

    const timezoneKeys = new Set(["timezone", "time_zone", "iana_timezone"]);
    const locationKeys = new Set(["location", "lives_in", "city", "country"]);
    if (timezoneKeys.has(key)) {
      const resolution = resolveTimeZone(value, value);
      return resolution.source === "default"
        ? null
        : { timeZone: resolution.timeZone, source: memory.key };
    }
    if (locationKeys.has(key)) {
      const resolution = resolveTimeZone(null, value);
      return resolution.source === "default"
        ? null
        : { timeZone: resolution.timeZone, source: memory.key };
    }

    return null;
  }

  async fetchUserTimeZone(
    userId: string,
    username: string,
    scope: ConfigScope | null,
  ): Promise<{ timeZone: string; source: string } | null> {
    try {
      if (!scope) return null;
      const memories = await Memory.find(buildUserMemoryFilter(userId, scope), {
        key: 1,
        value: 1,
        _id: 0,
      })
        .sort({ pinned: -1, updatedAt: -1 })
        .limit(30);

      for (const memory of memories) {
        const resolved = this.resolveMemoryTimeZone(memory);
        if (resolved) return resolved;
      }

      return null;
    } catch (error) {
      aiLogger.error({ error, username }, "Failed to fetch user timezone");
      return null;
    }
  }

  buildConversationHistory(chatHistory: ChatMessage[]): string {
    // The persistent AgentSession normally retains the bot's own turns.
    // We still surface a tiny slice of visible bot replies so a freshly
    // rebuilt session can recover continuity after Discord deletions.
    // We surface:
    //   - the reply chain the user explicitly cited (might be older or
    //     external messages the session has not seen)
    //   - recent ambient channel activity from other humans (the session
    //     never saw these because the bot didn't reply to them)
    //   - a few visible bot replies for ambiguous follow-ups/mention-only pings
    const replyChain = chatHistory.filter((m) => m.isReplyContext && !m.isBot);
    const ambient = chatHistory.filter((m) => !m.isReplyContext && !m.isBot);
    const visibleBotReplies = chatHistory.filter(
      (m) => !m.isReplyContext && m.isBot,
    );

    const sections: string[] = [];

    if (replyChain.length > 0) {
      const lines = replyChain
        .slice(-10)
        .map((m) => `${m.author}: ${m.content}`)
        .join("\n");
      sections.push(
        `Reply context (the message thread the user is referring to):\n${lines}`,
      );
    }

    if (ambient.length > 0) {
      const lines = ambient
        .slice(-15)
        .map((m) => `${m.author}: ${m.content}`)
        .join("\n");
      sections.push(
        `Recent channel activity (other people talking, for situational awareness — do NOT respond to these directly unless the user asks):\n${lines}`,
      );
    }

    if (visibleBotReplies.length > 0) {
      const lines = visibleBotReplies
        .slice(-5)
        .map((m) => `${m.author}: ${m.content}`)
        .join("\n");
      sections.push(
        `Recent visible bot replies (for continuity and ambiguous follow-ups; do not repeat them):\n${lines}`,
      );
    }

    return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
  }

  async buildDynamicContext(
    username: string,
    userId: string,
    channelId: string,
    chatHistory: ChatMessage[],
    configScope: ConfigScope | null,
  ): Promise<string> {
    const historyContext = this.buildConversationHistory(chatHistory);
    const [memoryContext, channelSummary, userTimeZone] = await Promise.all([
      this.fetchUserMemories(userId, username, configScope),
      this.fetchChannelSummary(channelId),
      this.fetchUserTimeZone(userId, username, configScope),
    ]);
    const temporalContext = buildCurrentTemporalContext(userTimeZone?.timeZone);
    const isOngoing = this.isOngoingConversation(channelId);

    const contextLines = [
      `<context>`,
      `Current user: ${username}`,
      formatTemporalContext(temporalContext),
      userTimeZone
        ? `User timezone inferred from memory "${userTimeZone.source}".`
        : `User timezone memory not found; reference timezone is the bot runtime zone.`,
      channelSummary ? `${channelSummary}` : null,
      historyContext ? `${historyContext}` : null,
      memoryContext ? `${memoryContext}` : null,
      `</context>`,
    ]
      .filter(Boolean)
      .join("\n");

    const instructionsSection = isOngoing
      ? `\n<instructions>\nThis is a CONTINUING conversation — do NOT greet the user, just respond directly. The conversation thread you have already had with this user is preserved in your session memory; vary your wording and avoid repeating phrasings you have already used.\n</instructions>\n`
      : "";

    return `${contextLines}${instructionsSection}`;
  }
}

export const conversationContext = new ConversationContext();
