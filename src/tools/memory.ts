import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toolLogger } from "../logger";
import { Memory, Conversation } from "../db/models";
import { toolContextManager } from "../utils/types";

// Get the actual Discord username from context - don't trust model's username parameter
function getContextUsername(): string | null {
  const ctx = toolContextManager.get();
  return ctx.message?.author.username ?? null;
}

function truncateValue(value: string, maxLength = 500): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 3) + "...";
}

// Extracted action handlers for memoryStoreTool
async function handleSaveMemory(
  key: string | null,
  value: string | null,
  scope: "global" | "user",
  username: string | null,
  pinned: boolean,
) {
  if (!key || !value) {
    return { error: "Key and value are required for save" };
  }
  if (scope === "user" && !username) {
    return { error: "Username required for user-scoped memories" };
  }

  const truncatedValue = truncateValue(value);
  const limit = scope === "global" ? 50 : 30;
  const query =
    scope === "global" ? { scope: "global" } : { scope: "user", username };
  const count = await Memory.countDocuments(query);

  if (count >= limit) {
    // Evict oldest non-pinned entry first; pinned entries are protected.
    const oldest = await Memory.findOne({ ...query, pinned: false }).sort({
      updatedAt: 1,
    });
    if (oldest) await oldest.deleteOne();
  }

  await Memory.updateOne(
    { key, scope, username: scope === "global" ? null : username },
    {
      key,
      value: truncatedValue,
      scope,
      username: scope === "global" ? null : username,
      createdBy: username ?? "unknown",
      pinned,
      source: "user",
    },
    { upsert: true },
  );

  return {
    success: true,
    message: `${pinned ? "Pinned" : "Remembered"} "${key}" for ${scope === "global" ? "everyone" : username}`,
  };
}

async function handlePinMemory(
  key: string | null,
  scope: "global" | "user",
  username: string | null,
  pinned: boolean,
) {
  if (!key) return { error: "Key is required" };
  if (scope === "user" && !username) {
    return { error: "Username required for user-scoped memories" };
  }
  const filter =
    scope === "global"
      ? { key, scope: "global" }
      : { key, scope: "user", username };
  const result = await Memory.updateOne(filter, { $set: { pinned } });
  if (result.matchedCount === 0) {
    return { success: false, message: `No memory found for "${key}"` };
  }
  return {
    success: true,
    message: `${pinned ? "Pinned" : "Unpinned"} "${key}"`,
  };
}

