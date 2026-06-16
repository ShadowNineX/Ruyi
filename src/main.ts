import { connectDB, runDatabaseMigrations } from "./db";
import { configManager } from "./config";
import {
  agentsRuntimeManager,
  sessionManager,
  conversationContext,
  shutdownAgentsRuntime,
} from "./ai";
import { ruyiBot } from "./discord/bot";
import { allTools } from "./tools";
import { mcpRegistry } from "./mcp";
import { countConnectedSmitheryConnections } from "./db/models";
import { logger, botLogger } from "./logger";
import { steamProfileCommentService } from "./steam/service";

// Connect to MongoDB first (needed for Smithery connections)
await connectDB();
await runDatabaseMigrations();

// Log Smithery Connect status with a light health check.
await mcpRegistry.logHealth();

logger.info(
  {
    local: allTools.map((t) => t.name),
    smitheryConnections: await countConnectedSmitheryConnections(),
    totalLocalTools: allTools.length,
  },
  "Tools registered",
);

// Load config and conversation cache from DB
await configManager.load();
await conversationContext.loadLastInteractions();

// Initialize the OpenAI Agents runtime and inspect persisted sessions
agentsRuntimeManager.initialize();
await sessionManager.loadPersisted();

// Start the bot
ruyiBot.registerEvents();
ruyiBot.start();
void steamProfileCommentService.start();

// Graceful shutdown handling
async function shutdown(signal: string): Promise<void> {
  botLogger.info({ signal }, "Shutting down gracefully");
  steamProfileCommentService.stop();
  await shutdownAgentsRuntime();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Catch-all safety nets so async failures don't disappear silently.
process.on("unhandledRejection", (reason) => {
  const err = reason as Error;
  logger.error(
    {
      error: err?.message ?? String(reason),
      stack: err?.stack,
      name: err?.name,
    },
    "Unhandled promise rejection",
  );
});

process.on("uncaughtException", (error) => {
  logger.fatal(
    { error: error.message, stack: error.stack, name: error.name },
    "Uncaught exception — shutting down",
  );
  // Best-effort cleanup, then exit.
  void shutdown("uncaughtException").catch(() => process.exit(1));
});
