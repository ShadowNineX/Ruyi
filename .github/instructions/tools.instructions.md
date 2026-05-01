---
description: "Conventions for authoring Discord tools in src/tools/. Use when: adding a new tool, modifying an existing tool, or wiring tool context."
applyTo: "src/tools/**/*.ts"
---

# Tool Authoring Rules

All tools in [src/tools/](../../src/tools/) must follow these conventions.

## Definition

Use `defineTool` from `@github/copilot-sdk` with a Zod v4 schema:

```ts
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toolLogger } from "../logger";
import { toolContextManager } from "../utils/types";

export const myTool = defineTool("my_tool", {
  description: "One sentence the model reads to decide when to call this.",
  parameters: z.object({
    target: z.string().describe("Describe every parameter — the model reads these."),
  }),
  handler: async ({ target }) => {
    const ctx = toolContextManager.get();
    if (!ctx.channel || !ctx.guild) {
      return { ok: false, error: "No Discord context available" };
    }
    try {
      // ...do work...
      toolLogger.info({ tool: "my_tool", target }, "Tool ran");
      return { ok: true, result: "..." };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toolLogger.error({ tool: "my_tool", target, error: message }, "Tool failed");
      return { ok: false, error: message };
    }
  },
});
```

## Hard rules

- **Discord context only via `toolContextManager.get()`** — never accept `channel`/`guild`/`message` as a parameter and never reach for module globals. The bot wraps each chat turn in `runWithToolContext()` ([src/utils/types.ts](../../src/utils/types.ts)) so handlers see the active context through `AsyncLocalStorage`.
- **Guard nulls.** Always check `ctx.channel`, `ctx.guild`, `ctx.message`, `ctx.referencedMessage` before use. Return a structured error string — do **not** throw.
- **Return shape is read by the model.** Prefer `{ ok: true, ... }` / `{ ok: false, error: "..." }` so the LLM can branch correctly. Never return raw `Error` objects.
- **No `any`.** Tool typing is inferred from `defineTool()`; if you find yourself reaching for `any`, narrow the Zod schema instead.
- **Logging:** use `toolLogger` from [src/logger.ts](../../src/logger.ts), include `tool` name and key parameters. Errors must log `error.message` (and `stack` when available).

## Registration

Every new tool must be registered in [src/tools/index.ts](../../src/tools/index.ts):

1. Add `export { myTool } from "./my-file";`
2. Add the matching `import` for the array.
3. Append the tool to the `allTools` const array.
4. **If the tool produces its own visible Discord output** (sends an embed, image, message, etc.) and may legitimately leave the assistant text reply empty, add its tool name to `selfRespondingToolNames` so the bot doesn't fall back to "no response".

## Resolving target messages

For tools that operate on a referenced/by-id message, use `toolContextManager.resolveTargetMessage(messageId, "tool_name")` — it handles the `"replied"` sentinel, the by-id fetch, and the "current message" fallback uniformly.

## Permissions

Sensitive actions (role mutation, bulk delete, pin/unpin, etc.) should defer to `permissionManager` in [src/ai/permissions.ts](../../src/ai/permissions.ts) so the user can approve/deny via the interactive Discord prompt.

## Prompt hints

When you add a tool the model needs guidance for, also update the tool-usage hints in [src/ai/prompt.ts](../../src/ai/prompt.ts) so Ruyi knows when to reach for it.

## Reference examples

- Simplest: [src/tools/calc.ts](../../src/tools/calc.ts)
- Context-aware: [src/tools/embed.ts](../../src/tools/embed.ts)
- Complex with extracted handlers (cognitive complexity ≤ 15): [src/tools/memory.ts](../../src/tools/memory.ts), [src/tools/role.ts](../../src/tools/role.ts)
