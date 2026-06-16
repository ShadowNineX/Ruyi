import mongoose from "mongoose";
import { dbLogger } from "../logger";
import { getConfigValue, setConfigValue } from "./models";

const MIGRATION_CONFIG_PREFIX = "db:migration:";
const COMPLETE = "complete";
const PENDING = "pending";
const OBSOLETE_SMITHERY_TOKENS_COLLECTION = "smitherytokens";
const SMITHERY_CONNECTIONS_COLLECTION = "smitheryconnections";
const AGENT_SESSIONS_COLLECTION = "agentsessions";
const CONVERSATIONS_COLLECTION = "conversations";
const CONFIGS_COLLECTION = "configs";
const MEMORIES_COLLECTION = "memories";
const REMINDERS_COLLECTION = "reminders";
const AI_MODEL_PRESET_CONFIG_KEY = "ai:model_preset";
const PREFIX_CONFIG_KEY = "prefix";
const SEARCH_PROVIDER_CONFIG_KEY = "search:primary_provider";
const AWAY_GLOBAL_ENABLED_CONFIG_KEY = "away:global_enabled";
const AWAY_DELAY_MINUTES_CONFIG_KEY = "away:delay_minutes";
const AWAY_COOLDOWN_HOURS_CONFIG_KEY = "away:cooldown_hours";
const CONTEXT_MEMORY_UNIQUE_INDEX = "key_1_scopeKind_1_scopeId_1";
const CONTEXT_MEMORY_PINNED_INDEX = "scopeKind_1_scopeId_1_pinned_1";

interface DatabaseMigration {
  id: string;
  run: () => Promise<void>;
}

interface ConversationMigrationMessage {
  messageId?: string | null;
  isBot?: boolean;
  editedAt?: Date | null;
  editCount?: number;
}

interface ConversationMigrationDocument {
  messages?: ConversationMigrationMessage[];
}

interface AgentSessionMigrationDocument {
  userMessageIds?: string[];
  assistantMessageIds?: string[];
  assistantReplies?: unknown[];
}

interface MigrationUpdateStats {
  matched: number;
  modified: number;
}

function getDb() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("MongoDB connection is not ready for migrations");
  }
  return db;
}

async function collectionExists(collectionName: string): Promise<boolean> {
  const collections = await getDb()
    .listCollections({ name: collectionName }, { nameOnly: true })
    .toArray();
  return collections.length > 0;
}

async function dropCollectionIfExists(
  collectionName: string,
): Promise<boolean> {
  if (await collectionExists(collectionName)) {
    await getDb().dropCollection(collectionName);
    return true;
  }

  return false;
}

async function dropIndexIfExists(
  collectionName: string,
  indexName: string,
): Promise<boolean> {
  if (await collectionExists(collectionName)) {
    const collection = getDb().collection(collectionName);
    const indexes = await collection.indexes();
    const indexExists = indexes.some((index) => index.name === indexName);
    if (indexExists) {
      await collection.dropIndex(indexName);
      return true;
    }

    return false;
  }

  return false;
}

function emptyUpdateStats(): MigrationUpdateStats {
  return { matched: 0, modified: 0 };
}

function toUpdateStats(result: {
  matchedCount: number;
  modifiedCount: number;
}): MigrationUpdateStats {
  return {
    matched: result.matchedCount,
    modified: result.modifiedCount,
  };
}

async function deleteSmitheryConnectionByServerId(
  serverId: string,
  label: string,
): Promise<void> {
  if (await collectionExists(SMITHERY_CONNECTIONS_COLLECTION)) {
    const result = await getDb()
      .collection(SMITHERY_CONNECTIONS_COLLECTION)
      .deleteMany({ serverId });

    dbLogger.info(
      {
        collection: SMITHERY_CONNECTIONS_COLLECTION,
        deletedCount: result.deletedCount,
      },
      `${label} Smithery connection cleanup complete`,
    );
    return;
  }

  dbLogger.info(
    { collection: SMITHERY_CONNECTIONS_COLLECTION, deletedCount: 0 },
    `${label} Smithery connection cleanup skipped`,
  );
}

