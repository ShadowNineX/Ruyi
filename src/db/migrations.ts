import type { Types } from 'mongoose';
import mongoose from 'mongoose';
import { env } from '../env';
import { dbLogger } from '../logger';
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

interface IndexDroppableCollection {
  dropIndex: (indexName: string) => Promise<unknown>;
}

async function collectionExists(name: string): Promise<boolean> {
  const collections = await getDb().listCollections({ name }).toArray();
  return collections.length > 0;
}

async function dropCollectionIfExists(name: string): Promise<void> {
  if (!(await collectionExists(name))) { return; }

  await getDb().collection(name).drop();
  dbLogger.info({ collection: name }, 'Dropped obsolete collection');
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

async function clearPersistedAgentSessionReplayItems(): Promise<void> {
  const collectionName = 'discord_agent_sessions';
  if (!(await collectionExists(collectionName))) { return; }

  const collection = getDb().collection(collectionName);
  const result = await collection.updateMany(
    { 'items.0': { $exists: true } },
    { $set: { items: [] } },
  );
  if (result.modifiedCount === 0) { return; }

  dbLogger.info(
    { collection: collectionName, modified: result.modifiedCount },
    'Cleared persisted OpenAI agent replay items',
  );
}

async function dropSteamCollections(): Promise<void> {
  await Promise.all([
    dropCollectionIfExists('steam_conversations'),
    dropCollectionIfExists('steam_agent_sessions'),
    dropCollectionIfExists('steam_comment_states'),
  ]);

  const configs = getDb().collection<ConfigDocument>('configs');
  const result = await configs.deleteMany({
    key: { $regex: /^steam:/ },
  });
  if (result.deletedCount > 0) {
    dbLogger.info(
      { removed: result.deletedCount },
      'Removed obsolete Steam config keys',
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
    id: '2026-06-17-smithery-connection-id-format',
    run: removeInvalidSmitheryConnectionIds,
  },
  {
    id: '2026-06-26-clear-agent-session-replay-items',
    run: clearPersistedAgentSessionReplayItems,
  },
  {
    id: '2026-06-30-remove-steam-integration-state',
    run: dropSteamCollections,
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
