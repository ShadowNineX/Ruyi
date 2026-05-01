import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toolLogger } from "../logger";
import { toolContextManager, type ToolContext } from "../utils/types";
import { ChannelType, TextChannel, Message } from "discord.js";

interface ReactionInfo {
  emoji: string;
  count: number;
}

interface FoundMessage {
  id: string;
  author: string;
  content: string;
  timestamp: number;
  url: string;
  channel?: string;
  reactions?: ReactionInfo[];
}

// Helper: Check if author matches filter
function matchesAuthor(msg: Message, authorFilter: string): boolean {
  const authorLower = authorFilter.toLowerCase();
  return msg.author.username.toLowerCase().includes(authorLower);
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
  if (author) filtered = filtered.filter((m) => matchesAuthor(m, author));
  if (query) filtered = filtered.filter((m) => matchesContent(m, query));
  return filtered;
}

// Helper: Get channels to search
async function getChannelsToSearch(
  channelName: string | null,
  searchAllChannels: boolean | null,
  ctx: ToolContext,
): Promise<TextChannel[] | string> {
  if (searchAllChannels && ctx.guild) {
    const channels = await ctx.guild.channels.fetch();
    const textChannels = channels
      .filter((c): c is TextChannel => c?.type === ChannelType.GuildText)
      .map((c) => c);
    toolLogger.info(
      { channelCount: textChannels.length },
      "Searching all channels",
    );
    return textChannels;
  }

  if (channelName && ctx.guild) {
    const channels = await ctx.guild.channels.fetch();
    const targetChannel = channels.find(
      (c): c is TextChannel =>
        c?.type === ChannelType.GuildText &&
        c.name.toLowerCase().includes(channelName.toLowerCase()),
    );
    if (!targetChannel) {
      return `Channel "${channelName}" not found`;
    }
    return [targetChannel];
  }

  if (ctx.channel && "messages" in ctx.channel) {
    return [ctx.channel];
  }

  return "No valid channel to search";
}

// Helper: Build a FoundMessage from a Discord message
function buildFoundMessage(
  msg: Message,
  showReactions: boolean,
  includeChannel: boolean,
  channelName?: string,
): FoundMessage {
  const result: FoundMessage = {
    id: msg.id,
    author: msg.author.username,
    content:
      msg.content.slice(0, 200) + (msg.content.length > 200 ? "..." : ""),
    timestamp: Math.floor(msg.createdTimestamp / 1000),
    url: msg.url,
  };

  if (includeChannel && channelName) {
    result.channel = channelName;
  }

  if (showReactions && msg.reactions.cache.size > 0) {
    result.reactions = msg.reactions.cache.map((r) => ({
      emoji: r.emoji.toString(),
      count: r.count,
    }));
  }

  return result;
}

// Helper: Search a single channel and collect results
async function searchChannel(
  channel: TextChannel,
  query: string | null,
  author: string | null,
  searchLimit: number,
  showReactions: boolean,
  includeChannel: boolean,
  existingCount: number,
): Promise<FoundMessage[]> {
  const results: FoundMessage[] = [];
  const remaining = searchLimit - existingCount;
  if (remaining <= 0) return results;

  const fetchLimit =
    query || author ? Math.min(searchLimit * 5, 100) : searchLimit;
  const messages = await channel.messages.fetch({ limit: fetchLimit });
  const filtered = filterMessages([...messages.values()], author, query);

  for (const msg of filtered.slice(0, remaining)) {
    results.push(
      buildFoundMessage(msg, showReactions, includeChannel, channel.name),
    );
  }

  return results;
}

export const searchMessagesTool = defineTool("search_messages", {
  description:
    "Search for messages in Discord. Can search current channel, a specific channel, or across the entire server. Returns message IDs, content, reactions, and URLs. Use the returned message ID with manage_reaction or delete_messages.",
  parameters: z.object({
    query: z
      .string()
      .nullable()
      .describe(
        "Text to search for in message content. Leave null to get recent messages.",
      ),
    author: z
      .string()
      .nullable()
      .describe("Filter by author username or display name."),
    channel_name: z
      .string()
      .nullable()
      .describe("Name of a specific channel to search in."),
    search_all_channels: z
      .boolean()
      .nullable()
      .describe("If true, search across ALL text channels."),
    limit: z
      .number()
      .nullable()
      .describe("Maximum number of messages to return (1-100, default 10)."),
    include_reactions: z
      .boolean()
      .nullable()
      .describe("Whether to include reaction details. Default true."),
  }),
  handler: async ({
    query,
    author,
    channel_name,
    search_all_channels,
    limit,
    include_reactions,
  }) => {
    const ctx = toolContextManager.get();

    if (!ctx.guild && search_all_channels) {
      return { error: "Cannot search all channels outside of a server" };
    }

    const searchLimit = Math.min(Math.max(limit ?? 10, 1), 100);
    const showReactions = include_reactions !== false;

    try {
      const channelsResult = await getChannelsToSearch(
        channel_name,
        search_all_channels,
        ctx,
      );
      if (typeof channelsResult === "string") {
        return { error: channelsResult };
      }

      const allResults: FoundMessage[] = [];
      const includeChannel = Boolean(search_all_channels || channel_name);

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
        allResults.push(...channelResults);
        if (allResults.length >= searchLimit) break;
      }

      toolLogger.info(
        {
          query,
          author,
          channel_name,
          search_all_channels,
          found: allResults.length,
        },
        "Message search complete",
      );

      return {
        messages: allResults,
        total: allResults.length,
        hint:
          allResults.length > 0
            ? "Use manage_reaction with the message ID to add/remove reactions, or delete_messages to remove them"
            : "No messages found matching your criteria",
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toolLogger.error({ error: errorMessage }, "Failed to search messages");
      return { error: "Failed to search messages", details: errorMessage };
    }
  },
});

