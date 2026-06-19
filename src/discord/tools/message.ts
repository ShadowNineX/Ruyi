import type { DMChannel, Message, TextBasedChannel, TextChannel } from 'discord.js';
import type { MessageMatchType, RankedMessageMatch, SearchableMessage } from '../../utils/message-search';
import type { ToolContext } from '../../utils/types';
import { tool } from '@openai/agents';
import {
  ChannelType,

  PermissionFlagsBits,

} from 'discord.js';
import { z } from 'zod';
import { toolLogger } from '../../logger';
import {

  rankMessageMatches,

  summarizeMessageSearchMatches,
} from '../../utils/message-search';
import {
  formatError,

  toolContextManager,
} from '../../utils/types';
import { messageSyncService } from '../services/message-sync';
import { requesterHasChannelPermission } from '../utils/discord-permissions';

interface ReactionInfo {
  emoji: string;
  count: number;
}

interface MessageContextItem {
  author: string;
  content: string;
  timestamp: number;
}

interface FoundMessage {
  id: string;
  author: string;
  content: string;
  timestamp: number;
  url: string;
  channel?: string;
  reactions?: ReactionInfo[];
  match_type?: MessageMatchType;
  match_score?: number;
  matched_terms?: string[];
  missing_terms?: string[];
  context_before?: MessageContextItem[];
  context_after?: MessageContextItem[];
}

type MessageHistoryChannel = TextChannel | DMChannel;

interface LiveMessageSearchDocument extends SearchableMessage {
  message: Message;
  channelName: string;
}

function hasMessageHistory(
  channel: TextBasedChannel | null,
): channel is MessageHistoryChannel {
  return Boolean(channel && 'messages' in channel);
}

function isGuildTextChannel(
  channel: TextBasedChannel | null,
): channel is TextChannel {
  return channel?.type === ChannelType.GuildText;
}

function canReadMessageHistory(channel: MessageHistoryChannel): boolean {
  return requesterHasChannelPermission(channel, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
}

function canManageMessages(channel: TextBasedChannel | null): boolean {
  return requesterHasChannelPermission(
    channel,
    PermissionFlagsBits.ManageMessages,
  );
}

// Helper: Check if author matches filter
function matchesAuthor(msg: Message, authorFilter: string): boolean {
  const authorLower = authorFilter.toLowerCase();
  return (
    msg.author.username.toLowerCase().includes(authorLower)
    || (msg.member?.displayName.toLowerCase().includes(authorLower) ?? false)
    || (msg.author.globalName?.toLowerCase().includes(authorLower) ?? false)
  );
}

// Helper: Check if content matches filter
function matchesContent(msg: Message, query: string): boolean {
  return msg.content.toLowerCase().includes(query.toLowerCase());
}

// Helper: Filter messages by author and query
function filterMessages(
  messages: Message[],
  author: string | null,
  query: string | null,
): Message[] {
  let filtered = messages;
  if (author) { filtered = filtered.filter(m => matchesAuthor(m, author)); }
  if (query) { filtered = filtered.filter(m => matchesContent(m, query)); }
  return filtered;
}

function clampLimit(
  value: number | null,
  fallback: number,
  max: number,
): number {
  return Math.min(Math.max(Math.round(value ?? fallback), 1), max);
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) { return content; }
  return `${content.slice(0, maxLength - 3)}...`;
}

function buildContextItem(message: Message): MessageContextItem {
  return {
    author: message.author.username,
    content: truncateContent(message.content, 180),
    timestamp: Math.floor(message.createdTimestamp / 1000),
  };
}

function buildLiveMessageContext(
  messages: Message[],
  messageId: string,
): Pick<FoundMessage, 'context_before' | 'context_after'> {
  const index = messages.findIndex(message => message.id === messageId);
  if (index === -1) { return {}; }

  return {
    context_before: messages
      .slice(Math.max(0, index - 2), index)
      .map(buildContextItem),
    context_after: messages.slice(index + 1, index + 3).map(buildContextItem),
  };
}

