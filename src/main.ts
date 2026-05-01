import { connectDB } from "./db";
import { configManager } from "./config";
import {
  copilotClientManager,
  sessionManager,
  conversationContext,
  shutdownCopilotClient,
} from "./ai";
import { ruyiBot } from "./bot";
import { allTools } from "./tools";
import { mcpRegistry } from "./mcp";
import { SmitheryMCPServer } from "./mcp/smithery";
import { mcpConnectionManager } from "./mcp/client";
import { logger, botLogger } from "./logger";

// Connect to MongoDB first (needed for Smithery tokens)
await connectDB();

// Initialize Smithery tokens from database
const smitheryStatus = await SmitheryMCPServer.initializeTokens();
if (!smitheryStatus.brave && !smitheryStatus.youtube) {
  logger.warn("No Smithery tokens found. Run /smithery to authorize.");
} else {
  const authorized: string[] = [];
  if (smitheryStatus.brave) authorized.push("Brave");
  if (smitheryStatus.youtube) authorized.push("YouTube");
  logger.info({ authorized }, "Smithery tokens loaded");
}

// Log MCP server status with health check
await mcpRegistry.logHealth();

// Initialize MCP tools via wrapper (connects to Smithery servers)
const mcpTools = await mcpConnectionManager.initialize();

logger.info(
  {
    local: allTools.map((t) => t.name),
    mcp: mcpTools.map((t) => t.name),
    total: allTools.length + mcpTools.length,
  },
  "Tools registered",
);

// Load config and conversation cache from DB
await configManager.load();
await conversationContext.loadLastInteractions();

// Initialize the CopilotClient and load persisted sessions
await copilotClientManager.initialize();
await sessionManager.loadPersisted();

// Start the bot
ruyiBot.registerEvents();
ruyiBot.start();

// Graceful shutdown handling
async function shutdown(signal: string): Promise<void> {
  botLogger.info({ signal }, "Shutting down gracefully");
  await mcpConnectionManager.closeAll();
  await shutdownCopilotClient();
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
