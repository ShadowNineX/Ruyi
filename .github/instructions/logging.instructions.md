---
description: "Logging and error-handling conventions across src/. Use when: writing or reviewing any catch block, logger call, or user-facing error path."
applyTo: "src/**/*.ts"
---

# Logging & Error Handling Rules

## Use the right child logger

Import from [src/logger.ts](../../src/logger.ts). Never use `console.*`. Choose by module:

| Logger | Use in |
|---|---|
| `botLogger` | [src/bot.ts](../../src/bot.ts), [src/utils/messages.ts](../../src/utils/messages.ts), [src/utils/chatSession.ts](../../src/utils/chatSession.ts), [src/slashCommands/](../../src/slashCommands/), [src/commands/](../../src/commands/) |
| `aiLogger` | [src/ai/](../../src/ai/) |
| `toolLogger` | [src/tools/](../../src/tools/) |
| `mcpLogger` | [src/mcp/](../../src/mcp/) |
| `dbLogger` | [src/db/](../../src/db/) |
| `syncLogger` | [src/services/messageSync.ts](../../src/services/messageSync.ts) |
| `logger` (root) | [src/main.ts](../../src/main.ts) only |

Root level comes from `env.LOG_LEVEL` ([src/env.ts](../../src/env.ts)).

## Structured logs only

First arg is the context object, second is the message:

```ts
botLogger.error(
  {
    error: (error as Error).message,
    stack: (error as Error).stack,
    name: (error as Error).name,
    channelId: message.channel.id,
    user: message.author.username,
    messageId: message.id,
  },
  "Failed to send reply",
);
```

Canonical fields (include any that apply): `error`, `stack`, `name`, `status` / `code`, `channelId`, `user`, `messageId`, `tool`, `command`, `referencedMessageId`.

## No silent catches

Banned patterns:

```ts
.catch(() => {})             // ❌
.catch(() => false)          // ❌  (unless followed by a logged debug)
} catch { return null; }     // ❌
} catch { /* ignore */ }     // ❌
```

Required: at minimum a `.debug()` log with the error message and enough context to identify which code path swallowed it. Existence-probe catches (e.g., `messageExists`) are the only exception, and even those should comment why they are silent.

## User-facing error text

For Discord replies that surface an error to the user, **always** route through `getErrorMessage(error)` in [src/utils/messages.ts](../../src/utils/messages.ts). It maps HTTP `402` / `429` / `502` / `503` to friendly Ruyi-voice strings — keep that mapping consistent. Do not write inline strings like `"Something went wrong"`.

## Throw vs. return

- `chatService.chat()` ([src/ai/chat.ts](../../src/ai/chat.ts)) returns `string | null` and **throws** on error so `bot.ts` can surface a meaningful message via `getErrorMessage`. `null` means "model returned empty" only.
- Tools must **never throw**; return `{ ok: false, error: "..." }` so the model can recover.
- Slash-command handlers must `reply` / `editReply` in their catch (otherwise Discord shows "interaction failed") **and** log via `botLogger.error` with `command` + `userId`.

## Process-level safety

[src/main.ts](../../src/main.ts) registers `unhandledRejection` and `uncaughtException` handlers. Don't add ad-hoc handlers elsewhere — log at the source.

## Reply UX inside catch

When a catch awaits `message.reply(...)`, wrap that reply in its own try/catch and log a separate `botLogger.error` if it fails. A failed error-reply must not crash the handler.
