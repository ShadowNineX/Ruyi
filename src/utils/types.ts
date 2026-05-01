import { AsyncLocalStorage } from "node:async_hooks";
import type { Message, TextChannel, Guild } from "discord.js";
import { toolLogger } from "../logger";

export interface ToolContext {
  message: Message | null;
  channel: TextChannel | null;
  guild: Guild | null;
  referencedMessage: Message | null;
}

// Shared result type for message resolution
export type MessageResolutionResult =
  | { success: true; message: Message }
  | { success: false; error: string };

const EMPTY_CONTEXT: ToolContext = {
  message: null,
  channel: null,
  guild: null,
  referencedMessage: null,
};

const toolContextStore = new AsyncLocalStorage<ToolContext>();

/**
 * Run `fn` with the given tool context bound to the current async scope.
 * Tools called transitively from `fn` will see this context via
 * `toolContextManager.get()`.
 *
 * This replaces the previous global-mutation approach, which had a
 * concurrency bug when multiple channels chatted simultaneously.
 */
export function runWithToolContext<T>(
  ctx: ToolContext,
  fn: () => Promise<T>,
): Promise<T> {
  return toolContextStore.run(ctx, fn);
}

/**
 * Backwards-compatible facade over the AsyncLocalStorage-backed context.
 * Tools should keep calling `toolContextManager.get()` /
 * `toolContextManager.resolveTargetMessage(...)` exactly as before.
 */
class ToolContextFacade {
  get(): ToolContext {
    return toolContextStore.getStore() ?? EMPTY_CONTEXT;
  }

  async resolveTargetMessage(
    messageId: string | null,
    toolName: string,
  ): Promise<MessageResolutionResult> {
    const ctx = this.get();
    if (!ctx.channel) {
      toolLogger.warn(`No channel context available for ${toolName}`);
      return { success: false, error: "No channel context available" };
    }

    const channel = ctx.channel;
    if (!("messages" in channel)) {
      return {
        success: false,
        error: "Cannot access messages in this channel type",
      };
    }

    try {
      let targetMessage: Message | null | undefined;

      if (messageId === "replied") {
        targetMessage = ctx.referencedMessage;
        if (!targetMessage) {
          return {
            success: false,
            error: "The user did not reply to any message",
          };
        }
      } else if (messageId) {
        targetMessage = await channel.messages.fetch(messageId);
      } else {
        targetMessage = ctx.message;
      }

      if (!targetMessage) {
        return { success: false, error: "Could not find the target message" };
      }

      return { success: true, message: targetMessage };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: errorMessage };
    }
  }
}

export const toolContextManager = new ToolContextFacade();

// Format error for JSON response
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
