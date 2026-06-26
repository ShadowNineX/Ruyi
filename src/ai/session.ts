import type { AgentInputItem, ModelSettings, OpenAIResponsesCompactionArgs, Session } from '@openai/agents';
import type { UpdateQuery } from 'mongoose';
import type { IDiscordAgentSession, ISteamAgentSession } from '../db/models';
import type { ConversationSurface } from './context';
import {
  Agent,

  assistant,

  user,
} from '@openai/agents';
import {
  AGENT_SESSION_COMPACTION_ITEM_MAX_LEN,
  AGENT_SESSION_COMPACTION_TIMEOUT_MS,
  AGENT_SESSION_COMPACTION_TRIGGER_ITEMS,
  AGENT_SESSION_ITEM_CAP,
  AGENT_SESSION_RECENT_ITEM_KEEP,
  AGENT_SESSION_SEED_MESSAGE_LIMIT,
  AGENT_SESSION_SUMMARY_MAX_LEN,
} from '../constants';
import {
  DiscordAgentSession,
  DiscordConversation,
  SteamAgentSession,
  SteamConversation,
} from '../db/models';
import { aiLogger } from '../logger';
import {
  clearCachedAgentSessions,
  deleteCachedAgentSession,
  getCachedAgentSession,
  getCachedAgentSessionCount,
  getCachedAgentSessions,
  setCachedAgentSession,
} from '../stores';
import {
  findReplaySafeStartIndex,
  retainReplaySafeItems,
} from '../utils/agent-session-items';
import {
  buildAgentSessionId,
  DEFAULT_SESSION_LABEL,
  normalizeSessionLabel,
} from '../utils/session-label';
import { agentsRuntimeManager } from './client';
import { systemPromptVersion } from './prompt';

const TRACKED_MESSAGE_ID_CAP = 200;

type PersistedAgentSession = IDiscordAgentSession | ISteamAgentSession;
type SessionUpdate
  = | UpdateQuery<IDiscordAgentSession>
    | UpdateQuery<ISteamAgentSession>;
interface SessionUpdateOptions {
  upsert?: boolean;
}

function getSessionFilter(
  surface: ConversationSurface,
  conversationId: string,
  accountId = DEFAULT_SESSION_LABEL,
): { channelId: string } | { accountId: string; profileId: string } {
  return surface === 'discord'
    ? { channelId: conversationId }
    : { accountId, profileId: conversationId };
}

async function updateSessionDocument(
  surface: ConversationSurface,
  conversationId: string,
  update: SessionUpdate,
  options?: SessionUpdateOptions,
  accountId?: string | null,
): Promise<void> {
  if (surface === 'discord') {
    await DiscordAgentSession.updateOne(
      getSessionFilter(surface, conversationId),
      update,
      options,
    );
    return;
  }

  await SteamAgentSession.updateOne(
    getSessionFilter(surface, conversationId, accountId ?? undefined),
    update,
    options,
  );
}

async function findActiveSessionDocument(
  surface: ConversationSurface,
  conversationId: string,
  accountId?: string | null,
): Promise<PersistedAgentSession | null> {
  if (surface === 'discord') {
    return DiscordAgentSession.findOne({
      channelId: conversationId,
      isActive: true,
      provider: 'openai-agents',
    });
  }

  return SteamAgentSession.findOne({
    accountId: accountId ?? DEFAULT_SESSION_LABEL,
    profileId: conversationId,
    isActive: true,
    provider: 'openai-agents',
  });
}

async function upsertSessionDocument(
  surface: ConversationSurface,
  conversationId: string,
  update: SessionUpdate,
  accountId?: string | null,
): Promise<void> {
  if (surface === 'discord') {
    await DiscordAgentSession.findOneAndUpdate(
      { channelId: conversationId },
      update,
      { upsert: true },
    );
    return;
  }

  await SteamAgentSession.findOneAndUpdate(
    { accountId: accountId ?? DEFAULT_SESSION_LABEL, profileId: conversationId },
    update,
    { upsert: true },
  );
}

