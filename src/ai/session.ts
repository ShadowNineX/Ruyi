import {
  Agent,
  user,
  type AgentInputItem,
  type OpenAIResponsesCompactionArgs,
  type Session,
} from "@openai/agents";
import { aiLogger } from "../logger";
import { AgentSession, Conversation } from "../db/models";
import type { IAgentSession } from "../db/models";
import {
  AGENT_SESSION_COMPACTION_ITEM_MAX_LEN,
  AGENT_SESSION_COMPACTION_TIMEOUT_MS,
  AGENT_SESSION_COMPACTION_TRIGGER_ITEMS,
  AGENT_SESSION_ITEM_CAP,
  AGENT_SESSION_RECENT_ITEM_KEEP,
  AGENT_SESSION_SEED_MESSAGE_LIMIT,
  AGENT_SESSION_SUMMARY_MAX_LEN,
} from "../constants";
import { agentsRuntimeManager } from "./client";
import { systemPromptVersion } from "./prompt";

const SUMMARY_SYSTEM_PROMPT = `You maintain Ruyi's compacted Discord channel memory.

Return only the refreshed summary text. No preface, markdown heading, JSON, or code fence.

Keep:
- Durable facts, preferences, names, relationships, projects, and decisions.
- Open threads, unresolved requests, promised follow-ups, and current tasks.
- Important Discord context such as channels, message IDs, user names, URLs, permissions, and moderation actions.
- Tool calls only when their outcome matters later: tool name, purpose, result, errors, IDs, URLs, files, or destructive/admin action taken.

Prune:
- Raw tool payloads, base64/blob data, long JSON, repeated search listings, transient call metadata, and routine successful tool chatter.
- Passing moods, small talk with no future relevance, duplicate facts, and obsolete intermediate reasoning.

Write in concise bullets or short paragraphs. Preserve enough context that a future assistant can answer follow-ups without seeing the old raw items.`;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 3)) + "...";
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}

function contentPartToText(part: unknown): string {
  if (typeof part === "string") return part;

  const record = asRecord(part);
  if (!record) return stringifyUnknown(part);

  if (typeof record.text === "string") return record.text;
  if (typeof record.refusal === "string") return `[refusal] ${record.refusal}`;
  if (typeof record.image === "string") return "[image]";

  return stringifyUnknown(record);
}

function contentToText(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map(contentPartToText).filter(Boolean).join(" ");
  }
  return stringifyUnknown(content);
}

function itemLabel(record: Record<string, unknown>): string {
  if (typeof record.role === "string") return record.role;
  if (typeof record.type === "string") return record.type;
  return "item";
}

function itemBody(record: Record<string, unknown>): string {
  const name = typeof record.name === "string" ? record.name : "unknown";

  if (record.type === "function_call") {
    return `${name} args=${truncateText(
      stringifyUnknown(record.arguments),
      500,
    )}`;
  }

  if (record.type === "function_call_result") {
    return `${name} output=${truncateText(
      stringifyUnknown(record.output),
      900,
    )}`;
  }

  if ("content" in record) return contentToText(record.content);

  return stringifyUnknown(record);
}

function formatItemForSummary(item: AgentInputItem, index: number): string {
  const record = asRecord(item);
  const body = record ? itemBody(record) : stringifyUnknown(item);
  const label = record ? itemLabel(record) : "item";

  return `${index}. ${label}: ${truncateText(
    body,
    AGENT_SESSION_COMPACTION_ITEM_MAX_LEN,
  )}`;
}

function serializeItemsForSummary(items: AgentInputItem[]): string {
  return items
    .map((item, index) => formatItemForSummary(item, index + 1))
    .join("\n");
}

function itemType(item: AgentInputItem): string | null {
  const type = asRecord(item)?.type;
  return typeof type === "string" ? type : null;
}

function callIdForItem(item: AgentInputItem): string | null {
  const record = asRecord(item);
  const callId = record?.callId ?? record?.call_id;
  return typeof callId === "string" && callId.length > 0 ? callId : null;
}

function isFunctionCall(item: AgentInputItem): boolean {
  return itemType(item) === "function_call";
}

function isFunctionCallResult(item: AgentInputItem): boolean {
  return itemType(item) === "function_call_result";
}

