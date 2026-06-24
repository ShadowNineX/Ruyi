import type { ConfigScope } from '../config';
import type { IMemory } from '../db/models/memory';
import type { RuyiUserIdentity, UserSurface } from '../utils/user-identity';
import type { AssistantPersonality } from './prompt';
import {
  AUTO_EXTRACT_COOLDOWN_MS,
  AUTO_EXTRACT_THRESHOLD,
  CHANNEL_SUMMARY_CONTEXT_MAX_LEN,
  ONGOING_CONVERSATION_WINDOW_MS,
  PINNED_CONTEXT_LIMIT,
  RECENT_USER_MEMORY_LIMIT,
  STEAM_PROFILE_COMMENT_MAX_LENGTH,
  USER_MEMORY_CAP,
} from '../constants';
import {
  DiscordAgentSession,
  DiscordConversation,
  Memory,
  SteamAgentSession,
  SteamConversation,
} from '../db/models';
import { aiLogger } from '../logger';
import { STEAM_PROFILE_COMMENT_SAFE_BBCODE_GUIDE } from '../steam/comment-format';
import {
  getLastExtractionAt,
  getLastInteractionAt,
  incrementUserMessageCount,
  resetUserMessageCount,
  setLastExtractionAt,
  setLastInteractionAt,
} from '../stores';
import {
  buildUserMemoryFilter,
  formatUserMemoryContext,
} from '../utils/memory-scope';
import {
  buildCurrentTemporalContext,
  formatTemporalContext,
  resolveTimeZone,
} from '../utils/natural-time';
import { buildDiscordUserIdentity } from '../utils/user-identity';

export type ConversationSurface = UserSurface;

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

interface DynamicContextOptions {
  includeConversationSummary?: boolean;
  surface?: ConversationSurface;
  identity?: RuyiUserIdentity | null;
  surfaceLabel?: string;
  steamAccountId?: string | null;
  personality?: AssistantPersonality;
}

interface ConversationMemoryMessage {
  author: string;
  content: string;
  isBot: boolean;
}

class ConversationContext {
  private conversationKey(
    surface: ConversationSurface,
    conversationId: string,
    steamAccountId?: string | null,
  ): string {
    if (surface === 'steam') {
      return `steam:${steamAccountId ?? 'unknown'}:${conversationId}`;
    }
    return `${surface}:${conversationId}`;
  }