const SUMMARY_SYSTEM_PROMPT = `You maintain Ruyi's compacted conversation memory.

Return only the refreshed summary text. No preface, markdown heading, JSON, or code fence.

Keep:
- Durable facts, preferences, names, relationships, projects, and decisions.
- Open threads, unresolved requests, promised follow-ups, and current tasks.
- Important surface context such as channels/profile IDs, message/comment IDs, user names, URLs, permissions, and actions taken.
- Tool calls only when their outcome matters later: tool name, purpose, result, errors, IDs, URLs, files, or destructive/admin action taken.

Prune:
- Raw tool payloads, base64/blob data, long JSON, repeated search listings, transient call metadata, and routine successful tool chatter.
- Passing moods, small talk with no future relevance, duplicate facts, and obsolete intermediate reasoning.

Write in concise bullets or short paragraphs. Preserve enough context that a future assistant can answer follow-ups without seeing the old raw items.`;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) { return value; }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') { return value; }
  if (value === undefined) { return ''; }

  try {
    return JSON.stringify(value);
  } catch (error) {
    aiLogger.debug({ error }, 'Failed to serialize content value');
    return '[unserializable value]';
  }
}

function contentPartToText(part: unknown): string {
  if (typeof part === 'string') { return part; }

  const record = asRecord(part);
  if (!record) { return stringifyUnknown(part); }

  if (typeof record.text === 'string') { return record.text; }
  if (typeof record.refusal === 'string') { return `[refusal] ${record.refusal}`; }
  if (typeof record.image === 'string') { return '[image]'; }

  return stringifyUnknown(record);
}

function contentToText(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map(contentPartToText).filter(Boolean).join(' ');
  }
  return stringifyUnknown(content);
}

function itemLabel(record: Record<string, unknown>): string {
  if (typeof record.role === 'string') { return record.role; }
  if (typeof record.type === 'string') { return record.type; }
  return 'item';
}

function itemBody(record: Record<string, unknown>): string {
  const name = typeof record.name === 'string' ? record.name : 'unknown';

  if (record.type === 'function_call') {
    return `${name} args=${truncateText(
      stringifyUnknown(record.arguments),
      500,
    )}`;
  }

  if (record.type === 'function_call_result') {
    return `${name} output=${truncateText(
      stringifyUnknown(record.output),
      900,
    )}`;
  }

  if ('content' in record) { return contentToText(record.content); }

  return stringifyUnknown(record);
}

function formatItemForSummary(item: AgentInputItem, index: number): string {
  const record = asRecord(item);
  const body = record ? itemBody(record) : stringifyUnknown(item);
  const label = record ? itemLabel(record) : 'item';

  return `${index}. ${label}: ${truncateText(
    body,
    AGENT_SESSION_COMPACTION_ITEM_MAX_LEN,
  )}`;
}

function serializeItemsForSummary(items: AgentInputItem[]): string {
  return items
    .map((item, index) => formatItemForSummary(item, index + 1))
    .join('\n');
}

function retainedStartIndex(items: AgentInputItem[]): number {
  const start = Math.max(0, items.length - AGENT_SESSION_RECENT_ITEM_KEEP);
  return findReplaySafeStartIndex(items, start);
}

function buildSummaryPrompt(
  existingSummary: string | null,
  compactedItems: AgentInputItem[],
): string {
  const previousSummary = existingSummary
    ? truncateText(existingSummary, AGENT_SESSION_SUMMARY_MAX_LEN)
    : '(none)';

  return `Previous compacted summary:
${previousSummary}

Older raw session items to fold into the summary:
${serializeItemsForSummary(compactedItems)}

Refresh the compacted channel summary. Keep it under ${AGENT_SESSION_SUMMARY_MAX_LEN} characters.`;
}