function buildLiveSearchDocument(
  message: Message,
  channelName: string,
): LiveMessageSearchDocument {
  return {
    id: message.id,
    author: message.author.username,
    content: message.content,
    timestamp: message.createdTimestamp,
    message,
    channelName,
  };
}

// Helper: Get channels to search
async function getChannelsToSearch(
  channelName: string | null,
  searchAllChannels: boolean | null,
  ctx: ToolContext,
): Promise<MessageHistoryChannel[] | string> {
  if (searchAllChannels && ctx.guild) {
    const channels = await ctx.guild.channels.fetch();
    const textChannels = channels
      .filter((c): c is TextChannel => c?.type === ChannelType.GuildText)
      .filter(canReadMessageHistory)
      .map(c => c);
    toolLogger.info(
      { channelCount: textChannels.length },
      'Searching all channels',
    );
    return textChannels;
  }

  if (channelName && ctx.guild) {
    const channels = await ctx.guild.channels.fetch();
    const targetChannel = channels.find(
      (c): c is TextChannel =>
        c?.type === ChannelType.GuildText
        && c.name.toLowerCase().includes(channelName.toLowerCase()),
    );
    if (!targetChannel) {
      return `Channel "${channelName}" not found`;
    }
    if (!canReadMessageHistory(targetChannel)) {
      return `You do not have permission to read message history in #${targetChannel.name}`;
    }
    return [targetChannel];
  }

  if (hasMessageHistory(ctx.channel)) {
    if (!canReadMessageHistory(ctx.channel)) {
      return 'You need Read Message History permission to search this channel.';
    }
    return [ctx.channel];
  }

  return 'No valid channel to search';
}

// Helper: Build a FoundMessage from a Discord message
function buildFoundMessage(
  msg: Message,
  showReactions: boolean,
  includeChannel: boolean,
  match: RankedMessageMatch<LiveMessageSearchDocument> | null,
  context: Pick<FoundMessage, 'context_before' | 'context_after'>,
  channelName?: string,
): FoundMessage {
  const result: FoundMessage = {
    id: msg.id,
    author: msg.author.username,
    content: truncateContent(msg.content, 200),
    timestamp: Math.floor(msg.createdTimestamp / 1000),
    url: msg.url,
    ...context,
  };

  if (includeChannel && channelName) {
    result.channel = channelName;
  }
  if (match) {
    result.match_type = match.matchType;
    result.match_score = Number(match.score.toFixed(3));
    if (match.matchedTerms.length > 0) {
      result.matched_terms = match.matchedTerms;
    }
    if (match.missingTerms.length > 0) {
      result.missing_terms = match.missingTerms;
    }
  }

  if (showReactions && msg.reactions.cache.size > 0) {
    result.reactions = msg.reactions.cache.map(r => ({
      emoji: r.emoji.toString(),
      count: r.count,
    }));
  }

  return result;
}

// Helper: Search a single channel and collect results
async function searchChannel(
  channel: MessageHistoryChannel,
  query: string | null,
  author: string | null,
  searchLimit: number,
  showReactions: boolean,
  includeChannel: boolean,
  existingCount: number,
): Promise<{
  messages: FoundMessage[];
  searchedMessages: number;
  summary: ReturnType<typeof summarizeMessageSearchMatches>;
}> {
  const results: FoundMessage[] = [];
  const remaining = searchLimit - existingCount;
  const emptySummary = summarizeMessageSearchMatches([]);
  if (remaining <= 0) {
    return { messages: results, searchedMessages: 0, summary: emptySummary };
  }

  const fetchLimit
    = query || author
      ? Math.min(Math.max(searchLimit * 10, 50), 100)
      : searchLimit;
  const messages = await channel.messages.fetch({ limit: fetchLimit });
  const fetchedMessages = [...messages.values()];
  const authorFiltered = author
    ? fetchedMessages.filter(message => matchesAuthor(message, author))
    : fetchedMessages;

  const displayChannel = 'name' in channel ? channel.name : 'Direct Message';
  const documents = authorFiltered.map(message =>
    buildLiveSearchDocument(message, displayChannel),
  );
  const matches = rankMessageMatches(documents, query, remaining);
  const chronologicalMessages = fetchedMessages.toSorted(
    (a, b) => a.createdTimestamp - b.createdTimestamp,
  );

  for (const match of matches) {
    const msg = match.item.message;
    results.push(
      buildFoundMessage(
        msg,
        showReactions,
        includeChannel,
        match,
        buildLiveMessageContext(chronologicalMessages, msg.id),
        displayChannel,
      ),
    );
  }

  return {
    messages: results,
    searchedMessages: fetchedMessages.length,
    summary: summarizeMessageSearchMatches(matches),
  };
}