async function handleGetMemory(
  key: string | null,
  scope: "global" | "user",
  username: string | null,
) {
  if (!key) {
    return { error: "Key is required for get" };
  }
  const query =
    scope === "global"
      ? { key, scope: "global" }
      : { key, scope: "user", username };
  const item = await Memory.findOne(query);

  if (!item) {
    return { found: false, message: `No memory found for "${key}"` };
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
  scope: "global" | "user",
  username: string | null,
) {
  if (!key) {
    return { error: "Key is required for delete" };
  }
  const query =
    scope === "global"
      ? { key, scope: "global" }
      : { key, scope: "user", username };
  const result = await Memory.deleteOne(query);

  if (result.deletedCount > 0) {
    return { success: true, message: `Forgot "${key}"` };
  }
  return { success: false, message: `No memory found for "${key}"` };
}

async function handleListMemories(username: string | null) {
  const memories: {
    scope: string;
    key: string;
    value: string;
    createdBy: string;
    pinned: boolean;
    source: string;
  }[] = [];

  const globalMemories = await Memory.find({ scope: "global" });
  for (const m of globalMemories) {
    memories.push({
      scope: "global",
      key: m.key,
      value: m.value,
      createdBy: m.createdBy,
      pinned: m.pinned,
      source: m.source,
    });
  }

  if (username) {
    const userMemories = await Memory.find({ scope: "user", username });
    for (const m of userMemories) {
      memories.push({
        scope: "user",
        key: m.key,
        value: m.value,
        createdBy: m.createdBy,
        pinned: m.pinned,
        source: m.source,
      });
    }
  }

  return { count: memories.length, memories };
}

export const memoryStoreTool = defineTool("memory_store", {
  description:
    "Store, retrieve, pin, or delete memories. PINNED memories are always loaded into context (treat them as the user's persona/core facts). Use 'pin' to mark an existing memory as pinned, 'unpin' to remove that flag. The username is automatically detected.",
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
    scope: z
      .enum(["global", "user"])
      .describe(
        "Where to store the memory. Use 'user' for personal info about the current user.",
      ),
    pinned: z
      .boolean()
      .nullable()
      .describe(
        "For 'save': whether to pin the memory so it always appears in context. Defaults to false.",
      ),
  }),
  handler: async ({ action, key, value, scope, pinned }) => {
    const username = getContextUsername();
    toolLogger.info(
      { action, key, scope, username, pinned },
      "Memory store operation",
    );

    try {
      switch (action) {
        case "save":
          return await handleSaveMemory(
            key,
            value,
            scope,
            username,
            pinned ?? false,
          );
        case "get":
          return await handleGetMemory(key, scope, username);
        case "delete":
          return await handleDeleteMemory(key, scope, username);
        case "list":
          return await handleListMemories(username);
        case "pin":
          return await handlePinMemory(key, scope, username, true);
        case "unpin":
          return await handlePinMemory(key, scope, username, false);
        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
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

export const memoryRecallTool = defineTool("memory_recall", {
  description:
    "Recall all stored memories for the current user. Use this when you need to remember what you know about the user. Username is automatically detected.",
  parameters: z.object({
    include_global: z.boolean().describe("Whether to include global memories."),
  }),
  handler: async ({ include_global }) => {
    const username = getContextUsername();
    toolLogger.info({ username, include_global }, "Recalling memories");

    const maxTotalLength = 2000;
    const allLines: string[] = [];
    let currentLength = 0;

    if (include_global) {
      const globalMemories = await Memory.find({ scope: "global" }).sort({
        pinned: -1,
        updatedAt: -1,
      });
      const { lines, newLength } = collectMemoryLines(
        globalMemories,
        "=== Global Memories ===",
        currentLength,
        maxTotalLength,
      );
      allLines.push(...lines);
      currentLength = newLength;
    }

    if (username) {
      const userMemories = await Memory.find({ scope: "user", username }).sort({
        pinned: -1,
        updatedAt: -1,
      });
      const { lines } = collectMemoryLines(
        userMemories,
        `=== Memories about ${username} ===`,
        currentLength,
        maxTotalLength,
      );
      allLines.push(...lines);
    }

    if (allLines.length === 0) {
      return { hasMemories: false, message: "No memories stored yet." };
    }

    const result = { hasMemories: true, summary: allLines.join("\n") };
    toolLogger.info({ result }, "Memory recall result");
    return result;
  },
});

export const searchMemoryTool = defineTool("search_memory", {
  description:
    "Search through stored memories by keyword. Searches current user's memories by default.",
  parameters: z.object({
    query: z
      .string()
      .describe("Search query to find in memory keys and values."),
    scope: z
      .enum(["global", "user", "all"])
      .nullable()
      .describe(
        "Filter by scope: 'user' for current user only, 'global' for global only, 'all' or null for both.",
      ),
  }),
  handler: async ({ query, scope }) => {
    const username = getContextUsername();
    toolLogger.info({ query, username, scope }, "Searching memories");

    try {
      const regex = new RegExp(query, "i");
      let memoryQuery = Memory.find().or([{ key: regex }, { value: regex }]);

      if (scope === "global") {
        memoryQuery = memoryQuery.where("scope").equals("global");
      } else if (scope === "user") {
        memoryQuery = memoryQuery
          .where("scope")
          .equals("user")
          .where("username")
          .equals(username);
      }
      // scope === "all" or null: no additional filter

      const results = await memoryQuery.limit(20).sort({ updatedAt: -1 });

      if (results.length === 0) {
        return {
          found: false,
          message: `No memories found matching "${query}"`,
        };
      }

      const memories = results.map((m) => ({
        key: m.key,
        value: m.value,
        scope: m.scope,
        username: m.username,
        createdBy: m.createdBy,
      }));

      return { found: true, count: memories.length, memories };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
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

function messageMatchesCriteria(
  content: string,
  msgAuthor: string,
  queryRegex: RegExp,
  authorFilter: string | null,
): boolean {
  const contentMatches = queryRegex.test(content);
  const authorMatches =
    !authorFilter || new RegExp(authorFilter, "i").test(msgAuthor);
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

export const searchConversationTool = defineTool("search_conversation", {
  description:
    "Search through past conversation history stored in the database. Use this to recall what was discussed previously.",
  parameters: z.object({
    query: z
      .string()
      .describe("Search query to find in conversation messages."),
    author: z.string().nullable().describe("Filter by message author."),
    channel_id: z
      .string()
      .nullable()
      .describe("Filter by specific channel ID."),
    limit: z
      .number()
      .nullable()
      .describe("Maximum results to return (default 20, max 50)."),
  }),
  handler: async ({ query, author, channel_id, limit }) => {
    toolLogger.info(
      { query, author, channel_id, limit },
      "Searching conversations",
    );

    try {
      const maxLimit = Math.min(limit ?? 20, 50);
      const regex = new RegExp(query, "i");

      let conversationQuery = Conversation.find();
      if (channel_id) {
        conversationQuery = conversationQuery
          .where("channelId")
          .equals(channel_id);
      }

      const conversations = await conversationQuery.lean();
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
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toolLogger.error({ error: errorMessage }, "Conversation search failed");
      return { error: errorMessage };
    }
  },
});