  private userKey(
    surface: ConversationSurface,
    conversationId: string,
    personId: string,
    steamAccountId?: string | null,
  ): string {
    return `${this.conversationKey(surface, conversationId, steamAccountId)}::${personId}`;
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
        'Skipping bot message for human Discord conversation archive',
      );
      return;
    }

    try {
      const existingResult = await DiscordConversation.updateOne(
        { channelId, 'messages.messageId': messageId },
        {
          $set: {
            'messages.$.author': author,
            'messages.$.content': content,
            'messages.$.isBot': isBot,
          },
        },
      );
      if (existingResult.matchedCount > 0) {
        setLastInteractionAt(
          this.conversationKey('discord', channelId),
          Date.now(),
        );
        return;
      }

      await DiscordConversation.updateOne(
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
      setLastInteractionAt(
        this.conversationKey('discord', channelId),
        Date.now(),
      );
    } catch (error) {
      aiLogger.error({ error }, 'Failed to save Discord message to memory');
    }
  }

  async rememberSteamMessage(args: {
    accountId: string;
    profileId: string;
    authorSteamId: string;
    authorName: string;
    content: string;
    isBot: boolean;
    commentId: string;
    timestamp?: Date;
  }): Promise<void> {
    try {
      await SteamConversation.updateOne(
        {
          'accountId': args.accountId,
          'profileId': args.profileId,
          'messages.commentId': args.commentId,
        },
        {
          $set: {
            'messages.$.authorSteamId': args.authorSteamId,
            'messages.$.authorName': args.authorName,
            'messages.$.content': args.content,
            'messages.$.isBot': args.isBot,
          },
        },
      ).then(async (result) => {
        if (result.matchedCount > 0) { return; }
        await SteamConversation.updateOne(
          { accountId: args.accountId, profileId: args.profileId },
          {
            $push: {
              messages: {
                $each: [
                  {
                    commentId: args.commentId,
                    profileId: args.profileId,
                    authorSteamId: args.authorSteamId,
                    authorName: args.authorName,
                    content: args.content,
                    isBot: args.isBot,
                    timestamp: args.timestamp ?? new Date(),
                  },
                ],
                $slice: -100,
              },
            },
            $set: {
              accountId: args.accountId,
              lastInteraction: new Date(),
            },
          },
          { upsert: true },
        );
      });

      setLastInteractionAt(
        this.conversationKey('steam', args.profileId, args.accountId),
        Date.now(),
      );
    } catch (error) {
      aiLogger.error(
        {
          accountId: args.accountId,
          error,
          profileId: args.profileId,
          commentId: args.commentId,
        },
        'Failed to save Steam comment to memory',
      );
    }
  }

  async updateMessageContent(
    channelId: string,
    messageId: string,
    author: string,
    content: string,
  ): Promise<ConversationMessageUpdateResult> {
    try {
      const conversation = await DiscordConversation.findOne(
        { channelId, 'messages.messageId': messageId },
        { 'messages.$': 1 },
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

      await DiscordConversation.updateOne(
        { channelId, 'messages.messageId': messageId },
        {
          $set: {
            'messages.$.author': author,
            'messages.$.content': content,
            'messages.$.isBot': false,
            'messages.$.editedAt': new Date(),
            'lastInteraction': new Date(),
          },
          $inc: { 'messages.$.editCount': 1 },
        },
      );
      setLastInteractionAt(
        this.conversationKey('discord', channelId),
        Date.now(),
      );

      return {
        found: true,
        changed: true,
        oldContent: archivedMessage.content,
        newContent: content,
      };
    } catch (error) {
      aiLogger.error(
        { error, channelId, messageId },
        'Failed to update archived Discord message content',
      );
      return {
        found: false,
        changed: false,
        oldContent: null,
        newContent: content,
      };
    }
  }

  async getMemoryContext(
    conversationId: string,
    limit = 20,
    surface: ConversationSurface = 'discord',
    steamAccountId?: string | null,
  ): Promise<string> {
    try {
      const messages = await this.fetchConversationMessages(
        surface,
        conversationId,
        steamAccountId,
      );
      if (messages.length === 0) { return ''; }

      return messages
        .filter(message => !message.isBot)
        .slice(-limit)
        .map(message => `${message.author}: ${message.content}`)
        .join('\n');
    } catch (error) {
      aiLogger.error(
        { error, surface, conversationId },
        'Failed to get memory context',
      );
      return '';
    }
  }

  isOngoingConversation(
    conversationId: string,
    surface: ConversationSurface = 'discord',
    steamAccountId?: string | null,
  ): boolean {
    const lastTime = getLastInteractionAt(
      this.conversationKey(surface, conversationId, steamAccountId),
    );
    if (!lastTime) { return false; }
    return Date.now() - lastTime < ONGOING_CONVERSATION_WINDOW_MS;
  }

  trackUserMessage(
    conversationId: string,
    identity: RuyiUserIdentity,
    surface: ConversationSurface = 'discord',
    steamAccountId?: string | null,
  ): { shouldExtract: boolean } {
    if (!identity.canWriteMemory) { return { shouldExtract: false }; }

    const key = this.userKey(
      surface,
      conversationId,
      identity.personId,
      steamAccountId,
    );
    const next = incrementUserMessageCount(key);

    if (next < AUTO_EXTRACT_THRESHOLD) { return { shouldExtract: false }; }

    const last = getLastExtractionAt(key);
    if (Date.now() - last < AUTO_EXTRACT_COOLDOWN_MS) {
      return { shouldExtract: false };
    }

    return { shouldExtract: true };
  }

  markExtracted(
    conversationId: string,
    identity: RuyiUserIdentity,
    surface: ConversationSurface = 'discord',
    steamAccountId?: string | null,
  ): void {
    const key = this.userKey(
      surface,
      conversationId,
      identity.personId,
      steamAccountId,
    );
    resetUserMessageCount(key);
    setLastExtractionAt(key, Date.now());
  }

  async loadLastInteractions(): Promise<void> {
    try {
      const [discordConversations, steamConversations] = await Promise.all([
        DiscordConversation.find({}, { channelId: 1, lastInteraction: 1 }),
        SteamConversation.find({}, { accountId: 1, profileId: 1, lastInteraction: 1 }),
      ]);

      for (const conversation of discordConversations) {
        if (!conversation.lastInteraction) { continue; }
        setLastInteractionAt(
          this.conversationKey('discord', conversation.channelId),
          conversation.lastInteraction.getTime(),
        );
      }

      for (const conversation of steamConversations) {
        if (!conversation.lastInteraction) { continue; }
        setLastInteractionAt(
          this.conversationKey(
            'steam',
            conversation.profileId,
            conversation.accountId,
          ),
          conversation.lastInteraction.getTime(),
        );
      }

      aiLogger.info(
        {
          discord: discordConversations.length,
          steam: steamConversations.length,
        },
        'Loaded last interaction times',
      );
    } catch (error) {
      aiLogger.error({ error }, 'Failed to load last interactions');
    }
  }

  private formatMemorySection(
    title: string,
    memories: Pick<IMemory, 'key' | 'value'>[],
  ): string[] {
    if (memories.length === 0) { return []; }
    const lines = [title];
    for (const memory of memories) {
      lines.push(`  - ${memory.key}: ${memory.value}`);
    }
    return lines;
  }

  async fetchUserMemories(identity: RuyiUserIdentity | null): Promise<string> {
    try {
      if (!identity) { return ''; }

      const userFilter = buildUserMemoryFilter(identity);
      const [pinnedUser, recentUser] = await Promise.all([
        Memory.find({ ...userFilter, pinned: true })
          .sort({ updatedAt: -1 })
          .limit(PINNED_CONTEXT_LIMIT),
        Memory.find({ ...userFilter, pinned: false })
          .sort({ updatedAt: -1 })
          .limit(RECENT_USER_MEMORY_LIMIT),
      ]);

      const label = formatUserMemoryContext(identity);
      const lines: string[] = [
        ...this.formatMemorySection(
          `Pinned facts about ${label} (always relevant, treat as core persona context):`,
          pinnedUser,
        ),
        ...this.formatMemorySection(
          `Recent memories about ${label}:`,
          recentUser,
        ),
      ];

      if (lines.length === 0) { return ''; }

      aiLogger.debug(
        {
          username: identity.username,
          personId: identity.personId,
          pinnedUser: pinnedUser.length,
          recentUser: recentUser.length,
        },
        'Fetched memories for context',
      );

      return `\n\n${lines.join('\n')}`;
    } catch (error) {
      aiLogger.error({ error }, 'Failed to fetch user memories');
      return '';
    }
  }

  async fetchConversationSummary(
    conversationId: string,
    surface: ConversationSurface = 'discord',
    steamAccountId?: string | null,
  ): Promise<string> {
    try {
      const session
        = surface === 'discord'
          ? await DiscordAgentSession.findOne(
              {
                channelId: conversationId,
                isActive: true,
                provider: 'openai-agents',
              },
              { summary: 1, _id: 0 },
            )
          : await SteamAgentSession.findOne(
              {
                accountId: steamAccountId ?? '',
                profileId: conversationId,
                isActive: true,
                provider: 'openai-agents',
              },
              { summary: 1, _id: 0 },
            );
      const summary = session?.summary?.trim();
      if (!summary) { return ''; }

      const label = surface === 'discord' ? 'Channel' : 'Steam profile';
      return `\n\n${label} summary (compacted older context):\n${summary.slice(
        0,
        CHANNEL_SUMMARY_CONTEXT_MAX_LEN,
      )}`;
    } catch (error) {
      aiLogger.error(
        { error, surface, conversationId },
        'Failed to fetch conversation summary',
      );
      return '';
    }
  }

  private resolveMemoryTimeZone(
    memory: Pick<IMemory, 'key' | 'value'>,
  ): { timeZone: string; source: string } | null {
    const key = memory.key.toLowerCase();
    const value = memory.value.trim();
    if (!value) { return null; }

    const timezoneKeys = new Set(['timezone', 'time_zone', 'iana_timezone']);
    const locationKeys = new Set(['location', 'lives_in', 'city', 'country']);
    if (timezoneKeys.has(key)) {
      const resolution = resolveTimeZone(value, value);
      return resolution.source === 'default'
        ? null
        : { timeZone: resolution.timeZone, source: memory.key };
    }
    if (locationKeys.has(key)) {
      const resolution = resolveTimeZone(null, value);
      return resolution.source === 'default'
        ? null
        : { timeZone: resolution.timeZone, source: memory.key };
    }

    return null;
  }

  async fetchUserTimeZone(
    identity: RuyiUserIdentity | null,
  ): Promise<{ timeZone: string; source: string } | null> {
    try {
      if (!identity) { return null; }
      const memories = await Memory.find(buildUserMemoryFilter(identity), {
        key: 1,
        value: 1,
        _id: 0,
      })
        .sort({ pinned: -1, updatedAt: -1 })
        .limit(USER_MEMORY_CAP);

      for (const memory of memories) {
        const resolved = this.resolveMemoryTimeZone(memory);
        if (resolved) { return resolved; }
      }

      return null;
    } catch (error) {
      aiLogger.error(
        { error, username: identity?.username },
        'Failed to fetch user timezone',
      );
      return null;
    }
  }

  buildConversationHistory(
    chatHistory: ChatMessage[],
    surface: ConversationSurface = 'discord',
  ): string {
    const replyChain = chatHistory.filter(
      message => message.isReplyContext && !message.isBot,
    );
    const ambient = chatHistory.filter(
      message => !message.isReplyContext && !message.isBot,
    );
    const visibleBotReplies = chatHistory.filter(
      message => !message.isReplyContext && message.isBot,
    );

    const sections: string[] = [];

    if (replyChain.length > 0) {
      const lines = replyChain
        .slice(-10)
        .map(message => `${message.author}: ${message.content}`)
        .join('\n');
      sections.push(
        `Reply context (the message thread the user is referring to):\n${lines}`,
      );
    }

    if (ambient.length > 0) {
      const label
        = surface === 'discord'
          ? 'Recent channel activity (other people talking, for situational awareness — do NOT respond to these directly unless the user asks)'
          : 'Recent Steam profile comments (public profile-comment context for situational awareness)';
      const lines = ambient
        .slice(-15)
        .map(message => `${message.author}: ${message.content}`)
        .join('\n');
      sections.push(`${label}:\n${lines}`);
    }

    if (visibleBotReplies.length > 0) {
      const lines = visibleBotReplies
        .slice(-5)
        .map(message => `${message.author}: ${message.content}`)
        .join('\n');
      sections.push(
        `Recent visible bot replies (for continuity and ambiguous follow-ups; do not repeat them):\n${lines}`,
      );
    }

    return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';
  }

  async buildDynamicContext(
    username: string,
    userId: string,
    conversationId: string,
    chatHistory: ChatMessage[],
    configScope: ConfigScope | null,
    options: DynamicContextOptions = {},
  ): Promise<string> {
    const surface = options.surface ?? 'discord';
    const steamAccountId = options.steamAccountId ?? null;
    const identity
      = options.identity ?? buildDiscordUserIdentity(userId, username);
    const historyContext = this.buildConversationHistory(chatHistory, surface);
    const [memoryContext, conversationSummary, userTimeZone]
      = await Promise.all([
        this.fetchUserMemories(identity),
        options.includeConversationSummary === false
          ? Promise.resolve('')
          : this.fetchConversationSummary(
              conversationId,
              surface,
              steamAccountId,
            ),
        this.fetchUserTimeZone(identity),
      ]);
    const temporalContext = buildCurrentTemporalContext(userTimeZone?.timeZone);
    const isOngoing = this.isOngoingConversation(
      conversationId,
      surface,
      steamAccountId,
    );
    const surfaceLabel
      = options.surfaceLabel
        ?? (surface === 'discord'
          ? 'Discord conversation'
          : 'Steam profile comments');
    const assistantName = options.personality === 'tails' ? 'Tails' : 'Ruyi';
    const assistantStyleBoundary
      = options.personality === 'tails'
        ? 'Current character voice: Tails. Reply like a clever young mechanic friend, not an assistant. Keep Steam comments short and natural; no formal lord/master/servant address from Ruyi.'
        : 'Current assistant voice: Ruyi. Keep the reply formal, deferential, warm, and in Ruyi\'s Nine Sols style.';
    const surfaceConstraints
      = surface === 'steam'
        ? `Steam profile comment constraints: keep the final reply under ${STEAM_PROFILE_COMMENT_MAX_LENGTH} characters. Use safe Steam BBCode when helpful; safe tags are ${STEAM_PROFILE_COMMENT_SAFE_BBCODE_GUIDE}. Do not use Discord Markdown or unsupported Steam tags.`
        : null;

    const contextLines = [
      `<context>`,
      `Active assistant: ${assistantName}`,
      assistantStyleBoundary,
      `Surface: ${surfaceLabel}`,
      surface === 'steam' && steamAccountId
        ? `Steam account id: ${steamAccountId}`
        : null,
      surfaceConstraints,
      `Current user: ${username}`,
      formatTemporalContext(temporalContext),
      userTimeZone
        ? `User timezone inferred from memory "${userTimeZone.source}".`
        : `User timezone memory not found; reference timezone is the bot runtime zone.`,
      configScope ? null : `No scoped config was available for this surface.`,
      conversationSummary ? `${conversationSummary}` : null,
      historyContext ? `${historyContext}` : null,
      memoryContext ? `${memoryContext}` : null,
      `</context>`,
    ]
      .filter(Boolean)
      .join('\n');

    const instructionsSection = isOngoing
      ? `\n<instructions>\nThis is a CONTINUING conversation — do NOT greet the user, just respond directly. The conversation thread you have already had with this user is preserved in your session memory; vary your wording and avoid repeating phrasings you have already used.\n</instructions>\n`
      : '';

    return `${contextLines}${instructionsSection}`;
  }

  private async fetchConversationMessages(
    surface: ConversationSurface,
    conversationId: string,
    steamAccountId?: string | null,
  ): Promise<ConversationMemoryMessage[]> {
    if (surface === 'discord') {
      const conversation = await DiscordConversation.findOne({
        channelId: conversationId,
      });
      return (
        conversation?.messages.map(message => ({
          author: message.author,
          content: message.content,
          isBot: message.isBot,
        })) ?? []
      );
    }

    const conversation = await SteamConversation.findOne({
      accountId: steamAccountId ?? '',
      profileId: conversationId,
    });
    return (
      conversation?.messages.map(message => ({
        author: message.authorName,
        content: message.content,
        isBot: message.isBot,
      })) ?? []
    );
  }
}

export const conversationContext = new ConversationContext();
