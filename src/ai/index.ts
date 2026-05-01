// Main AI module - re-exports all public APIs

// Client management
export { copilotClientManager } from "./client";

// Session management
export { sessionManager } from "./session";

// Context and memory
export { conversationContext, type ChatMessage } from "./context";

// Chat
export { chatService, type ChatOptions } from "./chat";

// Classifier
export { replyClassifier } from "./classifier";

// Permissions
export { permissionManager, type PermissionContext } from "./permissions";

// System prompt
export { systemPrompt } from "./prompt";

// Auto-extraction (c.ai-style long-term memory)
export { autoExtractFacts } from "./extraction";

// Convenience shutdown
import { sessionManager } from "./session";
import { copilotClientManager } from "./client";
import { aiLogger } from "../logger";

export async function shutdownCopilotClient(): Promise<void> {
  aiLogger.info(
    { sessionCount: sessionManager.getActiveCount() },
    "Shutting down Copilot client",
  );

  await sessionManager.destroyAll();
  await copilotClientManager.stop();

  aiLogger.info("Copilot client shutdown complete");
}
