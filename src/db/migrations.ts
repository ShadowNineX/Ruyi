import { dbLogger } from "../logger";
import { getConfigValue, setConfigValue } from "./models";

const MIGRATION_CONFIG_PREFIX = "db:migration:";
const COMPLETE = "complete";
const PENDING = "pending";

interface DatabaseMigration {
  id: string;
  run: () => Promise<void>;
}

const migrations: DatabaseMigration[] = [];

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