export const searchMessagesTool = tool({
  name: 'discord_message_lookup',
  description:
    'Look up recent Discord messages for action targeting. Can inspect the current channel, a specific channel, or readable server text channels. Returns message IDs, content, reactions, and URLs. Use search_conversation for fuzzy conversation/history recall.',
  parameters: z.object({
    query: z
      .string()
      .nullable()
      .describe(
        'Text to match in recent message content. Leave null to get recent messages.',
      ),
    author: z
      .string()
      .nullable()
      .describe('Filter by author username or display name.'),
    channel_name: z
      .string()
      .nullable()
      .describe('Name of a specific channel to inspect.'),
    search_all_channels: z
      .boolean()
      .nullable()
      .describe('If true, inspect readable server text channels.'),
    limit: z
      .number()
      .nullable()
      .describe('Maximum number of messages to return (1-100, default 10).'),
    include_reactions: z
      .boolean()
      .nullable()
      .describe('Whether to include reaction details. Default true.'),
  }),
  execute: async ({
    query,
    author,
    channel_name,
    search_all_channels,
    limit,
    include_reactions,
  }) => {
    const ctx = toolContextManager.get();

    if (!ctx.guild && search_all_channels) {
      return { error: 'Cannot search all channels outside of a server' };
    }

    const searchLimit = clampLimit(limit, 10, 100);
    const showReactions = include_reactions !== false;

    try {
      const channelsResult = await getChannelsToSearch(
        channel_name,
        search_all_channels,
        ctx,
      );
      if (typeof channelsResult === 'string') {
        return { error: channelsResult };
      }

      const allResults: FoundMessage[] = [];
      const includeChannel = Boolean(search_all_channels || channel_name);
      let searchedMessageCount = 0;
      const summaries: ReturnType<typeof summarizeMessageSearchMatches>[] = [];

      for (const channel of channelsResult) {
        const channelResults = await searchChannel(
          channel,
          query,
          author,
          searchLimit,
          showReactions,
          includeChannel,
          allResults.length,
        );
        allResults.push(...channelResults.messages);
        searchedMessageCount += channelResults.searchedMessages;
        summaries.push(channelResults.summary);
        if (allResults.length >= searchLimit) { break; }
      }

      toolLogger.info(
        {
          queryLength: query?.length ?? 0,
          author,
          channel_name,
          search_all_channels,
          found: allResults.length,
          searchedMessageCount,
        },
        'Discord message lookup complete',
      );
      const exactPhraseFound = summaries.some(
        summary => summary.exactPhraseFound,
      );
      const fuzzyMatchCount = summaries.reduce(
        (total, summary) => total + summary.fuzzyMatchCount,
        0,
      );
      const partialMatchCount = summaries.reduce(
        (total, summary) => total + summary.partialMatchCount,
        0,
      );

      return {
        messages: allResults,
        total: allResults.length,
        search_summary: {
          exact_phrase_found: exactPhraseFound,
          fuzzy_match_count: fuzzyMatchCount,
          partial_match_count: partialMatchCount,
          searched_channel_count: channelsResult.length,
          searched_message_count: searchedMessageCount,
          result_limit: searchLimit,
          limitation:
            'Discord message lookup only inspects a bounded recent message window from readable channels. Use search_conversation for fuzzy history recall.',
        },
        hint:
          allResults.length > 0
            ? 'Use manage_reaction with the message ID to add/remove reactions, edit_bot_message to edit the bot\'s own messages, or delete_messages to remove them'
            : 'No messages found matching your criteria',
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { error: errorMessage },
        'Failed to look up Discord messages',
      );
      return {
        error: 'Failed to look up Discord messages',
        details: errorMessage,
      };
    }
  },
});

