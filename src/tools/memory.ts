import { tool } from "@openai/agents";
import { z } from "zod";
import {
  PermissionFlagsBits,
  type Guild,
  type TextBasedChannel,
} from "discord.js";
import { toolLogger } from "../logger";
import { Memory, Conversation } from "../db/models";
import { toolContextManager, formatError } from "../utils/types";
import { requesterHasChannelPermission } from "../utils/discord-permissions";
import { getCurrentToolConfigScope } from "../utils/discord-scope";
import {
  buildUserMemoryFilter,
  formatUserMemoryContext,
  type UserMemoryFilter,
} from "../utils/memory-scope";
import {
  sanitizeMemoryKey,
  truncateMemoryValue,
} from "../utils/memory-normalization";
import { USER_MEMORY_CAP } from "../constants";

type MemorySearchFilter = Record<string, unknown>;

type MemoryOwnerFilter = UserMemoryFilter;

interface MemoryUserIdentity {
  userId: string;
  username: string;
}

interface MemoryOwnerContext {
  createdBy: string;
  filter: MemoryOwnerFilter;
  label: string;
  limit: number;
  username: string | null;
}

// Get the actual Discord user identity from context - don't trust model parameters.
function getContextUserIdentity(): MemoryUserIdentity | null {
  const ctx = toolContextManager.get();
  const author = ctx.message?.author;
  return author ? { userId: author.id, username: author.username } : null;
}

