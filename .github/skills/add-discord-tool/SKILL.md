---
name: add-discord-tool
description: "Scaffold a new Discord tool for Ruyi: create the file in src/tools/, register it in src/tools/index.ts (with optional self-responding flag), and add a hint in src/ai/prompt.ts. Use when the user asks to add/create a new tool, function, or capability for the bot."
---

# Add a Discord Tool

This skill scaffolds a new tool end-to-end. Follow every step — partial work leaves the tool uncallable by the model.

## 1. Gather requirements

Before writing code, confirm with the user:

1. **Tool name** (snake_case, e.g. `pin_message`). This is what the model sees.
2. **One-line description** for the model (when to use it).
3. **Parameters** with types + per-field descriptions.
4. **Side effects:** does it send its own Discord output (embed/image/message)? If yes → it's a "self-responding" tool.
5. **Sensitive?** Roles, bulk delete, pin/unpin, etc. should defer to `permissionManager` ([src/ai/permissions.ts](../../../src/ai/permissions.ts)).

If any are missing, ask the user before generating files.

## 2. Create the tool file

Path: `src/tools/<name>.ts`. Follow [tools.instructions.md](../../instructions/tools.instructions.md). Template:

```ts
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toolLogger } from "../logger";
import { toolContextManager } from "../utils/types";

export const <camelName>Tool = defineTool("<snake_name>", {
  description: "<one sentence describing when the model should call this>",
  parameters: z.object({
    // describe every field — the model reads these
  }),
  handler: async (params) => {
    const ctx = toolContextManager.get();
    if (!ctx.channel || !ctx.guild) {
      return { ok: false, error: "No Discord context available" };
    }
    try {
      // ...
      toolLogger.info({ tool: "<snake_name>", ...params }, "Tool ran");
      return { ok: true /*, ...result*/ };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toolLogger.error(
        { tool: "<snake_name>", error: message, stack: (error as Error).stack },
        "Tool failed",
      );
      return { ok: false, error: message };
    }
  },
});
```

For role/permission-sensitive tools, add a `permissionManager.requestPermission(...)` call before the side effect — see [src/tools/role.ts](../../../src/tools/role.ts) as a reference.

For tools that operate on a target message, prefer `toolContextManager.resolveTargetMessage(messageId, "<snake_name>")` to handle the `"replied"` sentinel uniformly.

## 3. Register in `allTools`

Edit [src/tools/index.ts](../../../src/tools/index.ts):

1. Add the named re-export at the top: `export { <camelName>Tool } from "./<name>";`
2. Add the matching import block lower down.
3. Append `<camelName>Tool` to the `allTools` array.
4. **If self-responding** (step 1 question 4), also add `"<snake_name>"` to `selfRespondingToolNames`. Otherwise an empty assistant reply triggers the no-response fallback.

## 4. Update the persona's tool hints

Edit [src/ai/prompt.ts](../../../src/ai/prompt.ts) so Ruyi knows when to reach for the new tool. Match the existing tone (deferential, brief). Keep all hints in sync — don't add new hint sections, fold into existing ones.

## 5. Validate

Run:

```sh
bunx tsc --noEmit
```

Expected: clean. If errors, fix them — `defineTool` infers types from the Zod schema, so most issues come from schema mismatches with the handler's destructured params.

## 6. Final report to user

Reply with:

- File created (`src/tools/<name>.ts`).
- Whether the tool was marked self-responding.
- Whether `prompt.ts` was updated and what hint was added.
- Any open questions about behaviour the user should verify.

## Reference tools

| Pattern | Example |
|---|---|
| Pure function, no Discord context | [src/tools/calc.ts](../../../src/tools/calc.ts) |
| Self-responding (sends embed) | [src/tools/embed.ts](../../../src/tools/embed.ts) |
| Self-responding (image) | [src/tools/image.ts](../../../src/tools/image.ts) |
| Sensitive + permission-gated | [src/tools/role.ts](../../../src/tools/role.ts), [src/tools/message.ts](../../../src/tools/message.ts) |
| Extracted handlers (complexity ≤ 15) | [src/tools/memory.ts](../../../src/tools/memory.ts) |