async function removeUntrackedConversationMessages(): Promise<MigrationUpdateStats> {
  if (await collectionExists(CONVERSATIONS_COLLECTION)) {
    const conversationsCollection =
      getDb().collection<ConversationMigrationDocument>(
        CONVERSATIONS_COLLECTION,
      );
    const result = await conversationsCollection.updateMany(
      {},
      {
        $pull: {
          messages: {
            $or: [
              { messageId: { $exists: false } },
              { messageId: null },
              { messageId: "" },
              { isBot: true },
            ],
          },
        },
      },
    );
    return toUpdateStats(result);
  }

  return emptyUpdateStats();
}

async function initializeConversationMessageEditState(): Promise<MigrationUpdateStats> {
  if (await collectionExists(CONVERSATIONS_COLLECTION)) {
    const conversationsCollection =
      getDb().collection<ConversationMigrationDocument>(
        CONVERSATIONS_COLLECTION,
      );
    const result = await conversationsCollection.updateMany(
      {},
      [
        {
          $set: {
            messages: {
              $map: {
                input: "$messages",
                as: "message",
                in: {
                  $mergeObjects: [
                    "$$message",
                    {
                      editedAt: { $ifNull: ["$$message.editedAt", null] },
                      editCount: { $ifNull: ["$$message.editCount", 0] },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    );
    return toUpdateStats(result);
  }

  return emptyUpdateStats();
}

async function initializeAgentSessionMessageIdArrays(): Promise<number> {
  if (await collectionExists(AGENT_SESSIONS_COLLECTION)) {
    const agentSessionsCollection =
      getDb().collection<AgentSessionMigrationDocument>(
        AGENT_SESSIONS_COLLECTION,
      );
    const userIdsResult = await agentSessionsCollection.updateMany(
      { userMessageIds: { $exists: false } },
      { $set: { userMessageIds: [] } },
    );
    const assistantIdsResult = await agentSessionsCollection.updateMany(
      { assistantMessageIds: { $exists: false } },
      { $set: { assistantMessageIds: [] } },
    );
    return userIdsResult.modifiedCount + assistantIdsResult.modifiedCount;
  }

  return 0;
}

async function initializeAgentSessionAssistantReplies(): Promise<number> {
  if (await collectionExists(AGENT_SESSIONS_COLLECTION)) {
    const agentSessionsCollection =
      getDb().collection<AgentSessionMigrationDocument>(
        AGENT_SESSIONS_COLLECTION,
      );
    const result = await agentSessionsCollection.updateMany(
      { assistantReplies: { $exists: false } },
      { $set: { assistantReplies: [] } },
    );
    return result.modifiedCount;
  }

  return 0;
}

function invalidContextUserMemoryConditions() {
  return [
    { userId: { $exists: false } },
    { userId: null },
    { userId: "" },
    { scopeKind: { $exists: false } },
    { scopeKind: { $nin: ["guild", "dm"] } },
    { scopeId: { $exists: false } },
    { scopeId: null },
    { scopeId: "" },
  ];
}

async function deleteInvalidContextUserMemories(
  collection: ReturnType<ReturnType<typeof getDb>["collection"]>,
) {
  return collection.deleteMany({
    scope: "user",
    $or: invalidContextUserMemoryConditions(),
  });
}

async function installContextUserMemoryIndexes(): Promise<{
  oldContextUniqueIndexDropped: boolean;
  oldContextPinnedIndexDropped: boolean;
}> {
  const oldContextUniqueIndexDropped = await dropIndexIfExists(
    MEMORIES_COLLECTION,
    CONTEXT_MEMORY_UNIQUE_INDEX,
  );
  const oldContextPinnedIndexDropped = await dropIndexIfExists(
    MEMORIES_COLLECTION,
    CONTEXT_MEMORY_PINNED_INDEX,
  );
  const collection = getDb().collection(MEMORIES_COLLECTION);
  await collection.createIndex(
    { key: 1, scopeKind: 1, scopeId: 1, userId: 1 },
    { unique: true },
  );
  await collection.createIndex({
    scopeKind: 1,
    scopeId: 1,
    userId: 1,
    pinned: 1,
  });

  return { oldContextUniqueIndexDropped, oldContextPinnedIndexDropped };
}

const migrations: DatabaseMigration[] = [
  {
    id: "2026-06-11-drop-legacy-smitherytokens",
    run: async () => {
      const dropped = await dropCollectionIfExists(
        OBSOLETE_SMITHERY_TOKENS_COLLECTION,
      );

      dbLogger.info(
        {
          collection: OBSOLETE_SMITHERY_TOKENS_COLLECTION,
          dropped,
        },
        "Obsolete Smithery OAuth token collection cleanup complete",
      );
    },
  },
  {
    id: "2026-06-12-remove-brave-smithery-connection",
    run: async () => {
      await deleteSmitheryConnectionByServerId("brave", "Brave");
    },
  },
  {
    id: "2026-06-12-remove-github-smithery-connection",
    run: async () => {
      await deleteSmitheryConnectionByServerId("github", "GitHub");
    },
  },
  {
    id: "2026-06-12-normalize-message-sync-state",
    run: async () => {
      const conversationStats = await removeUntrackedConversationMessages();
      const agentSessionsInitialized =
        await initializeAgentSessionMessageIdArrays();

      dbLogger.info(
        {
          conversationMatched: conversationStats.matched,
          conversationModified: conversationStats.modified,
          agentSessionsInitialized,
        },
        "Message sync state normalization complete",
      );
    },
  },
  {
    id: "2026-06-12-initialize-ai-model-preset",
    run: async () => {
      dbLogger.info(
        { obsoleteKey: AI_MODEL_PRESET_CONFIG_KEY },
        "Global AI model preset initialization skipped; scoped config uses code defaults",
      );
    },
  },
  {
    id: "2026-06-13-initialize-message-edit-state",
    run: async () => {
      const conversationStats = await initializeConversationMessageEditState();
      const agentSessionsInitialized =
        await initializeAgentSessionAssistantReplies();

      dbLogger.info(
        {
          conversationMatched: conversationStats.matched,
          conversationModified: conversationStats.modified,
          agentSessionsInitialized,
        },
        "Message edit tracking state initialized",
      );
    },
  },
  {
    id: "2026-06-13-initialize-away-message-settings",
    run: async () => {
      dbLogger.info(
        {
          obsoleteKeys: [
            AWAY_GLOBAL_ENABLED_CONFIG_KEY,
            AWAY_DELAY_MINUTES_CONFIG_KEY,
            AWAY_COOLDOWN_HOURS_CONFIG_KEY,
          ],
        },
        "Global away message initialization skipped; scoped config uses code defaults",
      );
    },
  },
  {
    id: "2026-06-13-scope-discord-config-settings",
    run: async () => {
      if (await collectionExists(CONFIGS_COLLECTION)) {
        const obsoleteGlobalKeys = [
          PREFIX_CONFIG_KEY,
          SEARCH_PROVIDER_CONFIG_KEY,
          AI_MODEL_PRESET_CONFIG_KEY,
          AWAY_GLOBAL_ENABLED_CONFIG_KEY,
          AWAY_DELAY_MINUTES_CONFIG_KEY,
          AWAY_COOLDOWN_HOURS_CONFIG_KEY,
        ];
        const result = await getDb()
          .collection(CONFIGS_COLLECTION)
          .deleteMany({
            $or: [
              { key: { $in: obsoleteGlobalKeys } },
              { key: { $regex: /^away:user:/ } },
            ],
          });

        dbLogger.info(
          {
            collection: CONFIGS_COLLECTION,
            deletedCount: result.deletedCount,
          },
          "Obsolete global Discord config cleanup complete",
        );
        return;
      }

      dbLogger.info(
        { collection: CONFIGS_COLLECTION, deletedCount: 0 },
        "Obsolete global Discord config cleanup skipped",
      );
    },
  },
  {
    id: "2026-06-13-scope-smithery-connections",
    run: async () => {
      if (await collectionExists(SMITHERY_CONNECTIONS_COLLECTION)) {
        const collection = getDb().collection(SMITHERY_CONNECTIONS_COLLECTION);
        const deleteResult = await collection.deleteMany({
          $or: [
            { scopeKind: { $exists: false } },
            { scopeId: { $exists: false } },
            { scopeKind: { $nin: ["guild", "dm"] } },
            { scopeId: "" },
          ],
        });
        const oldServerIndexDropped = await dropIndexIfExists(
          SMITHERY_CONNECTIONS_COLLECTION,
          "serverId_1",
        );
        await collection.createIndex(
          { scopeKind: 1, scopeId: 1, serverId: 1 },
          { unique: true },
        );
        await collection.createIndex({ scopeKind: 1, scopeId: 1, status: 1 });

        dbLogger.info(
          {
            collection: SMITHERY_CONNECTIONS_COLLECTION,
            deletedCount: deleteResult.deletedCount,
            oldServerIndexDropped,
          },
          "Scoped Smithery connection migration complete",
        );
        return;
      }

      dbLogger.info(
        { collection: SMITHERY_CONNECTIONS_COLLECTION, deletedCount: 0 },
        "Scoped Smithery connection migration skipped",
      );
    },
  },
  {
    id: "2026-06-13-key-user-memories-by-discord-user-id",
    run: async () => {
      if (await collectionExists(MEMORIES_COLLECTION)) {
        const collection = getDb().collection(MEMORIES_COLLECTION);
        const deleteResult = await collection.deleteMany({
          scope: "user",
          $or: [
            { userId: { $exists: false } },
            { userId: null },
            { userId: "" },
          ],
        });
        const oldUniqueIndexDropped = await dropIndexIfExists(
          MEMORIES_COLLECTION,
          "key_1_scope_1_username_1",
        );
        const oldPinnedIndexDropped = await dropIndexIfExists(
          MEMORIES_COLLECTION,
          "scope_1_username_1_pinned_1",
        );
        await collection.createIndex(
          { key: 1, scope: 1, userId: 1 },
          { unique: true },
        );
        await collection.createIndex({ scope: 1, userId: 1, pinned: 1 });

        dbLogger.info(
          {
            collection: MEMORIES_COLLECTION,
            deletedCount: deleteResult.deletedCount,
            oldUniqueIndexDropped,
            oldPinnedIndexDropped,
          },
          "User memory identity migration complete",
        );
        return;
      }

      dbLogger.info(
        { collection: MEMORIES_COLLECTION, deletedCount: 0 },
        "User memory identity migration skipped",
      );
    },
  },
  {
    id: "2026-06-13-scope-memories-by-discord-context",
    run: async () => {
      if (await collectionExists(MEMORIES_COLLECTION)) {
        const collection = getDb().collection(MEMORIES_COLLECTION);
        const nonUserDeleteResult = await collection.deleteMany({
          scope: { $ne: "user" },
        });
        const invalidDeleteResult =
          await deleteInvalidContextUserMemories(collection);
        const oldScopeUserUniqueIndexDropped = await dropIndexIfExists(
          MEMORIES_COLLECTION,
          "key_1_scope_1_userId_1",
        );
        const oldScopeUserPinnedIndexDropped = await dropIndexIfExists(
          MEMORIES_COLLECTION,
          "scope_1_userId_1_pinned_1",
        );
        const {
          oldContextUniqueIndexDropped,
          oldContextPinnedIndexDropped,
        } = await installContextUserMemoryIndexes();

        dbLogger.info(
          {
            collection: MEMORIES_COLLECTION,
            deletedNonUserCount: nonUserDeleteResult.deletedCount,
            deletedInvalidCount: invalidDeleteResult.deletedCount,
            oldScopeUserUniqueIndexDropped,
            oldScopeUserPinnedIndexDropped,
            oldContextUniqueIndexDropped,
            oldContextPinnedIndexDropped,
          },
          "Scoped memory migration complete",
        );
        return;
      }

      dbLogger.info(
        { collection: MEMORIES_COLLECTION, deletedCount: 0 },
        "Scoped memory migration skipped",
      );
    },
  },
  {
    id: "2026-06-13-enforce-context-user-memory-scope",
    run: async () => {
      if (await collectionExists(MEMORIES_COLLECTION)) {
        const collection = getDb().collection(MEMORIES_COLLECTION);
        const deleteNonUserResult = await collection.deleteMany({
          scope: { $ne: "user" },
        });
        const deleteInvalidResult =
          await deleteInvalidContextUserMemories(collection);
        const {
          oldContextUniqueIndexDropped,
          oldContextPinnedIndexDropped,
        } = await installContextUserMemoryIndexes();

        dbLogger.info(
          {
            collection: MEMORIES_COLLECTION,
            deletedNonUserCount: deleteNonUserResult.deletedCount,
            deletedInvalidCount: deleteInvalidResult.deletedCount,
            oldContextUniqueIndexDropped,
            oldContextPinnedIndexDropped,
          },
          "Context user memory enforcement complete",
        );
        return;
      }

      dbLogger.info(
        { collection: MEMORIES_COLLECTION, deletedCount: 0 },
        "Context user memory enforcement skipped",
      );
    },
  },
  {
    id: "2026-06-16-create-reminder-indexes",
    run: async () => {
      const collection = getDb().collection(REMINDERS_COLLECTION);
      await collection.createIndex({ status: 1, dueAt: 1 });
      await collection.createIndex({
        scopeKind: 1,
        scopeId: 1,
        userId: 1,
        status: 1,
        dueAt: 1,
      });

      dbLogger.info(
        { collection: REMINDERS_COLLECTION },
        "Reminder indexes ensured",
      );
    },
  },
  {
    id: "2026-06-16-initialize-reminder-processing-state",
    run: async () => {
      const collection = getDb().collection(REMINDERS_COLLECTION);
      const result = await collection.updateMany(
        { processingStartedAt: { $exists: false } },
        { $set: { processingStartedAt: null } },
      );
      await collection.createIndex({ status: 1, processingStartedAt: 1 });

      dbLogger.info(
        {
          collection: REMINDERS_COLLECTION,
          matchedCount: result.matchedCount,
          modifiedCount: result.modifiedCount,
        },
        "Reminder processing state initialized",
      );
    },
  },
  {
    id: "2026-06-16-delete-completed-reminders",
    run: async () => {
      if (!(await collectionExists(REMINDERS_COLLECTION))) {
        dbLogger.info(
          { collection: REMINDERS_COLLECTION, deletedCount: 0 },
          "Completed reminder cleanup skipped",
        );
        return;
      }

      const collection = getDb().collection(REMINDERS_COLLECTION);
      const deleteResult = await collection.deleteMany({
        status: { $nin: ["scheduled", "processing"] },
      });
      const unsetResult = await collection.updateMany(
        {},
        { $unset: { deliveredAt: "", cancelledAt: "" } },
      );

      dbLogger.info(
        {
          collection: REMINDERS_COLLECTION,
          deletedCount: deleteResult.deletedCount,
          unsetMatchedCount: unsetResult.matchedCount,
          unsetModifiedCount: unsetResult.modifiedCount,
        },
        "Completed reminder cleanup complete",
      );
    },
  },
];

export async function runDatabaseMigrations(): Promise<void> {
  for (const migration of migrations) {
    const key = `${MIGRATION_CONFIG_PREFIX}${migration.id}`;
    const status = await getConfigValue(key, PENDING);
    if (status === COMPLETE) continue;

    dbLogger.info({ migration: migration.id }, "Running database migration");
    await migration.run();
    await setConfigValue(key, COMPLETE);
    dbLogger.info({ migration: migration.id }, "Database migration complete");
  }
}