function normalizeMemoryKey(key: string | null): string | null {
  const sanitized = sanitizeMemoryKey(key ?? "");
  return sanitized || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function resolveMemoryOwner(
  user: MemoryUserIdentity | null,
): MemoryOwnerContext | string {
  if (!user) {
    return "Discord user context required for memories";
  }

  const { guild } = toolContextManager.get();
  const scope = getCurrentToolConfigScope();
  if (!scope) {
    return "Discord scope required for memories";
  }

  return {
    createdBy: user.username,
    filter: buildUserMemoryFilter(user.userId, scope),
    label: formatUserMemoryContext(user.username, scope, guild?.name),
    limit: USER_MEMORY_CAP,
    username: user.username,
  };
}

function buildMemoryKeyFilter(
  key: string,
  user: MemoryUserIdentity | null,
): ({ key: string } & MemoryOwnerFilter) | string {
  const owner = resolveMemoryOwner(user);
  return typeof owner === "string" ? owner : { key, ...owner.filter };
}

async function evictMemoryIfNeeded(
  owner: MemoryOwnerContext,
  existing: unknown,
): Promise<string | null> {
  if (existing || (await Memory.countDocuments(owner.filter)) < owner.limit) {
    return null;
  }

  // Evict oldest non-pinned entry first; pinned entries are protected.
  const oldest = await Memory.findOne({ ...owner.filter, pinned: false }).sort({
    updatedAt: 1,
  });
  if (!oldest) {
    return `Memory cap reached for ${owner.filter.scope}. Unpin or delete an existing memory before saving more.`;
  }

  await oldest.deleteOne();
  return null;
}

// Extracted action handlers for memoryStoreTool
async function handleSaveMemory(
  key: string | null,
  value: string | null,
  user: MemoryUserIdentity | null,
  pinned: boolean,
) {
  const normalizedKey = normalizeMemoryKey(key);
  const normalizedValue = value?.trim() ?? "";

  if (!normalizedKey || !normalizedValue) {
    return { error: "Key and value are required for save" };
  }

  const truncatedValue = truncateMemoryValue(normalizedValue);
  const owner = resolveMemoryOwner(user);
  if (typeof owner === "string") {
    return { error: owner };
  }
  const filter = { key: normalizedKey, ...owner.filter };
  const existing = await Memory.findOne(filter);
  const evictionError = await evictMemoryIfNeeded(owner, existing);
  if (evictionError) {
    return { error: evictionError };
  }

  await Memory.updateOne(
    filter,
    {
      key: normalizedKey,
      value: truncatedValue,
      scope: owner.filter.scope,
      scopeKind: owner.filter.scopeKind,
      scopeId: owner.filter.scopeId,
      userId: owner.filter.userId,
      username: owner.username,
      createdBy: owner.createdBy,
      pinned,
      source: "user",
    },
    { upsert: true },
  );

  return {
    success: true,
    message: `${pinned ? "Pinned" : "Remembered"} "${normalizedKey}" for ${owner.label}`,
  };
}

async function handlePinMemory(
  key: string | null,
  user: MemoryUserIdentity | null,
  pinned: boolean,
) {
  const normalizedKey = normalizeMemoryKey(key);
  if (!normalizedKey) return { error: "Key is required" };
  const filter = buildMemoryKeyFilter(normalizedKey, user);
  if (typeof filter === "string") {
    return { error: filter };
  }
  const result = await Memory.updateOne(filter, { $set: { pinned } });
  if (result.matchedCount === 0) {
    return {
      success: false,
      message: `No memory found for "${normalizedKey}"`,
    };
  }
  return {
    success: true,
    message: `${pinned ? "Pinned" : "Unpinned"} "${normalizedKey}"`,
  };
}

async function handleGetMemory(
  key: string | null,
  user: MemoryUserIdentity | null,
) {
  const normalizedKey = normalizeMemoryKey(key);
  if (!normalizedKey) {
    return { error: "Key is required for get" };
  }
  const query = buildMemoryKeyFilter(normalizedKey, user);
  if (typeof query === "string") {
    return { error: query };
  }
  const item = await Memory.findOne(query);

  if (!item) {
    return { found: false, message: `No memory found for "${normalizedKey}"` };
  }

  return {
    found: true,
    key: item.key,
    value: item.value,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
  };
}

async function handleDeleteMemory(
  key: string | null,
  user: MemoryUserIdentity | null,
) {
  const normalizedKey = normalizeMemoryKey(key);
  if (!normalizedKey) {
    return { error: "Key is required for delete" };
  }
  const query = buildMemoryKeyFilter(normalizedKey, user);
  if (typeof query === "string") {
    return { error: query };
  }
  const result = await Memory.deleteOne(query);

  if (result.deletedCount > 0) {
    return { success: true, message: `Forgot "${normalizedKey}"` };
  }
  return { success: false, message: `No memory found for "${normalizedKey}"` };
}

async function handleListMemories(
  user: MemoryUserIdentity | null,
) {
  const owner = resolveMemoryOwner(user);
  if (typeof owner === "string") {
    return { error: owner };
  }

  const memories: {
    key: string;
    value: string;
    createdBy: string;
    pinned: boolean;
    source: string;
  }[] = [];

  const storedMemories = await Memory.find(owner.filter).sort({
    pinned: -1,
    updatedAt: -1,
  });
  for (const m of storedMemories) {
    memories.push({
      key: m.key,
      value: m.value,
      createdBy: m.createdBy,
      pinned: m.pinned,
      source: m.source,
    });
  }

  return { count: memories.length, context: owner.label, memories };
}

export const memoryStoreTool = tool({
  name: "memory_store",
  description:
    "Store, retrieve, pin, or delete memories. PINNED memories are always loaded into context (treat them as the user's persona/core facts). Use 'pin' to mark an existing memory as pinned, 'unpin' to remove that flag. The Discord user is automatically detected.",
  parameters: z.object({
    action: z
      .enum(["save", "get", "delete", "list", "pin", "unpin"])
      .describe("The action to perform."),
    key: z
      .string()
      .nullable()
      .describe(
        "A short identifier/name for the memory (e.g. 'name', 'lastfm_username').",
      ),
    value: z
      .string()
      .nullable()
      .describe("The information to remember (e.g. 'Alexander', 'shadow123')."),
    pinned: z
      .boolean()
      .nullable()
      .describe(
        "For 'save': whether to pin the memory so it always appears in context. Defaults to false.",
      ),
  }),
  execute: async ({ action, key, value, pinned }) => {
    const user = getContextUserIdentity();
    toolLogger.info(
      {
        action,
        key,
        userId: user?.userId,
        username: user?.username,
        pinned,
      },
      "Memory store operation",
    );

    try {
      switch (action) {
        case "save":
          return await handleSaveMemory(
            key,
            value,
            user,
            pinned ?? false,
          );
        case "get":
          return await handleGetMemory(key, user);
        case "delete":
          return await handleDeleteMemory(key, user);
        case "list":
          return await handleListMemories(user);
        case "pin":
          return await handlePinMemory(key, user, true);
        case "unpin":
          return await handlePinMemory(key, user, false);
        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { error: errorMessage },
        "Memory store operation failed",
      );
      return { error: errorMessage };
    }
  },
});

// Helper to collect memories with length limit
function collectMemoryLines(
  memories: Array<{ key: string; value: string; pinned?: boolean }>,
  header: string,
  currentLength: number,
  maxLength: number,
): { lines: string[]; newLength: number } {
  const lines: string[] = [];
  let length = currentLength;

  if (memories.length === 0) {
    return { lines, newLength: length };
  }

  lines.push(header);
  length += header.length;
  for (const m of memories) {
    const marker = m.pinned ? "[PINNED] " : "";
    const line = `• ${marker}${m.key}: ${m.value}`;
    if (length + line.length > maxLength) {
      lines.push("... (truncated)");
      break;
    }
    lines.push(line);
    length += line.length;
  }

  return { lines, newLength: length };
}

export const memoryRecallTool = tool({
  name: "memory_recall",
  description:
    "Recall stored memories for the current Discord context and current user. Discord context and user identity are automatically detected.",
  parameters: z.object({}),
  execute: async () => {
    const user = getContextUserIdentity();
    toolLogger.info(
      { userId: user?.userId, username: user?.username },
      "Recalling memories",
    );

    const maxTotalLength = 2000;
    const allLines: string[] = [];
    const owner = resolveMemoryOwner(user);
    if (typeof owner === "string") {
      return { error: owner };
    }

    const userMemories = await Memory.find(owner.filter).sort({
      pinned: -1,
      updatedAt: -1,
    });
    const { lines } = collectMemoryLines(
      userMemories,
      `=== Memories for ${owner.label} ===`,
      0,
      maxTotalLength,
    );
    allLines.push(...lines);

    if (allLines.length === 0) {
      return { hasMemories: false, message: "No memories stored yet." };
    }

    const result = { hasMemories: true, summary: allLines.join("\n") };
    toolLogger.info(
      {
        userId: user?.userId,
        username: user?.username,
        lineCount: allLines.length,
      },
      "Memory recall complete",
    );
    return result;
  },
});

export const searchMemoryTool = tool({
  name: "search_memory",
  description:
    "Search through stored memories by keyword. Searches current user's memories by default.",
  parameters: z.object({
    query: z
      .string()
      .describe("Search query to find in memory keys and values."),
  }),
  execute: async ({ query }) => {
    const user = getContextUserIdentity();
    toolLogger.info(
      { query, userId: user?.userId, username: user?.username },
      "Searching memories",
    );

    try {
      const regex = new RegExp(escapeRegExp(query), "i");
      const filter = buildMemorySearchFilter(regex, user);
      if (typeof filter === "string") {
        return { error: filter };
      }

      const results = await Memory.find(filter).limit(20).sort({
        updatedAt: -1,
      });

      if (results.length === 0) {
        return {
          found: false,
          message: `No memories found matching "${query}"`,
        };
      }

      const memories = results.map((m) => ({
        key: m.key,
        value: m.value,
        createdBy: m.createdBy,
      }));

      return { found: true, count: memories.length, memories };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error({ error: errorMessage }, "Memory search failed");
      return { error: errorMessage };
    }
  },
});

interface ConversationMatch {
  channelId: string;
  author: string;
  content: string;
  isBot: boolean;
  timestamp: Date;
}

const CONVERSATION_SEARCH_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
] as const;

