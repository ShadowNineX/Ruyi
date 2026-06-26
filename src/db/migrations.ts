import type { Types } from 'mongoose';
import mongoose from 'mongoose';
import { env } from '../env';
import { dbLogger } from '../logger';
import {
  buildAgentSessionId,
  normalizeSessionLabel,
} from '../utils/session-label';
import { isValidSmitheryConnectionId } from '../utils/smithery-connection-id';
import { getConfigValue, setConfigValue } from './models';

type MongoObjectId = Types.ObjectId;

const MIGRATION_CONFIG_PREFIX = 'db:migration:';
const COMPLETE = 'complete';
const PENDING = 'pending';

interface DatabaseMigration {
  id: string;
  run: () => Promise<void>;
}

interface ConfigDocument {
  key: string;
  value: string;
}

interface LegacyMemoryDocument {
  _id: MongoObjectId;
  key?: string;
  scope?: string;
  personId?: string;
  scopeKind?: string;
  scopeId?: string;
  userId?: string;
  pinned?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

interface SmitheryConnectionMigrationDocument {
  _id: MongoObjectId;
  connectionId?: string;
}

interface SteamAgentSessionMigrationDocument {
  _id: MongoObjectId;
  accountId?: string;
  createdAt?: Date;
  profileId?: string;
  sessionId?: string;
}

interface SteamAccountScopedMigrationDocument {
  _id: MongoObjectId;
  accountId?: string;
  profileId?: string;
}

interface IndexDroppableCollection {
  dropIndex: (indexName: string) => Promise<unknown>;
}

async function collectionExists(name: string): Promise<boolean> {
  const collections = await getDb().listCollections({ name }).toArray();
  return collections.length > 0;
}

function getDb() {
  const db = mongoose.connection.db;
  if (!db) { throw new Error('MongoDB connection is not ready'); }
  return db;
}

async function mergeCollectionByKey(
  sourceName: string,
  targetName: string,
  key: string,
): Promise<void> {
  if (!(await collectionExists(sourceName))) { return; }

  const source = getDb().collection<Record<string, unknown>>(sourceName);
  const target = getDb().collection<Record<string, unknown>>(targetName);
  const documents = await source.find({}).toArray();

  for (const document of documents) {
    const keyValue = document[key];
    if (keyValue === undefined || keyValue === null) { continue; }
    const { _id: sourceId, ...fields } = document;
    const setOnInsert = sourceId === undefined ? {} : { _id: sourceId };
    await target.updateOne(
      { [key]: keyValue },
      { $set: fields, $setOnInsert: setOnInsert },
      { upsert: true },
    );
  }

  await source.drop();
  dbLogger.info(
    { source: sourceName, target: targetName, count: documents.length },
    'Merged legacy collection into platform-specific collection',
  );
}

function ownerPersonIdForDiscordUser(discordUserId: string): string {
  return env.OWNER_DISCORD_USER_ID === discordUserId
    ? 'owner'
    : `discord:${discordUserId}`;
}

function getMemoryDedupeKey(memory: LegacyMemoryDocument): string | null {
  if (!memory.key || !memory.personId) { return null; }
  return `${memory.personId}\u0000${memory.key}`;
}

function memorySortTime(memory: LegacyMemoryDocument): number {
  return (
    memory.updatedAt?.getTime()
    ?? memory.createdAt?.getTime()
    ?? 0
  );
}

function chooseMemoryToKeep(
  left: LegacyMemoryDocument,
  right: LegacyMemoryDocument,
): LegacyMemoryDocument {
  if (left.pinned && !right.pinned) { return left; }
  if (right.pinned && !left.pinned) { return right; }
  return memorySortTime(right) > memorySortTime(left) ? right : left;
}

function isIndexMissingError(error: unknown): boolean {
  const candidate = error as { codeName?: unknown; code?: unknown };
  return candidate.codeName === 'IndexNotFound' || candidate.code === 27;
}

async function dropIndexIfExists(
  collection: IndexDroppableCollection,
  indexName: string,
): Promise<void> {
  try {
    await collection.dropIndex(indexName);
    dbLogger.info({ indexName }, 'Dropped obsolete index');
  } catch (error) {
    if (isIndexMissingError(error)) {
      dbLogger.debug({ indexName }, 'Obsolete index was already absent');
      return;
    }
    throw error;
  }
}

async function dedupePersonMemories(): Promise<void> {
  const memories = getDb().collection<LegacyMemoryDocument>('memories');
  const grouped = new Map<string, LegacyMemoryDocument[]>();
  const personMemories = await memories
    .find({ key: { $type: 'string' }, personId: { $type: 'string' } })
    .toArray();

  for (const memory of personMemories) {
    const dedupeKey = getMemoryDedupeKey(memory);
    if (!dedupeKey) { continue; }
    grouped.set(dedupeKey, [...(grouped.get(dedupeKey) ?? []), memory]);
  }

  const removedIds: MongoObjectId[] = [];
  for (const duplicates of grouped.values()) {
    if (duplicates.length <= 1) { continue; }
    const [firstDuplicate, ...remainingDuplicates] = duplicates;
    if (!firstDuplicate) { continue; }
    const keeper = remainingDuplicates.reduce(
      (selectedMemory, candidateMemory) =>
        chooseMemoryToKeep(selectedMemory, candidateMemory),
      firstDuplicate,
    );
    removedIds.push(
      ...duplicates
        .filter(memory => memory._id !== keeper._id)
        .map(memory => memory._id),
    );
  }

  if (removedIds.length === 0) { return; }
  await memories.deleteMany({ _id: { $in: removedIds } });
  dbLogger.info(
    { removed: removedIds.length },
    'Removed duplicate memories before person-scoped unique index',
  );
}

async function migrateScopedConfigKeys(): Promise<void> {
  const configs = getDb().collection<ConfigDocument>('configs');
  const legacyEntries = await configs
    .find({ key: { $regex: /^(guild|dm):/ } })
    .toArray();

  for (const entry of legacyEntries) {
    const nextKey = `discord:${entry.key}`;
    await configs.updateOne(
      { key: nextKey },
      { $set: { key: nextKey, value: entry.value } },
      { upsert: true },
    );
    await configs.deleteOne({ key: entry.key });
  }

  if (legacyEntries.length > 0) {
    dbLogger.info(
      { count: legacyEntries.length },
      'Migrated Discord config keys to platform-prefixed scope',
    );
  }
}

async function migrateMemoryPersonIds(): Promise<void> {
  const memories = getDb().collection<LegacyMemoryDocument>('memories');
  const writableMemories = await memories
    .find({ personId: { $exists: false }, userId: { $type: 'string' } })
    .toArray();

  for (const memory of writableMemories) {
    const userId = memory.userId;
    if (!userId) { continue; }
    await memories.updateOne(
      { _id: memory._id },
      { $set: { personId: ownerPersonIdForDiscordUser(userId) } },
    );
  }

  await Promise.all(
    [
      'key_1_scope_1_userId_1',
      'scope_1_userId_1_pinned_1',
      'key_1_scopeKind_1_scopeId_1',
      'scopeKind_1_scopeId_1_pinned_1',
      'key_1_scopeKind_1_scopeId_1_userId_1',
      'scopeKind_1_scopeId_1_userId_1_pinned_1',
    ].map(indexName => dropIndexIfExists(memories, indexName)),
  );

  const removedUnowned = await memories.deleteMany({
    personId: { $exists: false },
  });
  if (removedUnowned.deletedCount > 0) {
    dbLogger.info(
      { removed: removedUnowned.deletedCount },
      'Removed memories without code-derived person ownership',
    );
  }

  const normalized = await memories.updateMany(
    { personId: { $type: 'string' } },
    {
      $set: { scope: 'user' },
      $unset: {
        scopeKind: '',
        scopeId: '',
        userId: '',
      },
    },
  );
  if (normalized.modifiedCount > 0) {
    dbLogger.info(
      { modified: normalized.modifiedCount },
      'Normalized memories to person-scoped user memories',
    );
  }

  await dedupePersonMemories();
  await memories.createIndex({ key: 1, personId: 1 }, { unique: true });
  await memories.createIndex({ personId: 1, pinned: 1 });

  if (writableMemories.length > 0) {
    dbLogger.info(
      { count: writableMemories.length },
      'Backfilled person IDs for existing memories',
    );
  }
}

async function migrateStoredDiscordScopeKinds(): Promise<void> {
  for (const collectionName of ['reminders', 'smitheryconnections']) {
    if (!(await collectionExists(collectionName))) { continue; }
    const collection = getDb().collection(collectionName);
    const guildResult = await collection.updateMany(
      { scopeKind: 'guild' },
      { $set: { scopeKind: 'discord:guild' } },
    );
    const dmResult = await collection.updateMany(
      { scopeKind: 'dm' },
      { $set: { scopeKind: 'discord:dm' } },
    );
    const modified = guildResult.modifiedCount + dmResult.modifiedCount;
    if (modified > 0) {
      dbLogger.info(
        { collection: collectionName, modified },
        'Migrated stored Discord scope kinds',
      );
    }
  }
}

async function resetSteamCommentTrackingToCheckpoint(): Promise<void> {
  if (!(await collectionExists('steam_comment_states'))) { return; }
  const collection = getDb().collection('steam_comment_states');
  const result = await collection.updateMany(
    {},
    {
      $set: {
        seenCommentIds: [],
        lastCheckedAt: new Date(),
      },
    },
  );

  if (result.modifiedCount > 0) {
    dbLogger.info(
      { modified: result.modifiedCount },
      'Reset Steam comment tracking to checkpoint mode',
    );
  }
}

async function removeInvalidSmitheryConnectionIds(): Promise<void> {
  if (!(await collectionExists('smitheryconnections'))) { return; }

  const collection = getDb().collection<SmitheryConnectionMigrationDocument>(
    'smitheryconnections',
  );
  const connections = await collection.find({}).toArray();
  const invalidIds = connections
    .filter(connection => !isValidSmitheryConnectionId(connection.connectionId))
    .map(connection => connection._id);

  if (invalidIds.length === 0) { return; }

  await collection.deleteMany({ _id: { $in: invalidIds } });
  dbLogger.info(
    { removed: invalidIds.length },
    'Removed invalid Smithery connection IDs',
  );
}

function isDigitText(value: string): boolean {
  if (value.length === 0) { return false; }

  for (const character of value) {
    if (character < '0' || character > '9') { return false; }
  }

  return true;
}

function getSessionIdTimestamp(
  session: SteamAgentSessionMigrationDocument,
): number | string {
  const sessionId = session.sessionId ?? '';
  const lastDashIndex = sessionId.lastIndexOf('-');
  const suffix = lastDashIndex >= 0 ? sessionId.slice(lastDashIndex + 1) : '';
  if (isDigitText(suffix)) { return suffix; }

  return session.createdAt?.getTime() ?? Date.now();
}

async function migrateSteamAgentSessionLabels(): Promise<void> {
  if (!(await collectionExists('steam_agent_sessions'))) { return; }
  if (env.STEAM_ACCOUNTS.length === 0) { return; }

  const labelByProfileId = new Map(
    env.STEAM_ACCOUNTS.map(account => [
      account.botSteamId64,
      normalizeSessionLabel(account.id),
    ]),
  );
  const collection = getDb().collection<SteamAgentSessionMigrationDocument>(
    'steam_agent_sessions',
  );
  const sessions = await collection
    .find({ profileId: { $in: [...labelByProfileId.keys()] } })
    .toArray();

  let modified = 0;
  for (const session of sessions) {
    const { profileId } = session;
    if (!profileId) { continue; }

    const label = labelByProfileId.get(profileId);
    if (!label) { continue; }

    const expectedPrefix = `${label}-steam-${profileId}-`;
    if (session.sessionId?.startsWith(expectedPrefix)) { continue; }

    await collection.updateOne(
      { _id: session._id },
      {
        $set: {
          sessionId: buildAgentSessionId({
            conversationId: profileId,
            label,
            surface: 'steam',
            timestamp: getSessionIdTimestamp(session),
          }),
        },
      },
    );
    modified += 1;
  }

  if (modified > 0) {
    dbLogger.info(
      { modified },
      'Relabeled Steam agent session IDs for configured accounts',
    );
  }
}

async function createSteamAccountScopedIndex(
  collectionName: string,
): Promise<void> {
  const collection = getDb().collection(collectionName);
  await dropIndexIfExists(collection, 'profileId_1');
  await collection.createIndex({ accountId: 1, profileId: 1 }, { unique: true });
  await collection.createIndex({ accountId: 1 });
  await collection.createIndex({ profileId: 1 });
}

async function backfillSteamCollectionAccountIds(
  collectionName: string,
): Promise<number> {
  if (!(await collectionExists(collectionName))) { return 0; }
  const collection = getDb().collection<SteamAccountScopedMigrationDocument>(
    collectionName,
  );

  let modified = 0;
  for (const account of env.STEAM_ACCOUNTS) {
    const result = await collection.updateMany(
      { profileId: account.botSteamId64 },
      { $set: { accountId: account.id } },
    );
    modified += result.modifiedCount;
  }

  const removed = await collection.deleteMany({
    $or: [
      { accountId: { $exists: false } },
      { accountId: { $type: 'null' } },
    ],
  });

  if (removed.deletedCount > 0) {
    dbLogger.info(
      { collection: collectionName, removed: removed.deletedCount },
      'Removed Steam documents without configured account ownership',
    );
  }

  await createSteamAccountScopedIndex(collectionName);
  return modified;
}

async function migrateSteamAccountScopedState(): Promise<void> {
  if (env.STEAM_ACCOUNTS.length === 0) { return; }

  const modifiedCounts = await Promise.all(
    [
      'steam_conversations',
      'steam_agent_sessions',
      'steam_comment_states',
    ].map(backfillSteamCollectionAccountIds),
  );
  const modified = modifiedCounts.reduce(
    (total, count) => total + count,
    0,
  );

  if (modified > 0) {
    dbLogger.info(
      { modified },
      'Backfilled Steam account IDs for account-scoped chat state',
    );
  }
}

async function clearPersistedAgentSessionReplayItems(): Promise<void> {
  for (const collectionName of [
    'discord_agent_sessions',
    'steam_agent_sessions',
  ]) {
    if (!(await collectionExists(collectionName))) { continue; }

    const collection = getDb().collection(collectionName);
    const result = await collection.updateMany(
      { 'items.0': { $exists: true } },
      { $set: { items: [] } },
    );
    if (result.modifiedCount === 0) { continue; }

    dbLogger.info(
      { collection: collectionName, modified: result.modifiedCount },
      'Cleared persisted OpenAI agent replay items',
    );
  }
}

const migrations: DatabaseMigration[] = [
  {
    id: '2026-06-16-platform-history-split',
    run: async () => {
      await mergeCollectionByKey(
        'conversations',
        'discord_conversations',
        'channelId',
      );
      await mergeCollectionByKey(
        'agentsessions',
        'discord_agent_sessions',
        'channelId',
      );
      await migrateScopedConfigKeys();
      await migrateStoredDiscordScopeKinds();
      await migrateMemoryPersonIds();
    },
  },
  {
    id: '2026-06-16-steam-comment-checkpoint-mode',
    run: resetSteamCommentTrackingToCheckpoint,
  },
  {
    id: '2026-06-17-smithery-connection-id-format',
    run: removeInvalidSmitheryConnectionIds,
  },
  {
    id: '2026-06-24-steam-agent-session-account-labels',
    run: migrateSteamAgentSessionLabels,
  },
  {
    id: '2026-06-24-steam-account-scoped-chat-state',
    run: migrateSteamAccountScopedState,
  },
  {
    id: '2026-06-26-clear-agent-session-replay-items',
    run: clearPersistedAgentSessionReplayItems,
  },
];

export async function runDatabaseMigrations(): Promise<void> {
  for (const migration of migrations) {
    const key = `${MIGRATION_CONFIG_PREFIX}${migration.id}`;
    const status = await getConfigValue(key, PENDING);
    if (status === COMPLETE) { continue; }

    dbLogger.info({ migration: migration.id }, 'Running database migration');
    await migration.run();
    await setConfigValue(key, COMPLETE);
    dbLogger.info({ migration: migration.id }, 'Database migration complete');
  }
}
