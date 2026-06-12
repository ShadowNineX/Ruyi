import { AsyncLocalStorage } from "node:async_hooks";
import type { Message, TextChannel, Guild } from "discord.js";
import { toolLogger } from "../logger";

type ReverseImageBudgetedTool =
  | "reverse_image_search"
  | "web_search"
  | "fetch_url"
  | "describe_image";

type ToolCallCounts = Partial<Record<ReverseImageBudgetedTool, number>>;

interface ToolTurnBudget {
  reverseImageWorkflowActive: boolean;
  calls: ToolCallCounts;
  failedImageDescriptions: Record<string, string>;
}

export interface ToolContext {
  message: Message | null;
  channel: TextChannel | null;
  guild: Guild | null;
  referencedMessage: Message | null;
  toolBudget?: ToolTurnBudget;
}

// Shared result type for message resolution
export type MessageResolutionResult =
  | { success: true; message: Message }
  | { success: false; error: string };

export type ToolBudgetDecision =
  | { allowed: true }
  | {
      allowed: false;
      tool: ReverseImageBudgetedTool;
      limit: number;
      used: number;
      instruction: string;
    };

const EMPTY_CONTEXT: ToolContext = {
  message: null,
  channel: null,
  guild: null,
  referencedMessage: null,
};

const toolContextStore = new AsyncLocalStorage<ToolContext>();

const REVERSE_IMAGE_WORKFLOW_LIMITS = {
  reverse_image_search: 1,
  web_search: 1,
  fetch_url: 1,
  describe_image: 1,
} as const satisfies Record<ReverseImageBudgetedTool, number>;

const IMAGE_DESCRIPTION_DOWNLOAD_FAILURE_LIMIT = 2;

const REVERSE_IMAGE_BUDGETED_TOOLS = new Set<string>(
  Object.keys(REVERSE_IMAGE_WORKFLOW_LIMITS),
);

function createToolTurnBudget(): ToolTurnBudget {
  return {
    reverseImageWorkflowActive: false,
    calls: {},
    failedImageDescriptions: {},
  };
}

function withToolTurnBudget(ctx: ToolContext): ToolContext {
  return {
    ...ctx,
    toolBudget: ctx.toolBudget ?? createToolTurnBudget(),
  };
}

function isReverseImageBudgetedTool(
  toolName: string,
): toolName is ReverseImageBudgetedTool {
  return REVERSE_IMAGE_BUDGETED_TOOLS.has(toolName);
}

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
  return toolContextStore.run(withToolTurnBudget(ctx), fn);
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

  consumeToolCall(toolName: string): ToolBudgetDecision {
    if (!isReverseImageBudgetedTool(toolName)) return { allowed: true };

    const budget = this.get().toolBudget;
    if (!budget) return { allowed: true };

    const isReverseImageSearch = toolName === "reverse_image_search";
    if (isReverseImageSearch) {
      budget.reverseImageWorkflowActive = true;
    } else if (!budget.reverseImageWorkflowActive) {
      return { allowed: true };
    }

    const used = budget.calls[toolName] ?? 0;
    const limit = REVERSE_IMAGE_WORKFLOW_LIMITS[toolName];
    if (used >= limit) {
      return {
        allowed: false,
        tool: toolName,
        limit,
        used,
        instruction:
          "Reverse image search follow-up budget exhausted. Stop calling tools for this image and answer using the evidence already gathered. If the origin is still unconfirmed, include the manual reverse-search links from reverse_image_search.",
      };
    }

    budget.calls[toolName] = used + 1;
    return { allowed: true };
  }

  refundToolCall(toolName: string): void {
    if (!isReverseImageBudgetedTool(toolName)) return;

    const budget = this.get().toolBudget;
    if (!budget) return;

    const used = budget.calls[toolName] ?? 0;
    if (used <= 0) return;
    budget.calls[toolName] = used - 1;
  }

  isReverseImageWorkflowActive(): boolean {
    return this.get().toolBudget?.reverseImageWorkflowActive === true;
  }

  getImageDescriptionFailure(imageUrl: string): string | null {
    return this.get().toolBudget?.failedImageDescriptions[imageUrl] ?? null;
  }

  rememberImageDescriptionFailure(imageUrl: string, error: string): number {
    const budget = this.get().toolBudget;
    if (!budget) return 0;
    budget.failedImageDescriptions[imageUrl] = error;
    return Object.keys(budget.failedImageDescriptions).length;
  }

  imageDescriptionFailureLimitExceeded(): boolean {
    const budget = this.get().toolBudget;
    if (!budget) return false;
    return (
      Object.keys(budget.failedImageDescriptions).length >=
      IMAGE_DESCRIPTION_DOWNLOAD_FAILURE_LIMIT
    );
  }

  budgetDeniedResult(decision: Exclude<ToolBudgetDecision, { allowed: true }>) {
    return {
      error: "Tool budget exhausted",
      budget_exhausted: true,
      final_answer_required: true,
      tool: decision.tool,
      limit: decision.limit,
      used: decision.used,
      instruction: decision.instruction,
    };
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