function messageMatchesCriteria(
  content: string,
  msgAuthor: string,
  queryRegex: RegExp,
  authorFilter: string | null,
): boolean {
  const contentMatches = queryRegex.test(content);
  const authorMatches =
    !authorFilter ||
    msgAuthor.toLowerCase().includes(authorFilter.toLowerCase());
  return contentMatches && authorMatches;
}

function truncateContent(content: string, maxLen = 200): string {
  return content.length > maxLen
    ? content.slice(0, maxLen - 3) + "..."
    : content;
}

function extractMatchingMessages(
  conversations: Array<{
    channelId: string;
    messages: Array<{
      author: string;
      content: string;
      isBot: boolean;
      timestamp: Date;
    }>;
  }>,
  queryRegex: RegExp,
  authorFilter: string | null,
): ConversationMatch[] {
  const matches: ConversationMatch[] = [];

  for (const conv of conversations) {
    for (const msg of conv.messages) {
      if (msg.isBot) continue;
      if (
        messageMatchesCriteria(
          msg.content,
          msg.author,
          queryRegex,
          authorFilter,
        )
      ) {
        matches.push({
          channelId: conv.channelId,
          author: msg.author,
          content: truncateContent(msg.content),
          isBot: msg.isBot,
          timestamp: msg.timestamp,
        });
      }
    }
  }

  return matches;
}