function callIdsForItems(
  items: AgentInputItem[],
  predicate: (item: AgentInputItem) => boolean,
): Set<string> {
  const callIds = new Set<string>();

  for (const item of items) {
    const callId = callIdForItem(item);
    if (callId && predicate(item)) callIds.add(callId);
  }

  return callIds;
}

function missingFunctionCallIds(
  items: AgentInputItem[],
  knownCallIds: Set<string>,
): Set<string> {
  const missingCallIds = new Set<string>();

  for (const item of items) {
    const callId = callIdForItem(item);
    if (callId && isFunctionCallResult(item) && !knownCallIds.has(callId)) {
      missingCallIds.add(callId);
    }
  }

  return missingCallIds;
}

function moveStartBeforeMissingCalls(
  items: AgentInputItem[],
  start: number,
  missingCallIds: Set<string>,
): number {
  while (missingCallIds.size > 0 && start > 0) {
    start -= 1;
    const item = items[start];
    if (!item) continue;
    const callId = callIdForItem(item);
    if (!callId) continue;
    if (isFunctionCall(item)) missingCallIds.delete(callId);
    if (isFunctionCallResult(item)) missingCallIds.add(callId);
  }

  return start;
}

function retainedStartIndex(items: AgentInputItem[]): number {
  const start = Math.max(0, items.length - AGENT_SESSION_RECENT_ITEM_KEEP);
  const retainedItems = items.slice(start);
  const retainedCallIds = callIdsForItems(retainedItems, isFunctionCall);
  const missingCallIds = missingFunctionCallIds(retainedItems, retainedCallIds);

  return moveStartBeforeMissingCalls(items, start, missingCallIds);
}

function buildSummaryPrompt(
  existingSummary: string | null,
  compactedItems: AgentInputItem[],
): string {
  const previousSummary = existingSummary
    ? truncateText(existingSummary, AGENT_SESSION_SUMMARY_MAX_LEN)
    : "(none)";

  return `Previous compacted summary:
${previousSummary}

Older raw session items to fold into the summary:
${serializeItemsForSummary(compactedItems)}

Refresh the compacted channel summary. Keep it under ${AGENT_SESSION_SUMMARY_MAX_LEN} characters.`;
}

async function summarizeCompactedItems(
  existingSummary: string | null,
  compactedItems: AgentInputItem[],
): Promise<string> {
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    AGENT_SESSION_COMPACTION_TIMEOUT_MS,
  );

  try {
    const agent = new Agent({
      name: "Ruyi channel summarizer",
      instructions: SUMMARY_SYSTEM_PROMPT,
      model: agentsRuntimeManager.model,
    });

    const result = await agentsRuntimeManager
      .getRunner()
      .run(agent, buildSummaryPrompt(existingSummary, compactedItems), {
        maxTurns: 1,
        signal: abortController.signal,
      });

    const raw =
      typeof result.finalOutput === "string" ? result.finalOutput.trim() : "";
    if (!raw) throw new Error("Summary compaction returned empty output");

    return truncateText(raw, AGENT_SESSION_SUMMARY_MAX_LEN);
  } finally {
    clearTimeout(timeout);
  }
}

interface SessionCompactionResult {
  items: AgentInputItem[];
  summary: string;
  compactedCount: number;
}

async function compactItemsIntoSummary(
  items: AgentInputItem[],
  existingSummary: string | null,
): Promise<SessionCompactionResult | null> {
  const start = retainedStartIndex(items);
  if (start <= 0) return null;

  const compactedItems = items.slice(0, start);
  const retainedItems = items.slice(start);
  const summary = await summarizeCompactedItems(
    existingSummary,
    compactedItems,
  );

  return {
    items: retainedItems,
    summary,
    compactedCount: compactedItems.length,
  };
}

class MongoAgentSession implements Session {
  constructor(
    private readonly channelId: string,
    private readonly sessionId: string,
    private items: AgentInputItem[],
    private summary: string | null,
  ) {}

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (limit === undefined) return [...this.items];
    return this.items.slice(-limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.items = [...this.items, ...items];
    await this.persist();
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const item = this.items.pop();
    await this.persist();
    return item;
  }

  async clearSession(): Promise<void> {
    this.items = [];
    await this.persist();
  }

