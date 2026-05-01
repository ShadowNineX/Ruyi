# Ruyi Agent Instructions

Ruyi is a Discord bot (Nine Sols themed AI companion) built on Bun + TypeScript ESM. It uses the GitHub Copilot SDK for LLM chat with function calling, MongoDB for persistence, and MCP servers for external tools.

## Run / Build

- Install: `bun install`
- Dev (watch): `bun run dev` (alias for `bun run --watch src/main.ts`)
- Type-check: `bunx tsc --noEmit` (no `build` script; Bun runs TS directly)
- Required env: `DISCORD_TOKEN`, `MODEL_TOKEN`. Optional: `MONGO_URI`, `MODEL_NAME` (default `openrouter/auto`), `LOG_LEVEL`, `GITHUB_TOKEN`, `LASTFM_API_KEY`, `SMITHERY_ACCESS_TOKEN`, `PROVISIONING_KEY`, `DEBUG_PROMPTS`.
- All env access goes through [src/env.ts](src/env.ts) (zod-validated, fail-fast at startup). Do **not** read `Bun.env` directly.

## Architecture (boot → reply)

1. [src/main.ts](src/main.ts) — boots DB ([src/db/index.ts](src/db/index.ts)), config + memory caches, MCP health check, then `startBot()`. Registers SIGINT/SIGTERM + `unhandledRejection` / `uncaughtException` safety nets.
2. [src/bot.ts](src/bot.ts) — Discord events. `handleAIChat()` is the main reply pipeline: gate → typing → tool context → `chatService.chat()` → chunk reply → persist.
3. [src/ai/](src/ai/) — split package, re-exported via [src/ai/index.ts](src/ai/index.ts):
   - `client.ts` — Copilot SDK client manager (one logical client, multiple sessions).
   - `session.ts` — `sessionManager` keyed by Discord channel id; persists/restores `CopilotSession` rows.
   - `chat.ts` — `chatService.chat()`. Returns `string | null`; **throws on error** so [src/bot.ts](src/bot.ts) can surface a meaningful message via `getErrorMessage()` in [src/utils/messages.ts](src/utils/messages.ts). `null` means "model returned empty" only.
   - `context.ts` — splits incoming chat history into a "Reply context" (cited thread, non-bot only) and "Recent channel activity" (ambient, non-bot only). The bot's own past replies come from `CopilotSession`, not from re-feeding history.
   - `prompt.ts` — Ruyi persona + tool-usage hints. Wraps everything in XML-like `<context>` / `<instructions>` blocks.
   - `classifier.ts` — `replyClassifier.shouldReply()` lightweight LLM yes/no gate. Failures default to no-response.
   - `permissions.ts` — interactive Discord prompt for sensitive tool calls (`permissionManager`).
   - `extraction.ts` — c.ai-style auto memory extraction (background fact storage).
4. [src/utils/chatSession.ts](src/utils/chatSession.ts) — `ChatSession` owns the live status embed + typing interval; tool start/finish events update the embed and pause typing.
5. [src/utils/messages.ts](src/utils/messages.ts) — `fetchReplyChain`, `fetchChatHistory`, `fetchReferencedMessage`, `sendReplyChunks` (≤2000 chars per chunk, protects URLs/code blocks), `getErrorMessage` (maps 402/429/502/503 → friendly text).

## Tools (function calling)

- All tools live in [src/tools/](src/tools/) and are exported via the `allTools` array in [src/tools/index.ts](src/tools/index.ts).
- Tools that produce their own Discord output (embed, image) must be added to `selfRespondingToolNames` in the same file so an empty assistant reply is non-fatal.
- Pattern: build with `defineTool(name, { description, parameters: z.object({...}), handler })` from `@github/copilot-sdk`. Discord context (channel/guild/message/referencedMessage) flows through `runWithToolContext()` + `toolContextManager.get()` in [src/utils/types.ts](src/utils/types.ts) — [src/bot.ts](src/bot.ts) wraps each chat turn in `runWithToolContext(toolCtx, () => chatService.chat(...))` so tools see the active context via `AsyncLocalStorage`. Tools must guard against null channel/guild and return structured error objects (not throw).
- MCP-backed tools live in [src/mcp/](src/mcp/) (`brave`, `github`, `youtube`, `smithery`). Health-checked at boot via [src/mcp/index.ts](src/mcp/index.ts).
- Memory tools enforce per-user scope by Discord username, truncate values to `MEMORY_VALUE_MAX_LEN`, and evict past `USER_MEMORY_CAP` / global cap. See [src/tools/memory.ts](src/tools/memory.ts).

## Persistence

- Mongoose models in [src/db/models/](src/db/models/): `Config`, `Conversation` (channel history, 100-message cap), `Memory` (global + user), `CopilotSession` (per-channel session state — source of truth for the bot's own past replies; bot replies are stored once anchored to the first chunk's id), `SmitheryToken`.
- [src/services/messageSync.ts](src/services/messageSync.ts) periodically prunes DB rows for messages deleted in Discord. Rate-limited; do not duplicate this work elsewhere.
- `connectDB()` exits the process on disconnect/error after the initial connect.

## Commands

- Message commands use a Mongo-cached prefix from [src/config.ts](src/config.ts). Currently only `!ping` in [src/commands/](src/commands/).
- Slash commands registered at startup from [src/slashCommands/](src/slashCommands/): `/prefix`, `/credits`, `/smithery`, `/memories`. Add new ones to the `slashCommands` array and the `handleSlashCommand` switch in [src/slashCommands/index.ts](src/slashCommands/index.ts).

## Logging & error handling

- Use child loggers from [src/logger.ts](src/logger.ts): `botLogger`, `aiLogger`, `toolLogger`, `syncLogger`, `mcpLogger`, `dbLogger`. Root level comes from `env.LOG_LEVEL`.
- Every `catch` should log structured context (`channelId`, `user`, `tool`, `messageId`, `error.message`, `stack`, `name` as available). Avoid silent `.catch(() => {})` and bare `} catch { ... }` — at minimum debug-log them.
- User-facing failure text comes from `getErrorMessage(error)` in [src/utils/messages.ts](src/utils/messages.ts); prefer it over inline strings so HTTP status mapping stays consistent.
- Slash-command handlers must reply/editReply on error (otherwise Discord shows "interaction failed") **and** log via `botLogger`.

## Persona / system prompt

Ruyi speaks with authentic Nine Sols cadence (formal, deferential — "your humble servant", "please forgive my apprehension"), English by default, no speaker prefixes, embraces being an AI character, and must use `memory_recall` / `memory_store` for personal facts. Tool-usage hints live in [src/ai/prompt.ts](src/ai/prompt.ts) — keep them in sync when adding tools.

## Conventions

- TypeScript strict; **no `any`**. Tools are typed via `defineTool()` inference from `@github/copilot-sdk`.
- When adding a tool: append to `allTools`, mark self-responding if applicable, and ensure the tool only accesses Discord context via `toolContextManager.get()`.
- Keep cognitive complexity under 15 per function. Extract handlers from large switch statements (see [src/tools/role.ts](src/tools/role.ts), [src/tools/memory.ts](src/tools/memory.ts)).
- Mongo writes must be bounded (slices, caps) — never unbounded growth.

If a section here looks stale relative to the current code, fix it — this file is the contract for new agents.