function getConversationSearchPermissionError(
  channel: TextBasedChannel,
  label: string,
): string | null {
  return requesterHasChannelPermission(channel, CONVERSATION_SEARCH_PERMISSIONS)
    ? null
    : `You need View Channel and Read Message History permission to search archived history for ${label}.`;
}

function resolveCurrentConversationChannel(
  requestedChannelId: string | null,
  channel: TextBasedChannel | null,
): string[] | string | null {
  if (requestedChannelId && requestedChannelId !== channel?.id) return null;
  if (!channel) {
    return "Conversation search needs active Discord channel context";
  }

  const permissionError = getConversationSearchPermissionError(
    channel,
    "this channel",
  );
  return permissionError ?? [channel.id];
}

async function resolveGuildConversationChannel(
  requestedChannelId: string,
  guild: Guild | null,
): Promise<string[] | string> {
  if (!guild) {
    return "Cannot search another channel outside of a server";
  }

  try {
    const guildChannel =
      guild.channels.cache.get(requestedChannelId) ??
      (await guild.channels.fetch(requestedChannelId));
    if (guildChannel?.guildId !== guild.id) {
      return "Requested channel is not in the current server";
    }
    if (!guildChannel.isTextBased()) {
      return "Requested channel does not have message history";
    }

    const channelLabel =
      "name" in guildChannel ? `#${guildChannel.name}` : "that channel";
    const permissionError = getConversationSearchPermissionError(
      guildChannel,
      channelLabel,
    );
    return permissionError ?? [requestedChannelId];
  } catch (error) {
    toolLogger.debug(
      {
        channelId: requestedChannelId,
        guildId: guild.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "Could not verify conversation search channel",
    );
    return "Could not verify that channel belongs to the current server";
  }
}

async function resolveConversationSearchChannelIds(
  requestedChannelId: string | null,
): Promise<string[] | string> {
  const { channel, guild } = toolContextManager.get();
  const currentChannel = resolveCurrentConversationChannel(
    requestedChannelId,
    channel,
  );
  if (currentChannel) return currentChannel;
  if (!requestedChannelId) {
    return "Conversation search needs active Discord channel context";
  }
  return resolveGuildConversationChannel(requestedChannelId, guild);
}

export const searchConversationTool = tool({
  name: "search_conversation",
  description:
    "Search stored conversation history in the current channel, or a verified channel in the current server. Use this to recall what was discussed previously.",
  parameters: z.object({
    query: z
      .string()
      .describe("Search query to find in conversation messages."),
    author: z.string().nullable().describe("Filter by message author."),
    channel_id: z
      .string()
      .nullable()
      .describe(
        "Optional specific channel ID. If omitted, searches the current channel only.",
      ),
    limit: z
      .number()
      .nullable()
      .describe("Maximum results to return (default 20, max 50)."),
  }),
  execute: async ({ query, author, channel_id, limit }) => {
    toolLogger.info(
      { query, author, channel_id, limit },
      "Searching conversations",
    );

    try {
      const maxLimit = Math.min(Math.max(Math.round(limit ?? 20), 1), 50);
      const regex = new RegExp(escapeRegExp(query), "i");
      const channelIds = await resolveConversationSearchChannelIds(channel_id);
      if (typeof channelIds === "string") {
        return { error: channelIds };
      }

      const conversations = await Conversation.find({
        channelId: { $in: channelIds },
      }).lean();
      const matchingMessages = extractMatchingMessages(
        conversations,
        regex,
        author,
      );

      matchingMessages.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      const results = matchingMessages.slice(0, maxLimit);

      if (results.length === 0) {
        return {
          found: false,
          message: `No conversation history found matching "${query}"`,
        };
      }

      return { found: true, count: results.length, messages: results };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error({ error: errorMessage }, "Conversation search failed");
      return { error: errorMessage };
    }
  },
});

function buildMemorySearchFilter(
  regex: RegExp,
  user: MemoryUserIdentity | null,
): MemorySearchFilter | string {
  const textFilter: MemorySearchFilter = {
    $or: [{ key: regex }, { value: regex }],
  };

  const owner = resolveMemoryOwner(user);
  return typeof owner === "string"
    ? owner
    : { $and: [textFilter, owner.filter] };
}