// Helper: Fetch messages by IDs
async function fetchMessagesByIds(
  channel: MessageHistoryChannel,
  messageIds: string[],
): Promise<Message[]> {
  const messages: Message[] = [];
  const uniqueIds = [...new Set(messageIds.map(id => id.trim()))]
    .filter(Boolean)
    .slice(0, 100);

  for (const id of uniqueIds) {
    try {
      const msg = await channel.messages.fetch(id);
      messages.push(msg);
    } catch (error) {
      toolLogger.debug(
        { messageId: id, error: formatError(error) },
        'Could not fetch message for deletion',
      );
    }
  }
  return messages;
}

async function fetchLastBotMessage(
  channel: MessageHistoryChannel,
): Promise<Message | null> {
  const botUserId = channel.client.user?.id;
  if (!botUserId) { return null; }

  const messages = await channel.messages.fetch({ limit: 50 });
  return messages.find(message => message.author.id === botUserId) ?? null;
}

async function resolveBotMessageToEdit(
  channel: MessageHistoryChannel,
  messageId: string | null,
): Promise<Message | string> {
  const normalized = messageId?.trim() || 'last';
  let targetMessage: Message | null;

  if (normalized === 'last') {
    targetMessage = await fetchLastBotMessage(channel);
  } else if (normalized === 'replied') {
    targetMessage = toolContextManager.get().referencedMessage;
  } else {
    targetMessage = await channel.messages.fetch(normalized);
  }

  if (!targetMessage) { return 'Could not find the target bot message'; }
  if (targetMessage.author.id !== channel.client.user?.id) {
    return 'I can only edit my own messages';
  }
  if (!targetMessage.editable) {
    return 'That bot message is not editable';
  }

  return targetMessage;
}

export const editBotMessageTool = tool({
  name: 'edit_bot_message',
  description:
    'Edit one of the bot\'s own previous Discord messages. Use message_id="last" or null for the latest bot message in this channel, "replied" for the message the user replied to, or a message ID from discord_message_lookup. Cannot edit user messages.',
  parameters: z.object({
    message_id: z
      .string()
      .nullable()
      .describe(
        'The bot message to edit. Use "last" or null for the latest bot message in this channel, "replied" for the message the user replied to, or an exact message ID.',
      ),
    content: z
      .string()
      .min(1)
      .max(2000)
      .describe('The new Discord message content, max 2000 characters.'),
  }),
  execute: async ({ message_id, content }) => {
    const ctx = toolContextManager.get();

    if (!hasMessageHistory(ctx.channel)) {
      return { error: 'No valid channel context for editing messages' };
    }
    if (!canManageMessages(ctx.channel)) {
      return {
        error:
          'You need Manage Messages permission in this channel to ask Ruyi to edit bot messages.',
      };
    }

    try {
      const target = await resolveBotMessageToEdit(ctx.channel, message_id);
      if (typeof target === 'string') { return { error: target }; }

      const edited = await target.edit(content);
      toolLogger.info(
        { messageId: edited.id, channelId: edited.channel.id },
        'Edited bot message',
      );

      return {
        success: true,
        action: 'edited',
        messageId: edited.id,
        messageUrl: edited.url,
        content: truncateContent(edited.content, 200),
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { error: errorMessage, message_id },
        'Failed to edit bot message',
      );
      return { error: 'Failed to edit bot message', details: errorMessage };
    }
  },
});

// Helper: Fetch and filter recent messages
async function fetchFilteredMessages(
  channel: TextChannel,
  count: number,
  author: string | null,
  contains: string | null,
): Promise<Message[]> {
  const clampedCount = clampLimit(count, 10, 100);
  const fetchCount = Math.min(clampedCount * 2, 100);
  const messages = await channel.messages.fetch({ limit: fetchCount });
  const filtered = filterMessages([...messages.values()], author, contains);
  return filtered.slice(0, clampedCount);
}