// Helper: Fetch messages by IDs
async function fetchMessagesByIds(
  channel: TextChannel,
  messageIds: string[],
): Promise<Message[]> {
  const messages: Message[] = [];
  for (const id of messageIds.slice(0, 100)) {
    try {
      const msg = await channel.messages.fetch(id);
      messages.push(msg);
    } catch {
      // Message not found, skip
    }
  }
  return messages;
}

// Helper: Fetch and filter recent messages
async function fetchFilteredMessages(
  channel: TextChannel,
  count: number,
  author: string | null,
  contains: string | null,
): Promise<Message[]> {
  const fetchCount = Math.min(count * 2, 100);
  const messages = await channel.messages.fetch({ limit: fetchCount });
  const filtered = filterMessages([...messages.values()], author, contains);
  return filtered.slice(0, Math.min(count, 100));
}

// Helper: Delete messages with bulk delete for recent, individual for old
async function performDeletion(
  channel: TextChannel,
  messages: Message[],
): Promise<number> {
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recentMessages = messages.filter(
    (m) => m.createdTimestamp > twoWeeksAgo,
  );
  const oldMessages = messages.filter((m) => m.createdTimestamp <= twoWeeksAgo);

  let deletedCount = 0;

  // Bulk delete recent messages (faster)
  if (recentMessages.length > 1) {
    await channel.bulkDelete(recentMessages);
    deletedCount += recentMessages.length;
  } else if (recentMessages.length === 1 && recentMessages[0]) {
    await recentMessages[0].delete();
    deletedCount += 1;
  }

  // Delete old messages one by one
  for (const msg of oldMessages) {
    try {
      await msg.delete();
      deletedCount++;
    } catch {
      // Failed to delete, continue
    }
  }

  return deletedCount;
}

export const deleteMessagesTool = defineTool("delete_messages", {
  description: `Delete messages from the current channel. Requires Manage Messages permission.

HOW TO USE:
- To clean/purge a channel: Set count=100 (max) to delete recent messages. Repeat if needed.
- To delete specific messages: Provide message_ids array.
- To delete a user's messages: Set author="username" and count=50.
- To delete messages with certain text: Set contains="text" and count=50.

IMPORTANT: You MUST specify either message_ids OR count. Without count, nothing will be deleted.
For "clean this channel" or "delete all messages" requests, use count=100.`,
  parameters: z.object({
    message_ids: z
      .array(z.string())
      .nullable()
      .describe("Array of specific message IDs to delete."),
    author: z
      .string()
      .nullable()
      .describe("Delete messages from this specific user."),
    count: z
      .number()
      .nullable()
      .describe("Number of recent messages to delete (1-100)."),
    contains: z
      .string()
      .nullable()
      .describe("Only delete messages containing this text."),
  }),
  handler: async ({ message_ids, author, count, contains }) => {
    const ctx = toolContextManager.get();

    if (!ctx.channel || !("messages" in ctx.channel)) {
      return { error: "No valid channel context for message deletion" };
    }

    const channel = ctx.channel;

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
        return { error: "Must specify either message_ids or count" };
      }

      if (messagesToDelete.length === 0) {
        return { error: "No messages found matching criteria" };
      }

      const deletedCount = await performDeletion(channel, messagesToDelete);

      toolLogger.info({ deletedCount, author, contains }, "Messages deleted");

      return {
        success: true,
        deleted: deletedCount,
        message: `Deleted ${deletedCount} message${deletedCount === 1 ? "" : "s"}`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toolLogger.error({ error: errorMessage }, "Failed to delete messages");
      return { error: "Failed to delete messages", details: errorMessage };
    }
  },
});