async function summarizeCompactedItems(
  existingSummary: string | null,
  compactedItems: AgentInputItem[],
  model: string,
  modelSettings: ModelSettings,
): Promise<string> {
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    AGENT_SESSION_COMPACTION_TIMEOUT_MS,
  );

  try {
    const agent = new Agent({
      name: 'Ruyi channel summarizer',
      instructions: SUMMARY_SYSTEM_PROMPT,
      model,
      modelSettings,
    });

    const result = await agentsRuntimeManager
      .getRunner()
      .run(agent, buildSummaryPrompt(existingSummary, compactedItems), {
        maxTurns: 1,
        signal: abortController.signal,
      });

    const raw
      = typeof result.finalOutput === 'string' ? result.finalOutput.trim() : '';
    if (!raw) { throw new Error('Summary compaction returned empty output'); }

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

interface SeedSessionData {
  items: AgentInputItem[];
  messageIds: string[];
}

interface PersistedCompactionInput {
  accountId: string | null;
  conversationId: string;
  existingSummary: string | null;
  items: AgentInputItem[];
  model: string;
  modelSettings: ModelSettings;
  promptVersion: string;
  surface: ConversationSurface;
}

async function compactItemsIntoSummary(
  items: AgentInputItem[],
  existingSummary: string | null,
  model: string,
  modelSettings: ModelSettings,
): Promise<SessionCompactionResult | null> {
  const start = retainedStartIndex(items);
  if (start <= 0) { return null; }

  const compactedItems = items.slice(0, start);
  const retainedItems = items.slice(start);
  const summary = await summarizeCompactedItems(
    existingSummary,
    compactedItems,
    model,
    modelSettings,
  );

  return {
    items: retainedItems,
    summary,
    compactedCount: compactedItems.length,
  };
}

class MongoAgentSession implements Session {
  private invalidated = false;

  constructor(
    private readonly surface: ConversationSurface,
    private readonly conversationId: string,
    private readonly accountId: string | null,
    private readonly sessionId: string,
    private readonly model: string,
    private readonly modelSettings: ModelSettings,
    private readonly promptVersion: string,
    private items: AgentInputItem[],
    private summary: string | null,
  ) {}

  matchesConfiguration(model: string, promptVersion: string): boolean {
    return (
      !this.invalidated
      && this.model === model
      && this.promptVersion === promptVersion
    );
  }

  markInvalidated(): void {
    this.invalidated = true;
    this.items = [];
    this.summary = null;
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (this.invalidated) { return []; }
    if (limit === undefined) { return [...this.items]; }
    return this.items.slice(-limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (this.invalidated) { return; }
    this.items = [...this.items, ...items];
    await this.persist();
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    if (this.invalidated) { return undefined; }
    const item = this.items.pop();
    await this.persist();
    return item;
  }

  async clearSession(): Promise<void> {
    if (this.invalidated) { return; }
    this.items = [];
    await this.persist();
  }

  async runCompaction(args?: OpenAIResponsesCompactionArgs): Promise<void> {
    if (this.invalidated) { return; }

    const shouldCompact
      = args?.force === true
        || this.items.length > AGENT_SESSION_COMPACTION_TRIGGER_ITEMS;
    if (!shouldCompact) {
      return;
    }

    try {
      const result = await compactItemsIntoSummary(
        this.items,
        this.summary,
        this.model,
        this.modelSettings,
      );
      if (!result) { return; }

      this.summary = result.summary;
      this.items = result.items;
      await this.persistCompaction();

      aiLogger.info(
        {
          surface: this.surface,
          conversationId: this.conversationId,
          compactedCount: result.compactedCount,
          retainedCount: result.items.length,
          summaryLength: result.summary.length,
        },
        'Agent session compacted into conversation summary',
      );
    } catch (error) {
      await this.trimAfterFailedCompaction();
      aiLogger.warn(
        {
          error: (error as Error).message,
          stack: (error as Error).stack,
          name: (error as Error).name,
          surface: this.surface,
          conversationId: this.conversationId,
          itemCount: this.items.length,
        },
        'Agent session compaction failed; retaining raw session items',
      );
    }
  }

  private async persist(): Promise<void> {
    if (this.invalidated) { return; }

    await updateSessionDocument(
      this.surface,
      this.conversationId,
      {
        $set: {
          sessionId: this.sessionId,
          provider: 'openai-agents',
          model: this.model,
          items: this.items,
          ...(this.surface === 'steam' && this.accountId
            ? { accountId: this.accountId }
            : {}),
          lastUsed: new Date(),
          isActive: true,
          promptVersion: this.promptVersion,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
      this.accountId,
    );
  }

  private async persistCompaction(): Promise<void> {
    if (this.invalidated) { return; }

    await updateSessionDocument(
      this.surface,
      this.conversationId,
      {
        $set: {
          summary: this.summary ?? '',
          summaryUpdatedAt: new Date(),
          items: this.items,
          lastUsed: new Date(),
          model: this.model,
          promptVersion: this.promptVersion,
        },
      },
      undefined,
      this.accountId,
    );
  }

  private async trimAfterFailedCompaction(): Promise<void> {
    if (this.invalidated) { return; }
    if (this.items.length <= AGENT_SESSION_ITEM_CAP) { return; }

    const originalCount = this.items.length;
    this.items = retainReplaySafeItems(this.items, AGENT_SESSION_ITEM_CAP);
    await this.persist();

    aiLogger.warn(
      {
        surface: this.surface,
        conversationId: this.conversationId,
        originalCount,
        retainedCount: this.items.length,
      },
      'Agent session exceeded hard cap after failed compaction; trimmed raw items',
    );
  }
}

function toAgentItems(doc: PersistedAgentSession): AgentInputItem[] {
  return doc.items as AgentInputItem[];
}

async function compactPersistedItemsIfNeeded({
  accountId,
  conversationId,
  existingSummary,
  items,
  model,
  modelSettings,
  promptVersion,
  surface,
}: PersistedCompactionInput): Promise<{
  items: AgentInputItem[];
  summary: string | null;
}> {
  if (items.length <= AGENT_SESSION_COMPACTION_TRIGGER_ITEMS) {
    return { items, summary: existingSummary };
  }

  try {
    const result = await compactItemsIntoSummary(
      items,
      existingSummary,
      model,
      modelSettings,
    );
    if (!result) { return { items, summary: existingSummary }; }

    await updateSessionDocument(
      surface,
      conversationId,
      {
        $set: {
          items: result.items,
          summary: result.summary,
          summaryUpdatedAt: new Date(),
          lastUsed: new Date(),
          model,
          promptVersion,
        },
      },
      undefined,
      accountId,
    );

    aiLogger.info(
      {
        surface,
        conversationId,
        compactedCount: result.compactedCount,
        retainedCount: result.items.length,
        summaryLength: result.summary.length,
      },
      'Compacted loaded agent session before replay',
    );

    return { items: result.items, summary: result.summary };
  } catch (error) {
    aiLogger.warn(
      {
        error: (error as Error).message,
        stack: (error as Error).stack,
        name: (error as Error).name,
        surface,
        conversationId,
        itemCount: items.length,
      },
      'Failed to compact loaded agent session; using existing raw items',
    );
    return {
      items: retainReplaySafeItems(items, AGENT_SESSION_ITEM_CAP),
      summary: existingSummary,
    };
  }
}

function normalizeMessageIds(messageIds: Array<string | undefined>): string[] {
  return [...new Set(messageIds.filter((id): id is string => Boolean(id)))];
}

function upsertAssistantReplyLink(
  replies: IDiscordAgentSession['assistantReplies'],
  userMessageId: string,
  assistantMessageIds: string[],
): IDiscordAgentSession['assistantReplies'] {
  const now = new Date();
  const nextReplies = replies.filter(
    reply => reply.userMessageId !== userMessageId,
  );
  const existing = replies.find(
    reply => reply.userMessageId === userMessageId,
  );

  nextReplies.push({
    userMessageId,
    assistantMessageIds,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  return nextReplies.slice(-TRACKED_MESSAGE_ID_CAP);
}

async function buildSeedSessionData(
  surface: ConversationSurface,
  conversationId: string,
  accountId: string | null,
  currentMessageId?: string,
): Promise<SeedSessionData> {
  if (surface === 'steam') {
    const conversation = await SteamConversation.findOne({
      accountId: accountId ?? DEFAULT_SESSION_LABEL,
      profileId: conversationId,
    });
    if (!conversation || conversation.messages.length === 0) {
      return { items: [], messageIds: [] };
    }

    const messages = conversation.messages
      .filter(message => message.commentId !== currentMessageId)
      .slice(-AGENT_SESSION_SEED_MESSAGE_LIMIT);

    return {
      items: messages.map((message) => {
        const content = `${message.authorName}: ${message.content}`;
        return message.isBot ? assistant(content) : user(content);
      }),
      messageIds: normalizeMessageIds(
        messages.map(message => message.commentId),
      ),
    };
  }

  const conversation = await DiscordConversation.findOne({
    channelId: conversationId,
  });
  if (!conversation || conversation.messages.length === 0) {
    return { items: [], messageIds: [] };
  }

  const messages = conversation.messages
    .filter(message => message.messageId !== currentMessageId)
    .slice(-AGENT_SESSION_SEED_MESSAGE_LIMIT);

  const items = messages.map((message) => {
    const content = `${message.author}: ${message.content}`;
    return message.isBot ? assistant(content) : user(content);
  });

  return {
    items,
    messageIds: normalizeMessageIds(
      messages.map(message => message.messageId),
    ),
  };
}

class SessionManager {
  async loadPersisted(): Promise<void> {
    try {
      const [discordCount, steamCount] = await Promise.all([
        DiscordAgentSession.countDocuments({ isActive: true }),
        SteamAgentSession.countDocuments({ isActive: true }),
      ]);
      aiLogger.info(
        { discordCount, steamCount },
        'Agent sessions are persisted in Mongo and will be loaded lazily',
      );
    } catch (error) {
      aiLogger.error({ error }, 'Failed to inspect persisted agent sessions');
    }
  }

  private cacheKey(
    surface: ConversationSurface,
    conversationId: string,
    accountId?: string | null,
  ): string {
    return surface === 'steam'
      ? `${surface}:${accountId ?? DEFAULT_SESSION_LABEL}:${conversationId}`
      : `${surface}:${conversationId}`;
  }

  async getOrCreate(
    conversationId: string,
    currentMessageId?: string,
    model = agentsRuntimeManager.model,
    modelSettings = agentsRuntimeManager.modelSettings,
    surface: ConversationSurface = 'discord',
    promptVersion = systemPromptVersion,
    sessionLabel = DEFAULT_SESSION_LABEL,
  ): Promise<MongoAgentSession> {
    const normalizedSessionLabel = normalizeSessionLabel(sessionLabel);
    const accountId = surface === 'steam' ? sessionLabel : null;
    const cacheKey = this.cacheKey(surface, conversationId, accountId);
    const existingSession = getCachedAgentSession<MongoAgentSession>(cacheKey);
    if (existingSession) {
      if (existingSession.matchesConfiguration(model, promptVersion)) {
        aiLogger.debug(
          { surface, conversationId, sessionLabel: normalizedSessionLabel },
          'Using cached agent session',
        );
        await this.touchSession(
          surface,
          conversationId,
          model,
          currentMessageId,
          accountId,
        );
        return existingSession;
      }

      existingSession.markInvalidated();
      deleteCachedAgentSession(cacheKey);
      await updateSessionDocument(surface, conversationId, {
        $set: { isActive: false },
      }, undefined, accountId);
      aiLogger.info(
        {
          surface,
          conversationId,
          currentModel: model,
          promptVersion,
          sessionLabel: normalizedSessionLabel,
        },
        'Cached agent session configuration changed; creating fresh agent session',
      );
    }

    const persistedSession = await findActiveSessionDocument(
      surface,
      conversationId,
      accountId,
    );

    if (persistedSession) {
      const promptVersionMatches
        = persistedSession.promptVersion === promptVersion;
      const modelMatches = persistedSession.model === model;

      if (promptVersionMatches && modelMatches) {
        const compactedSession = await compactPersistedItemsIfNeeded({
          accountId,
          conversationId,
          existingSummary: persistedSession.summary ?? null,
          items: toAgentItems(persistedSession),
          model,
          modelSettings,
          promptVersion,
          surface,
        });
        const session = new MongoAgentSession(
          surface,
          conversationId,
          accountId,
          persistedSession.sessionId,
          model,
          modelSettings,
          promptVersion,
          compactedSession.items,
          compactedSession.summary,
        );
        setCachedAgentSession(cacheKey, session);
        await this.touchSession(
          surface,
          conversationId,
          model,
          currentMessageId,
          accountId,
        );

        aiLogger.debug(
          {
            surface,
            conversationId,
            sessionId: persistedSession.sessionId,
            sessionLabel: normalizedSessionLabel,
          },
          'Loaded agent session from Mongo',
        );
        return session;
      }

      aiLogger.info(
        {
          surface,
          conversationId,
          sessionId: persistedSession.sessionId,
          storedVersion: persistedSession.promptVersion,
          currentVersion: promptVersion,
          storedModel: persistedSession.model,
          currentModel: model,
          sessionLabel: normalizedSessionLabel,
        },
        'Agent session configuration changed; creating fresh agent session',
      );
      await updateSessionDocument(surface, conversationId, {
        $set: { isActive: false },
      }, undefined, accountId);
    }

    const sessionId = buildAgentSessionId({
      conversationId,
      label: normalizedSessionLabel,
      surface,
    });
    const seedData = await buildSeedSessionData(
      surface,
      conversationId,
      accountId,
      currentMessageId,
    );
    const userMessageIds = normalizeMessageIds([
      ...seedData.messageIds,
      currentMessageId,
    ]).slice(-TRACKED_MESSAGE_ID_CAP);
    const session = new MongoAgentSession(
      surface,
      conversationId,
      accountId,
      sessionId,
      model,
      modelSettings,
      promptVersion,
      seedData.items,
      null,
    );

    const setFields
      = surface === 'discord'
        ? { userMessageIds }
        : { accountId: accountId ?? DEFAULT_SESSION_LABEL, processedCommentIds: userMessageIds };

    await upsertSessionDocument(surface, conversationId, {
      $set: {
        sessionId,
        provider: 'openai-agents',
        model,
        items: seedData.items,
        ...setFields,
        lastUsed: new Date(),
        isActive: true,
        promptVersion,
      },
      $setOnInsert: { createdAt: new Date() },
    }, accountId);

    setCachedAgentSession(cacheKey, session);

    aiLogger.info(
      {
        surface,
        conversationId,
        sessionId,
        sessionLabel: normalizedSessionLabel,
        seedCount: seedData.items.length,
      },
      'Created new agent session',
    );

    return session;
  }

  private async touchSession(
    surface: ConversationSurface,
    conversationId: string,
    model: string,
    currentMessageId?: string,
    accountId?: string | null,
  ): Promise<void> {
    const idArrayField
      = surface === 'discord' ? 'userMessageIds' : 'processedCommentIds';
    const update
      = currentMessageId && currentMessageId.length > 0
        ? {
            $push: {
              [idArrayField]: {
                $each: [currentMessageId],
                $slice: -TRACKED_MESSAGE_ID_CAP,
              },
            },
            $set: {
              lastUsed: new Date(),
              model,
            },
          }
        : {
            $set: {
              lastUsed: new Date(),
              model,
            },
          };

    await updateSessionDocument(surface, conversationId, update, undefined, accountId);
  }

  async invalidate(
    conversationId: string,
    surface: ConversationSurface = 'discord',
    sessionLabel = DEFAULT_SESSION_LABEL,
  ): Promise<void> {
    const accountId = surface === 'steam' ? sessionLabel : null;
    const cacheKey = this.cacheKey(surface, conversationId, accountId);
    getCachedAgentSession(cacheKey)?.markInvalidated();
    deleteCachedAgentSession(cacheKey);

    await updateSessionDocument(surface, conversationId, {
      $set: { isActive: false },
    }, undefined, accountId);

    aiLogger.debug({ surface, conversationId }, 'Agent session invalidated');
  }

  async invalidateAll(reason: string): Promise<void> {
    const activeCount = getCachedAgentSessionCount();
    for (const session of getCachedAgentSessions()) {
      session.markInvalidated();
    }
    clearCachedAgentSessions();

    const [discordResult, steamResult] = await Promise.all([
      DiscordAgentSession.updateMany(
        { isActive: true, provider: 'openai-agents' },
        { $set: { isActive: false } },
      ),
      SteamAgentSession.updateMany(
        { isActive: true, provider: 'openai-agents' },
        { $set: { isActive: false } },
      ),
    ]);

    aiLogger.info(
      {
        reason,
        activeCount,
        modifiedCount: discordResult.modifiedCount + steamResult.modifiedCount,
      },
      'All active agent sessions invalidated',
    );
  }

  async recordAssistantMessages(
    channelId: string,
    userMessageId: string,
    messageIds: string[],
  ): Promise<void> {
    if (messageIds.length === 0) { return; }

    const session = await DiscordAgentSession.findOne({
      channelId,
      isActive: true,
      provider: 'openai-agents',
    });
    if (!session) { return; }

    session.assistantMessageIds = normalizeMessageIds([
      ...session.assistantMessageIds,
      ...messageIds,
    ]).slice(-TRACKED_MESSAGE_ID_CAP);
    session.assistantReplies = upsertAssistantReplyLink(
      session.assistantReplies,
      userMessageId,
      messageIds,
    );
    session.lastUsed = new Date();
    await session.save();
  }

  async getAssistantReplyIdsForUserMessage(
    channelId: string,
    userMessageId: string,
  ): Promise<string[]> {
    const session = await DiscordAgentSession.findOne(
      {
        channelId,
        'provider': 'openai-agents',
        'assistantReplies.userMessageId': userMessageId,
      },
      { 'assistantReplies.$': 1 },
    ).sort({ lastUsed: -1 });
    return session?.assistantReplies[0]?.assistantMessageIds ?? [];
  }

  async invalidateIfUserMessageEdited(
    channelId: string,
    messageId: string,
  ): Promise<boolean> {
    const session = await DiscordAgentSession.exists({
      channelId,
      isActive: true,
      provider: 'openai-agents',
      userMessageIds: messageId,
    });
    if (!session) { return false; }

    await this.invalidate(channelId);
    aiLogger.info(
      { channelId, messageId },
      'Invalidated agent session because a tracked Discord message was edited',
    );
    return true;
  }

  async invalidateIfAssistantMessageDeleted(
    channelId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.invalidateIfAssistantMessagesDeleted(channelId, [messageId]);
  }

  async invalidateIfAssistantMessagesDeleted(
    channelId: string,
    messageIds: string[],
  ): Promise<boolean> {
    return this.invalidateIfTrackedMessagesDeleted(channelId, messageIds);
  }

  async invalidateIfTrackedMessagesDeleted(
    channelId: string,
    messageIds: string[],
  ): Promise<boolean> {
    const uniqueMessageIds = [...new Set(messageIds)].filter(Boolean);
    if (uniqueMessageIds.length === 0) { return false; }

    const session = await DiscordAgentSession.exists({
      channelId,
      isActive: true,
      provider: 'openai-agents',
      $or: [
        { assistantMessageIds: { $in: uniqueMessageIds } },
        { userMessageIds: { $in: uniqueMessageIds } },
      ],
    });

    if (!session) { return false; }

    await this.invalidate(channelId);
    aiLogger.info(
      { channelId, messageIds: uniqueMessageIds },
      'Invalidated agent session because tracked Discord messages were deleted',
    );
    return true;
  }

  async destroyAll(): Promise<void> {
    clearCachedAgentSessions();
  }

  getActiveCount(): number {
    return getCachedAgentSessionCount();
  }
}

export const sessionManager = new SessionManager();