interface DeletionResult {
  count: number;
  messageIds: string[];
}

// Helper: Delete messages with bulk delete for recent, individual for old
async function performDeletion(
  channel: TextChannel,
  messages: Message[],
): Promise<DeletionResult> {
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recentMessages = messages.filter(
    m => m.createdTimestamp > twoWeeksAgo,
  );
  const oldMessages = messages.filter(m => m.createdTimestamp <= twoWeeksAgo);

  let deletedCount = 0;
  const deletedMessageIds: string[] = [];

  // Bulk delete recent messages (faster)
  if (recentMessages.length > 1) {
    const deletedMessages = await channel.bulkDelete(recentMessages);
    deletedCount += deletedMessages.size;
    deletedMessageIds.push(...deletedMessages.keys());
  } else if (recentMessages.length === 1 && recentMessages[0]) {
    await recentMessages[0].delete();
    deletedCount += 1;
    deletedMessageIds.push(recentMessages[0].id);
  }

  // Delete old messages one by one
  for (const msg of oldMessages) {
    try {
      await msg.delete();
      deletedCount++;
      deletedMessageIds.push(msg.id);
    } catch (error) {
      toolLogger.debug(
        { messageId: msg.id, error: formatError(error) },
        'Could not delete old message',
      );
    }
  }

  return {
    count: deletedCount,
    messageIds: deletedMessageIds,
  };
}

export const deleteMessagesTool = tool({
  name: 'delete_messages',
  description: `Delete messages from the current channel. Requires Manage Messages permission.

HOW TO USE:
- To clean/purge/clear a channel: Set count=100 (max) to delete recent messages. Repeat if needed.
- To delete specific messages: Provide message_ids array.
- To delete a user's messages: Set author="username" and count=50.
- To delete messages with certain text: Set contains="text" and count=50.

IMPORTANT: You MUST specify either message_ids OR count. Without count, nothing will be deleted.
For "clean this channel", "clear chat", or "delete all messages" requests, use count=100.`,
  parameters: z.object({
    message_ids: z
      .array(z.string())
      .nullable()
      .describe('Array of specific message IDs to delete.'),
    author: z
      .string()
      .nullable()
      .describe('Delete messages from this specific user.'),
    count: z
      .number()
      .nullable()
      .describe('Number of recent messages to delete (1-100).'),
    contains: z
      .string()
      .nullable()
      .describe('Only delete messages containing this text.'),
  }),
  needsApproval: true,
  execute: async ({ message_ids, author, count, contains }) => {
    const ctx = toolContextManager.get();

    if (!isGuildTextChannel(ctx.channel)) {
      return {
        error:
          'Message deletion is only available in server text channels, not private chats.',
      };
    }

    const channel = ctx.channel;
    if (!canManageMessages(channel)) {
      return {
        error:
          'You need Manage Messages permission in this channel to delete messages.',
      };
    }

    try {
      let messagesToDelete: Message[];

      if (message_ids && message_ids.length > 0) {
        messagesToDelete = await fetchMessagesByIds(channel, message_ids);
      } else if (count && count > 0) {
        messagesToDelete = await fetchFilteredMessages(
          channel,
          count,
          author,
          contains,
        );
      } else {
        return { error: 'Must specify either message_ids or count' };
      }

      if (messagesToDelete.length === 0) {
        return { error: 'No messages found matching criteria' };
      }

      const deletion = await performDeletion(channel, messagesToDelete);
      await messageSyncService.deleteMessages(channel.id, deletion.messageIds);

      toolLogger.info(
        { deletedCount: deletion.count, author, contains },
        'Messages deleted',
      );

      return {
        success: true,
        deleted: deletion.count,
        message: `Deleted ${deletion.count} message${
          deletion.count === 1 ? '' : 's'
        }`,
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error({ error: errorMessage }, 'Failed to delete messages');
      return { error: 'Failed to delete messages', details: errorMessage };
    }
  },
});
