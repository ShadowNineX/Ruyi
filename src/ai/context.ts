import { DateTime } from "luxon";
import { Conversation, Memory } from "../db/models";
import type { IMemory } from "../db/models/Memory";
import { aiLogger } from "../logger";
import {
  AUTO_EXTRACT_COOLDOWN_MS,
  AUTO_EXTRACT_THRESHOLD,
  GLOBAL_CONTEXT_LIMIT,
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

export class ConversationContext {
  private readonly lastInteractionCache = new Map<string, number>();
  // Per (channelId, username) counters for auto-extraction
  private readonly userMessageCounters = new Map<string, number>();
  private readonly lastExtractionAt = new Map<string, number>();

  private userKey(channelId: string, username: string): string {
    return `${channelId}::${username}`;
  }

  async rememberMessage(
    channelId: string,
    author: string,
    content: string,
    isBot: boolean,
    messageId?: string,
  ): Promise<void> {
    try {
      await Conversation.updateOne(
        { channelId },
        {
          $push: {
            messages: {
              $each: [
                { messageId, author, content, isBot, timestamp: new Date() },
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

  async getMemoryContext(channelId: string, limit = 20): Promise<string> {
    try {
      const conversation = await Conversation.findOne({ channelId });
      if (!conversation || conversation.messages.length === 0) return "";

      const recent = conversation.messages.slice(-limit);
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

  /**
   * Track a non-bot user message and report whether auto-extraction should
   * fire now. Caller is responsible for invoking the extractor and then
   * calling `markExtracted` on success.
   */
  trackUserMessage(
    channelId: string,
    username: string,
  ): { shouldExtract: boolean } {
    const key = this.userKey(channelId, username);
    const next = (this.userMessageCounters.get(key) ?? 0) + 1;
    this.userMessageCounters.set(key, next);

    if (next < AUTO_EXTRACT_THRESHOLD) return { shouldExtract: false };

    const last = this.lastExtractionAt.get(key) ?? 0;
    if (Date.now() - last < AUTO_EXTRACT_COOLDOWN_MS) {
      return { shouldExtract: false };
    }

    return { shouldExtract: true };
  }

  markExtracted(channelId: string, username: string): void {
    const key = this.userKey(channelId, username);
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
   * Tiered user memory context:
   *   1. Pinned facts about the current user (always loaded)
   *   2. Pinned global facts
   *   3. Recently-updated user memories (auto + manual, non-pinned)
   *   4. Recent global memories
   */
  async fetchUserMemories(username: string): Promise<string> {
    try {
      const [pinnedUser, pinnedGlobal, recentUser, recentGlobal] =
        await Promise.all([
          Memory.find({ scope: "user", username, pinned: true })
            .sort({ updatedAt: -1 })
            .limit(PINNED_CONTEXT_LIMIT),
          Memory.find({ scope: "global", pinned: true })
            .sort({ updatedAt: -1 })
            .limit(PINNED_CONTEXT_LIMIT),
          Memory.find({ scope: "user", username, pinned: false })
            .sort({ updatedAt: -1 })
            .limit(RECENT_USER_MEMORY_LIMIT),
          Memory.find({ scope: "global", pinned: false })
            .sort({ updatedAt: -1 })
            .limit(GLOBAL_CONTEXT_LIMIT),
        ]);

      const lines: string[] = [
        ...this.formatMemorySection(
          `Pinned facts about ${username} (always relevant, treat as core persona context):`,
          pinnedUser,
        ),
        ...this.formatMemorySection("Pinned global facts:", pinnedGlobal),
        ...this.formatMemorySection(
          `Recent memories about ${username}:`,
          recentUser,
        ),
        ...this.formatMemorySection("Recent global memories:", recentGlobal),
      ];

      if (lines.length === 0) return "";

      aiLogger.debug(
        {
          username,
          pinnedUser: pinnedUser.length,
          pinnedGlobal: pinnedGlobal.length,
          recentUser: recentUser.length,
          recentGlobal: recentGlobal.length,
        },
        "Fetched memories for context",
      );

      return "\n\n" + lines.join("\n");
    } catch (error) {
      aiLogger.error({ error }, "Failed to fetch user memories");
      return "";
    }
  }

  buildConversationHistory(chatHistory: ChatMessage[]): string {
    // The persistent CopilotSession already retains every turn we sent it,
    // so we deliberately do NOT re-inject the bot's own past replies here.
    // We only surface:
    //   - the reply chain the user explicitly cited (might be older or
    //     external messages the session has not seen)
    //   - recent ambient channel activity from other humans (the session
    //     never saw these because the bot didn't reply to them)
    const replyChain = chatHistory.filter((m) => m.isReplyContext && !m.isBot);
    const ambient = chatHistory.filter((m) => !m.isReplyContext && !m.isBot);

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

    return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
  }

  async buildDynamicContext(
    username: string,
    channelId: string,
    chatHistory: ChatMessage[],
  ): Promise<string> {
    const historyContext = this.buildConversationHistory(chatHistory);
    const memoryContext = await this.fetchUserMemories(username);
    const currentTime = DateTime.now().toUnixInteger();
    const isOngoing = this.isOngoingConversation(channelId);

    const contextLines = [
      `<context>`,
      `Current user: ${username}`,
      `CURRENT TIME: Unix ${currentTime} — Use <t:${currentTime}:t> for time, <t:${currentTime}:F> for full datetime, <t:${currentTime}:R> for relative`,
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