  async runCompaction(args?: OpenAIResponsesCompactionArgs): Promise<void> {
    const shouldCompact =
      args?.force === true ||
      this.items.length > AGENT_SESSION_COMPACTION_TRIGGER_ITEMS;
    if (!shouldCompact) {
      return;
    }

    try {
      const result = await compactItemsIntoSummary(this.items, this.summary);
      if (!result) return;

      this.summary = result.summary;
      this.items = result.items;
      await this.persistCompaction();

      aiLogger.info(
        {
          channelId: this.channelId,
          compactedCount: result.compactedCount,
          retainedCount: result.items.length,
          summaryLength: result.summary.length,
        },
        "Agent session compacted into channel summary",
      );
    } catch (error) {
      await this.trimAfterFailedCompaction();
      aiLogger.warn(
        {
          error: (error as Error).message,
          stack: (error as Error).stack,
          name: (error as Error).name,
          channelId: this.channelId,
          itemCount: this.items.length,
        },
        "Agent session compaction failed; retaining raw session items",
      );
    }
  }

  private async persist(): Promise<void> {
    await AgentSession.updateOne(
      { channelId: this.channelId },
      {
        $set: {
          sessionId: this.sessionId,
          provider: "openai-agents",
          model: agentsRuntimeManager.model,
          items: this.items,
          lastUsed: new Date(),
          isActive: true,
          promptVersion: systemPromptVersion,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  private async persistCompaction(): Promise<void> {
    await AgentSession.updateOne(
      { channelId: this.channelId },
      {
        $set: {
          summary: this.summary ?? "",
          summaryUpdatedAt: new Date(),
          items: this.items,
          lastUsed: new Date(),
          model: agentsRuntimeManager.model,
          promptVersion: systemPromptVersion,
        },
      },
    );
  }

  private async trimAfterFailedCompaction(): Promise<void> {
    if (this.items.length <= AGENT_SESSION_ITEM_CAP) return;

    const originalCount = this.items.length;
    this.items = this.items.slice(-AGENT_SESSION_ITEM_CAP);
    await this.persist();

    aiLogger.warn(
      {
        channelId: this.channelId,
        originalCount,
        retainedCount: this.items.length,
      },
      "Agent session exceeded hard cap after failed compaction; trimmed raw items",
    );
  }
}

function toAgentItems(doc: IAgentSession): AgentInputItem[] {
  return doc.items as AgentInputItem[];
}

async function compactPersistedItemsIfNeeded(
  channelId: string,
  items: AgentInputItem[],
  existingSummary: string | null,
): Promise<{ items: AgentInputItem[]; summary: string | null }> {
  if (items.length <= AGENT_SESSION_COMPACTION_TRIGGER_ITEMS) {
    return { items, summary: existingSummary };
  }

  try {
    const result = await compactItemsIntoSummary(items, existingSummary);
    if (!result) return { items, summary: existingSummary };

    await AgentSession.updateOne(
      { channelId },
      {
        $set: {
          items: result.items,
          summary: result.summary,
          summaryUpdatedAt: new Date(),
          lastUsed: new Date(),
          model: agentsRuntimeManager.model,
          promptVersion: systemPromptVersion,
        },
      },
    );

    aiLogger.info(
      {
        channelId,
        compactedCount: result.compactedCount,
        retainedCount: result.items.length,
        summaryLength: result.summary.length,
      },
      "Compacted loaded agent session before replay",
    );

    return { items: result.items, summary: result.summary };
  } catch (error) {
    aiLogger.warn(
      {
        error: (error as Error).message,
        stack: (error as Error).stack,
        name: (error as Error).name,
        channelId,
        itemCount: items.length,
      },
      "Failed to compact loaded agent session; using existing raw items",
    );
    return {
      items: items.slice(-AGENT_SESSION_ITEM_CAP),
      summary: existingSummary,
    };
  }
}

async function buildSeedItems(
  channelId: string,
  currentMessageId?: string,
): Promise<AgentInputItem[]> {
  const conversation = await Conversation.findOne({ channelId });
  if (!conversation || conversation.messages.length === 0) return [];

  const messages = conversation.messages
    .filter((message) => message.messageId !== currentMessageId)
    .filter((message) => !message.isBot)
    .slice(-AGENT_SESSION_SEED_MESSAGE_LIMIT);

  return messages.map((message) => {
    return user(`${message.author}: ${message.content}`);
  });
}

export class SessionManager {
  private readonly activeSessions = new Map<string, MongoAgentSession>();

  async loadPersisted(): Promise<void> {
    try {
      const count = await AgentSession.countDocuments({ isActive: true });
      aiLogger.info(
        { count },
        "Agent sessions are persisted in Mongo and will be loaded lazily",
      );
    } catch (error) {
      aiLogger.error({ error }, "Failed to inspect persisted agent sessions");
    }
  }

  async getOrCreate(
    channelId: string,
    currentMessageId?: string,
  ): Promise<MongoAgentSession> {
    const existingSession = this.activeSessions.get(channelId);
    if (existingSession) {
      aiLogger.debug({ channelId }, "Using cached agent session");
      await AgentSession.updateOne(
        { channelId },
        { $set: { lastUsed: new Date() } },
      );
      return existingSession;
    }

    const persistedSession = await AgentSession.findOne({
      channelId,
      isActive: true,
      provider: "openai-agents",
    });

    if (persistedSession) {
      const versionMatches =
        !persistedSession.promptVersion ||
        persistedSession.promptVersion === systemPromptVersion;

      if (versionMatches) {
        const compactedSession = await compactPersistedItemsIfNeeded(
          channelId,
          toAgentItems(persistedSession),
          persistedSession.summary ?? null,
        );
        const session = new MongoAgentSession(
          channelId,
          persistedSession.sessionId,
          compactedSession.items,
          compactedSession.summary,
        );
        this.activeSessions.set(channelId, session);
        await AgentSession.updateOne(
          { channelId },
          {
            $set: {
              lastUsed: new Date(),
              model: agentsRuntimeManager.model,
            },
          },
        );

        aiLogger.debug(
          { channelId, sessionId: persistedSession.sessionId },
          "Loaded agent session from Mongo",
        );
        return session;
      }

      aiLogger.info(
        {
          channelId,
          sessionId: persistedSession.sessionId,
          storedVersion: persistedSession.promptVersion,
          currentVersion: systemPromptVersion,
        },
        "System prompt changed; creating fresh agent session",
      );
      await AgentSession.updateOne(
        { channelId },
        { $set: { isActive: false } },
      );
    }

    const sessionId = `ruyi-${channelId}-${Date.now()}`;
    const seedItems = await buildSeedItems(channelId, currentMessageId);
    const session = new MongoAgentSession(channelId, sessionId, seedItems, null);

    await AgentSession.findOneAndUpdate(
      { channelId },
      {
        $set: {
          sessionId,
          provider: "openai-agents",
          model: agentsRuntimeManager.model,
          items: seedItems,
          lastUsed: new Date(),
          isActive: true,
          promptVersion: systemPromptVersion,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );

    this.activeSessions.set(channelId, session);

    aiLogger.info(
      { channelId, sessionId, seedCount: seedItems.length },
      "Created new agent session",
    );

    return session;
  }

  async invalidate(channelId: string): Promise<void> {
    this.activeSessions.delete(channelId);

    await AgentSession.updateOne(
      { channelId },
      { $set: { isActive: false } },
    );

    aiLogger.debug({ channelId }, "Agent session invalidated");
  }

  async recordAssistantMessages(
    channelId: string,
    messageIds: string[],
  ): Promise<void> {
    if (messageIds.length === 0) return;

    await AgentSession.updateOne(
      {
        channelId,
        isActive: true,
        provider: "openai-agents",
      },
      {
        $push: {
          assistantMessageIds: {
            $each: messageIds,
            $slice: -100,
          },
        },
        $set: { lastUsed: new Date() },
      },
    );
  }

  async invalidateIfAssistantMessageDeleted(
    channelId: string,
    messageId: string,
  ): Promise<boolean> {
    const session = await AgentSession.exists({
      channelId,
      isActive: true,
      provider: "openai-agents",
      assistantMessageIds: messageId,
    });

    if (!session) return false;

    await this.invalidate(channelId);
    aiLogger.info(
      { channelId, messageId },
      "Invalidated agent session because a tracked assistant reply was deleted",
    );
    return true;
  }

  async destroyAll(): Promise<void> {
    this.activeSessions.clear();
  }

  getActiveCount(): number {
    return this.activeSessions.size;
  }
}

export const sessionManager = new SessionManager();
