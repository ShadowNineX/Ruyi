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

interface DatabaseMigration {
  id: string;
  run: () => Promise<void>;
}

interface ConversationMigrationMessage {
  messageId?: string | null;
  isBot?: boolean;
}

interface ConversationMigrationDocument {
  messages?: ConversationMigrationMessage[];
}

interface AgentSessionMigrationDocument {
  userMessageIds?: string[];
  assistantMessageIds?: string[];
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
  if (!(await collectionExists(collectionName))) return false;
  await getDb().dropCollection(collectionName);
  return true;
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
      if (!(await collectionExists(SMITHERY_CONNECTIONS_COLLECTION))) {
        dbLogger.info(
          { collection: SMITHERY_CONNECTIONS_COLLECTION, deletedCount: 0 },
          "Brave Smithery connection cleanup skipped",
        );
        return;
      }

      const result = await getDb()
        .collection(SMITHERY_CONNECTIONS_COLLECTION)
        .deleteMany({ serverId: "brave" });

      dbLogger.info(
        {
          collection: SMITHERY_CONNECTIONS_COLLECTION,
          deletedCount: result.deletedCount,
        },
        "Brave Smithery connection cleanup complete",
      );
    },
  },
  {
    id: "2026-06-12-remove-github-smithery-connection",
    run: async () => {
      if (!(await collectionExists(SMITHERY_CONNECTIONS_COLLECTION))) {
        dbLogger.info(
          { collection: SMITHERY_CONNECTIONS_COLLECTION, deletedCount: 0 },
          "GitHub Smithery connection cleanup skipped",
        );
        return;
      }

      const result = await getDb()
        .collection(SMITHERY_CONNECTIONS_COLLECTION)
        .deleteMany({ serverId: "github" });

      dbLogger.info(
        {
          collection: SMITHERY_CONNECTIONS_COLLECTION,
          deletedCount: result.deletedCount,
        },
        "GitHub Smithery connection cleanup complete",
      );
    },
  },
  {
    id: "2026-06-12-normalize-message-sync-state",
    run: async () => {
      let conversationMatched = 0;
      let conversationModified = 0;
      let agentSessionsInitialized = 0;

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
        conversationMatched = result.matchedCount;
        conversationModified = result.modifiedCount;
      }

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
        agentSessionsInitialized =
          userIdsResult.modifiedCount + assistantIdsResult.modifiedCount;
      }

      dbLogger.info(
        {
          conversationMatched,
          conversationModified,
          agentSessionsInitialized,
        },
        "Message sync state normalization complete",
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
