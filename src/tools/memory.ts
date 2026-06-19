import { tool } from "@openai/agents";
import { z } from "zod";
import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type TextBasedChannel,
  type TextChannel,
} from "discord.js";
import { toolLogger } from "../logger";
import { DiscordConversation, Memory } from "../db/models";
import { toolContextManager, formatError } from "../utils/types";
import { requesterHasChannelPermission } from "../discord/utils/discord-permissions";
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
import {
  rankMessageMatches,
  summarizeMessageSearchMatches,
  type MessageMatchType,
  type RankedMessageMatch,
  type SearchableMessage,
} from "../utils/message-search";
import {
  searchSteamProfileComments,
  type SteamCommentSearchMatch,
} from "../steam/comment-search";

type MemorySearchFilter = Record<string, unknown>;

type MemoryOwnerFilter = UserMemoryFilter;

interface MemoryUserIdentity {
  personId: string;
  username: string;
  canWriteMemory: boolean;
  surface: "discord" | "steam";
}

interface MemoryOwnerContext {
  createdBy: string;
  filter: MemoryOwnerFilter;
  label: string;
  limit: number;
  username: string | null;
}

// Get the actual runtime user identity from context - don't trust model parameters.
function getContextUserIdentity(): MemoryUserIdentity | null {
  const ctx = toolContextManager.get();
  const identity = ctx.identity;
  return identity
    ? {
        personId: identity.personId,
        username: identity.username,
        canWriteMemory: identity.canWriteMemory,
        surface: identity.surface,
      }
    : null;
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
    return "User context required for memories";
  }
  if (!user.canWriteMemory) {
    return "Memory writes are disabled for this unlinked Steam commenter";
  }

  return {
    createdBy: user.username,
    filter: buildUserMemoryFilter(user),
    label: formatUserMemoryContext(user),
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
    return `Memory cap reached for ${owner.label}. Unpin or delete an existing memory before saving more.`;
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
      personId: owner.filter.personId,
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
    "Store, retrieve, pin, or delete memories. PINNED memories are always loaded into context (treat them as the user's persona/core facts). Use 'pin' to mark an existing memory as pinned, 'unpin' to remove that flag. The runtime user identity is automatically detected.",
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
        personId: user?.personId,
        surface: user?.surface,
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
    "Recall a broad list of stored memories for the current runtime user. Use proactively when answering user-specific questions where older or non-loaded memories may matter, such as preferences, identity, accounts, relationships, hobbies, tailored advice, or 'what do you know/remember about me?'. Runtime identity is automatically detected.",
  parameters: z.object({}),
  execute: async () => {
    const user = getContextUserIdentity();
    toolLogger.info(
      { personId: user?.personId, surface: user?.surface, username: user?.username },
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
        personId: user?.personId,
        surface: user?.surface,
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
    "Search stored memories for the current runtime user by keyword. Use proactively when the user asks about a specific remembered topic, person, place, account, preference, date, project, character, or relationship and the loaded context does not already contain the exact fact.",
  parameters: z.object({
    query: z
      .string()
      .describe("Search query to find in memory keys and values."),
  }),
  execute: async ({ query }) => {
    const user = getContextUserIdentity();
    toolLogger.info(
      { query, personId: user?.personId, surface: user?.surface, username: user?.username },
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
  source: "discord" | "steam";
  id: string;
  channelId?: string;
  profileId?: string;
  author: string;
  content: string;
  isBot?: boolean;
  timestamp: Date;
  matchType: MessageMatchType;
  matchScore: number;
  fuseScore: number | null;
  matchedTerms: string[];
  missingTerms: string[];
  contextBefore: ConversationContextMessage[];
  contextAfter: ConversationContextMessage[];
}

const CONVERSATION_SEARCH_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
] as const;

interface ConversationContextMessage {
  author: string;
  content: string;
  isBot?: boolean;
  timestamp: Date;
}

interface ConversationSearchDocument extends SearchableMessage {
  channelId: string;
  isBot: boolean;
  timestamp: Date;
  contextBefore: ConversationContextMessage[];
  contextAfter: ConversationContextMessage[];
}

interface ConversationSearchSummary {
  exactPhraseFound: boolean;
  bestMatchType: MessageMatchType | null;
  fuzzyMatchCount: number;
  partialMatchCount: number;
}

interface ConversationSearchResult {
  matches: ConversationMatch[];
  summary: ConversationSearchSummary;
  scanned: number;
}

function authorMatchesFilter(
  author: string,
  authorFilter: string | null,
): boolean {
  return (
    !authorFilter ||
    author.toLowerCase().includes(authorFilter.toLowerCase().trim())
  );
}

function truncateContent(content: string, maxLen = 200): string {
  return content.length > maxLen
    ? content.slice(0, maxLen - 3) + "..."
    : content;
}

function buildConversationContextMessage(
  message: ConversationContextMessage,
): ConversationContextMessage {
  return {
    author: message.author,
    content: truncateContent(message.content),
    isBot: message.isBot,
    timestamp: message.timestamp,
  };
}

function buildConversationContextWindow(
  messages: ConversationContextMessage[],
  index: number,
): Pick<ConversationSearchDocument, "contextBefore" | "contextAfter"> {
  return {
    contextBefore: messages
      .slice(Math.max(0, index - 2), index)
      .map(buildConversationContextMessage),
    contextAfter: messages
      .slice(index + 1, index + 3)
      .map(buildConversationContextMessage),
  };
}

function buildConversationSearchDocuments(
  conversations: Array<{
    channelId: string;
    messages: Array<{
      messageId: string;
      author: string;
      content: string;
      isBot: boolean;
      timestamp: Date;
    }>;
  }>,
  authorFilter: string | null,
): ConversationSearchDocument[] {
  const documents: ConversationSearchDocument[] = [];

  for (const conversation of conversations) {
    conversation.messages.forEach((message, index) => {
      if (
        message.isBot ||
        !authorMatchesFilter(message.author, authorFilter)
      ) {
        return;
      }

      documents.push({
        id: message.messageId,
        channelId: conversation.channelId,
        author: message.author,
        content: message.content,
        isBot: message.isBot,
        timestamp: message.timestamp,
        ...buildConversationContextWindow(conversation.messages, index),
      });
    });
  }

  return documents;
}

function buildConversationMatch(
  match: RankedMessageMatch<ConversationSearchDocument>,
): ConversationMatch {
  return {
    source: "discord",
    id: match.item.id,
    channelId: match.item.channelId,
    author: match.item.author,
    content: truncateContent(match.item.content),
    isBot: match.item.isBot,
    timestamp: match.item.timestamp,
    matchType: match.matchType,
    matchScore: Number(match.score.toFixed(3)),
    fuseScore:
      match.fuseScore === null ? null : Number(match.fuseScore.toFixed(3)),
    matchedTerms: match.matchedTerms,
    missingTerms: match.missingTerms,
    contextBefore: match.item.contextBefore,
    contextAfter: match.item.contextAfter,
  };
}

function buildSteamConversationContextMessage(
  match: SteamCommentSearchMatch["contextBefore"][number],
): ConversationContextMessage {
  return {
    author: match.author,
    content: truncateContent(match.content),
    timestamp: match.timestamp,
  };
}

function buildSteamConversationMatch(
  match: SteamCommentSearchMatch,
): ConversationMatch {
  return {
    source: "steam",
    id: match.id,
    profileId: match.profileId,
    author: match.author,
    content: truncateContent(match.content),
    timestamp: match.timestamp,
    matchType: match.matchType,
    matchScore: match.matchScore,
    fuseScore: match.fuseScore,
    matchedTerms: match.matchedTerms,
    missingTerms: match.missingTerms,
    contextBefore: match.contextBefore.map(buildSteamConversationContextMessage),
    contextAfter: match.contextAfter.map(buildSteamConversationContextMessage),
  };
}

function extractMatchingMessages(
  conversations: Array<{
    channelId: string;
    messages: Array<{
      messageId: string;
      author: string;
      content: string;
      isBot: boolean;
      timestamp: Date;
    }>;
  }>,
  query: string,
  authorFilter: string | null,
  limit: number,
): ConversationSearchResult {
  const documents = buildConversationSearchDocuments(conversations, authorFilter);
  const rankedMatches = rankMessageMatches(documents, query, limit);
  return {
    matches: rankedMatches.map(buildConversationMatch),
    summary: summarizeMessageSearchMatches(rankedMatches),
    scanned: documents.length,
  };
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

async function resolveAllGuildConversationChannels(
  guild: Guild | null,
): Promise<string[] | string> {
  if (!guild) {
    return "Cannot search all archived channels outside of a server";
  }

  const channels = await guild.channels.fetch();
  const readableChannels = channels
    .filter(
      (channel): channel is TextChannel =>
        channel?.type === ChannelType.GuildText,
    )
    .filter(
      (channel) =>
        getConversationSearchPermissionError(channel, channel.name) === null,
    )
    .map((channel) => channel.id);

  return readableChannels.length > 0
    ? readableChannels
    : "No readable server text channels were available for archived search.";
}

async function resolveConversationSearchChannelIds(
  requestedChannelId: string | null,
  searchAllChannels: boolean | null,
): Promise<string[] | string> {
  const { channel, guild } = toolContextManager.get();
  if (requestedChannelId) {
    const currentChannel = resolveCurrentConversationChannel(
      requestedChannelId,
      channel,
    );
    return (
      currentChannel ??
      resolveGuildConversationChannel(requestedChannelId, guild)
    );
  }

  if (searchAllChannels) {
    return resolveAllGuildConversationChannels(guild);
  }

  const currentChannel = resolveCurrentConversationChannel(
    null,
    channel,
  );
  if (currentChannel) return currentChannel;
  return "Conversation search needs active Discord channel context";
}

function describeDiscordConversationSearchScope(
  channelId: string | null,
  searchAllChannels: boolean | null,
): string {
  if (searchAllChannels) {
    return "readable archived text channels in the current server";
  }
  if (channelId) {
    return "verified archived channel in the current server";
  }
  return "current archived channel";
}

async function searchDiscordConversation(
  query: string,
  author: string | null,
  channelId: string | null,
  searchAllChannels: boolean | null,
  maxLimit: number,
) {
  const channelIds = await resolveConversationSearchChannelIds(
    channelId,
    searchAllChannels,
  );
  if (typeof channelIds === "string") {
    return { error: channelIds };
  }

  const conversations = await DiscordConversation.find({
    channelId: { $in: channelIds },
  }).lean();
  const search = extractMatchingMessages(
    conversations,
    query,
    author,
    maxLimit,
  );

  if (search.matches.length === 0) {
    return {
      found: false,
      message: `No Discord conversation history found matching "${query}"`,
      search_summary: {
        searched_channel_count: channelIds.length,
        scanned_message_count: search.scanned,
        result_limit: maxLimit,
        source: "discord",
        limitation:
          "Archived Discord search only covers messages Ruyi stored for readable scoped channels. Deleted or never-archived older Discord messages may be unavailable.",
      },
    };
  }

  return {
    found: true,
    count: search.matches.length,
    messages: search.matches,
    search_summary: {
      exact_phrase_found: search.summary.exactPhraseFound,
      best_match_type: search.summary.bestMatchType,
      fuzzy_match_count: search.summary.fuzzyMatchCount,
      partial_match_count: search.summary.partialMatchCount,
      searched_channel_count: channelIds.length,
      scanned_message_count: search.scanned,
      result_limit: maxLimit,
      source: "discord",
      scope: describeDiscordConversationSearchScope(
        channelId,
        searchAllChannels,
      ),
      limitation:
        "Archived Discord search only covers messages Ruyi stored for readable scoped channels. Deleted or never-archived older Discord messages may be unavailable.",
    },
  };
}

async function searchSteamConversation(
  query: string,
  author: string | null,
  maxLimit: number,
) {
  const profileId = toolContextManager.get().steam?.profileId;
  if (!profileId) {
    return {
      error: "Steam conversation search needs active Steam profile context",
    };
  }

  const search = await searchSteamProfileComments(
    profileId,
    query,
    author,
    maxLimit,
  );
  const messages = search.matches.map(buildSteamConversationMatch);

  if (messages.length === 0) {
    return {
      found: false,
      message: `No Steam profile comments found matching "${query}"`,
      search_summary: {
        searched_comment_count: search.searchedCommentCount,
        result_limit: maxLimit,
        source: "steam",
        limitation:
          "Steam conversation search only covers recent comments fetched from the active Steam profile. Deleted, private, or older comments may be unavailable.",
      },
    };
  }

  return {
    found: true,
    count: messages.length,
    messages,
    search_summary: {
      exact_phrase_found: search.summary.exactPhraseFound,
      best_match_type: search.summary.bestMatchType,
      fuzzy_match_count: search.summary.fuzzyMatchCount,
      partial_match_count: search.summary.partialMatchCount,
      searched_comment_count: search.searchedCommentCount,
      result_limit: maxLimit,
      source: "steam",
      scope: "recent profile comments on the active Steam profile",
      limitation:
        "Steam conversation search only covers recent comments fetched from the active Steam profile. Deleted, private, or older comments may be unavailable.",
    },
  };
}

export const searchConversationTool = tool({
  name: "search_conversation",
  description:
    "Surface-aware fuzzy search for the current conversation. In Discord, searches stored Discord history for the current or verified server channel. In Steam, searches recent comments on the active Steam profile. The source is chosen by code and never crosses surfaces.",
  parameters: z.object({
    query: z
      .string()
      .describe("Exact phrase or fuzzy query to find in conversation messages."),
    author: z.string().nullable().describe("Filter by message author."),
    channel_id: z
      .string()
      .nullable()
      .describe(
        "Discord-only optional specific channel ID. If omitted, Discord searches the current channel only. Ignored for Steam.",
      ),
    search_all_channels: z
      .boolean()
      .nullable()
      .describe(
        "Discord-only. If true, searches archived history for readable text channels in the current server. Not available in DMs. Ignored for Steam.",
      ),
    limit: z
      .number()
      .nullable()
      .describe("Maximum results to return (default 20, max 50)."),
  }),
  execute: async ({ query, author, channel_id, search_all_channels, limit }) => {
    toolLogger.info(
      {
        queryLength: query.length,
        hasAuthorFilter: Boolean(author),
        channel_id,
        search_all_channels,
        limit,
      },
      "Searching conversations",
    );

    try {
      const maxLimit = Math.min(Math.max(Math.round(limit ?? 20), 1), 50);
      const ctx = toolContextManager.get();
      if (ctx.surface === "steam") {
        return searchSteamConversation(query, author, maxLimit);
      }

      return searchDiscordConversation(
        query,
        author,
        channel_id,
        search_all_channels,
        maxLimit,
      );
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
