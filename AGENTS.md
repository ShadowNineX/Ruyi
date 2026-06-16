# Ruyi Agent Instructions

Ruyi is a Nine Sols themed AI companion with Discord and Steam profile-comment transports, built on Bun + TypeScript ESM. It uses the OpenAI Agents SDK for LLM chat with function calling, MongoDB for persistence, and MCP servers for external tools.

## Run / Build

- Install: `bun install`
- Dev (watch): `bun run dev` (alias for `bun run --watch src/main.ts`)
- Type-check: `bun run typecheck` (or `bunx tsc --noEmit`)
- Build: `bun run build` emits `dist/main.js` via `bun build`
- Start: `bun run start` runs the compiled `dist/main.js` artifact
- Required env: `DISCORD_TOKEN`, `OPENAI_API_KEY`. Optional: `MONGO_URI`, `LOG_LEVEL`, `LASTFM_API_KEY`, `OPENAI_ADMIN_KEY` (`/credits` organization costs), `GITHUB_PERSONAL_ACCESS_TOKEN` (official GitHub MCP server), `GITHUB_MCP_URL` (defaults to GitHub's hosted MCP endpoint), `TAVILY_API_KEY`, `SCRAPECREATORS_API_KEY` (Pinterest read tools), `SMITHERY_API_KEY`, `SMITHERY_NAMESPACE`, `DEBUG_PROMPTS`. Steam profile-comment chat is optional but all-or-nothing: set all of `STEAM_REFRESH_TOKEN`, `STEAM_BOT_STEAM_ID64`, `STEAM_OWNER_STEAM_ID64`, and `OWNER_DISCORD_USER_ID`, or omit all four.
- All env access goes through [src/env.ts](src/env.ts) (zod-validated, fail-fast at startup). Do **not** read `Bun.env` directly.

## Architecture (boot → reply)

1. [src/main.ts](src/main.ts) — boots DB ([src/db/index.ts](src/db/index.ts)), config + memory caches, MCP health check, then starts Discord ([src/discord/bot.ts](src/discord/bot.ts)) and optional Steam profile-comment notifications ([src/steam/service.ts](src/steam/service.ts)). Registers SIGINT/SIGTERM + `unhandledRejection` / `uncaughtException` safety nets.
2. [src/discord/bot.ts](src/discord/bot.ts) — Discord events. `handleAIChat()` is the Discord reply pipeline: gate → typing → tool context → `chatService.chat()` → chunk reply → persist.
3. [src/ai/](src/ai/) — split package, re-exported via [src/ai/index.ts](src/ai/index.ts):
   - `client.ts` — OpenAI Agents runtime manager (one shared runner/provider).
   - `session.ts` — `sessionManager` keyed by platform-aware conversation keys: `discord:<channelId>` or `steam:<profileId>`. Discord and Steam sessions persist to separate collections.
   - `chat.ts` — `chatService.chat()`. Returns `string | null`; **throws on error** so [src/discord/bot.ts](src/discord/bot.ts) can surface a meaningful Discord message via `getErrorMessage()` in [src/discord/utils/messages.ts](src/discord/utils/messages.ts). `null` means "model returned empty" only.
   - `context.ts` — builds platform-aware context. Discord history and Steam profile-comment history stay separate; shared memories are loaded by code-derived person identity.
   - `prompt.ts` — Ruyi persona + tool-usage hints. Wraps everything in XML-like `<context>` / `<instructions>` blocks.
   - `classifier.ts` — `replyClassifier.shouldReply()` lightweight LLM structured boolean gate. Failures default to no-response.
   - `edit-classifier.ts` — semantic gate for Discord user message edits. Deterministic code may ignore obvious formatting/typo-only edits, but meaning/side-effect decisions belong in this classifier, not hardcoded keyword lists.
   - `permissions.ts` — interactive Discord prompt for sensitive tool calls (`permissionManager`).
   - `extraction.ts` — c.ai-style semantic auto memory extraction (background fact storage). It is scheduled by message count/cooldown only; do not add hardcoded phrase triggers.
4. [src/discord/utils/chat-session.ts](src/discord/utils/chat-session.ts) — `ChatSession` owns the typing interval and temporary tool-call embed. Normal thinking/generation uses Discord typing only; embeds are reserved for tool calls and permission prompts. Steam uses [src/steam/headless-session.ts](src/steam/headless-session.ts) and posts final replies only.
5. [src/discord/utils/messages.ts](src/discord/utils/messages.ts) — `fetchReplyChain`, `fetchChatHistory`, `fetchReferencedMessage`, `sendReplyChunks` (≤2000 chars per chunk, protects URLs/code blocks), `getErrorMessage` (maps 402/429/502/503 → friendly text).

## Tools (function calling)

- Shared tools live in [src/tools/](src/tools/); Discord-only tools live in [src/discord/tools/](src/discord/tools/); Steam-only tools live in [src/steam/tools/](src/steam/tools/). They are registered centrally through [src/tools/index.ts](src/tools/index.ts), which filters tools by chat surface.
- Tools that produce their own Discord output (embed, image) must be added to `selfRespondingToolNames` in the same file so an empty assistant reply is non-fatal.
- Pattern: build directly with `tool({ name, description, parameters: z.object({...}), execute })` from `@openai/agents`. Platform context flows through `runWithToolContext()` + `toolContextManager.get()` in [src/utils/types.ts](src/utils/types.ts) as a discriminated context with `surface: "discord" | "steam"`. Discord turns bind channel/guild/message/referencedMessage in [src/discord/bot.ts](src/discord/bot.ts); Steam turns bind profile/comment metadata in [src/steam/service.ts](src/steam/service.ts). Tools must guard against unavailable surface context and return structured error objects (not throw). Use the SDK's `needsApproval` option for sensitive tools.
- MCP-backed tools live in [src/mcp/](src/mcp/) and shared/Discord tool folders. GitHub uses GitHub's official `github/github-mcp-server` as a hosted MCP server tool configured by `GITHUB_PERSONAL_ACCESS_TOKEN` and `GITHUB_MCP_URL`. Smithery Connect is Discord-only for non-GitHub hosted MCP services, configured with `SMITHERY_API_KEY` + `SMITHERY_NAMESPACE`; `/smithery` creates hosted Smithery setup links and stores connection IDs/statuses per `discord:guild:<guildId>` or `discord:dm:<userId>` scope. Do not route GitHub through Smithery.
- Settings are scoped in [src/config.ts](src/config.ts): `discord:guild:<guildId>:...` for servers, `discord:dm:<userId>:...` for private chats, and `steam:profile:<profileId>:...` for Steam profile-comment chat. Do not add app-global config for server/private-chat/profile preferences. API keys and process secrets remain env-backed. If persisted config keys change, add a migration and remove obsolete keys rather than reading legacy fallbacks at runtime.
- Web search is exposed as one local `web_search` tool. It uses the Mongo-backed search provider setting for the active server/private-chat scope first for answer-mode queries, then the other built-in provider when the first one errors or produces weak/no sources. Research-mode queries go directly to Tavily first. Change the preferred provider from Discord with `/search-provider`.
- Pinterest is exposed as one local read-only `pinterest` tool backed by ScrapeCreators (`SCRAPECREATORS_API_KEY`). It supports public profile boards, board pins, pin details, and Pinterest search. Keep results bounded and never scrape Pinterest HTML directly when this tool can answer the request.
- Natural-language time/date handling is centralized in [src/utils/natural-time.ts](src/utils/natural-time.ts) and exposed to the agent as `resolve_time`. Use it for relative dates, dayparts, clock phrases, and place/timezone conversion; calendar/event features should reuse this parser instead of adding their own ad hoc date logic.
- Discord public profile metadata is centralized in [src/discord/utils/discord-profile.ts](src/discord/utils/discord-profile.ts) and exposed through `get_user_info`. It includes visible avatar/banner URLs, avatar decorations, nameplates, primary guild tag/badge, display/global names, server presence/activity when visible, and unavailable-field notes. Keep `get_user_info.include` narrow (`images`, `activity`, `member`, `roles`, or full `profile`). For "what does my avatar/banner look like?" style requests, call `get_user_info` with `include=["images"]` and then `describe_image` on the selected image URL from `images.availableImageTargets`; never infer visual content from URLs alone.
- Character.AI-style away messages live in [src/discord/services/away-messages.ts](src/discord/services/away-messages.ts). They are opt-in per user per server/private-chat scope, scope-disableable, delayed, cooldown-limited, and mention the target user with an allowed mention. Keep them sparse and contextual; do not send recurring away pings without a fresh handled conversation turn.
- Steam profile-comment chat lives in [src/steam/](src/steam/). It logs in with `steam-user`, hands web cookies to `steamcommunity`, listens for Steam `newComments` notifications, and fetches only Ruyi's configured bot Steam profile when a relevant notification arrives. Keep polling as fallback reconciliation only; do not make it the primary detection path. It ignores Ruyi's own comments, checkpoints old comments without replying, and sends new comments through `chatService.chat()` with `surface: "steam"`. Steam posts final replies only; no Discord embeds, typing, or approval UI.
- Steam profile comments use Steam BBCode-style formatting, not Discord Markdown. Keep generated/profile-posted comments under `STEAM_PROFILE_COMMENT_MAX_LENGTH`; use [src/steam/comment-format.ts](src/steam/comment-format.ts) for normalization before posting.
- `steam_profile_comment` is available to Discord and Steam turns in [src/steam/tools/profile-comment.ts](src/steam/tools/profile-comment.ts). The model can choose only `target: "bot"` or `"owner"`; code resolves those to configured Steam IDs and refuses arbitrary profile IDs. Discord-origin calls require approval and must show the target plus exact comment text before posting. Steam-origin calls are headless and auto-approved; normal Steam replies should still use the final assistant response, not this tool.
- Reverse image search is exposed as one local `reverse_image_search` tool. It creates provider-specific reverse-search links, a ready-to-post `manual_reverse_search_markdown` fallback, and recommended follow-up `web_search` calls for current/replied Discord image attachments, pasted/uploaded images, embed images, or a supplied public image URL, with modes for broad/source/product/art lookups. It defensively resolves image targets: requested message, current message, replied message, then recent channel images, and returns `image_resolved_from` plus `image_resolution_attempts`. Keep the investigation in the main Agents loop: call `reverse_image_search`, then continue with `web_search` / `fetch_url` as needed before answering. If origin/source remains unconfirmed after the follow-up tools, include the manual reverse-search links in the final reply. Do not hide a second OpenAI chat loop inside the tool.
- The main Agents loop is expected to continue autonomously across multiple tool calls. Keep `AGENT_MAX_TURNS` in [src/constants.ts](src/constants.ts) high enough for investigation chains such as reverse-image-search → web search → fetch likely pages → answer, and prefer prompt/tool-result guidance over nested LLM calls inside tools.
- Memory tools derive `personId` from code. The configured Discord owner user ID and Steam owner SteamID map to the same `owner` person; other Discord users get isolated `discord:<id>` memory, and unlinked Steam commenters are read-only/transient for v1. The AI must never provide scope IDs, guild IDs, DM IDs, Steam IDs, or user IDs as memory tool arguments. Memory values are truncated to `MEMORY_VALUE_MAX_LEN` and evicted past `USER_MEMORY_CAP`. Ruyi stores explicit memories through the main agent's `memory_store` tool and also runs semantic c.ai-style background extraction after enough user messages. See [src/tools/memory.ts](src/tools/memory.ts), [src/utils/user-identity.ts](src/utils/user-identity.ts), and [src/ai/extraction.ts](src/ai/extraction.ts).
- `search_conversation` must never scan the whole archived `DiscordConversation` collection for a normal tool call. Default to the current channel, and only allow another channel after verifying it belongs to the current guild. Private chats may search only their current DM channel.

## Persistence

- Mongoose models in [src/db/models/](src/db/models/): shared `Config` and `Memory`; Discord `DiscordConversation` and `DiscordAgentSession`; Steam `SteamConversation`, `SteamAgentSession`, and `SteamCommentState`; Discord-only `Reminder` and `SmitheryConnection`.
- Startup migrations live in [src/db/migrations.ts](src/db/migrations.ts), run immediately after `connectDB()`, and record completion in `Config` keys prefixed with `db:migration:`. Keep migrations idempotent and use them to remove obsolete collections or safely reshape stored data.
- Any change to Mongo models, stored document shape, indexes, provider IDs, persisted config keys, or message/session tracking data must include an idempotent DB migration before runtime code depends on the new shape. Data cleanup and backfills belong in migrations.
- [src/discord/services/message-sync.ts](src/discord/services/message-sync.ts) is the single path for Discord deletion sync: message delete events, bulk-delete events, the `delete_messages` tool, and the periodic sweep all remove archived message IDs and invalidate affected Discord agent sessions. Rate-limited; do not duplicate this work elsewhere.
- Discord user message edits are handled from the `MessageUpdate` event in [src/discord/bot.ts](src/discord/bot.ts): archived conversation content is updated, affected agent sessions are invalidated, and mapped assistant reply chunks are edited only when `editClassifier` says the edit meaningfully changes the answer. Do not add keyword-list edit heuristics; use the semantic classifier for intent/safety.
- `connectDB()` exits the process on disconnect/error after the initial connect.

## Commands

- Message commands use a Mongo-cached scoped prefix from [src/config.ts](src/config.ts). Currently only `!ping` in [src/discord/commands/](src/discord/commands/).
- Slash commands registered at startup from [src/discord/slash-commands/](src/discord/slash-commands/): `/prefix`, `/model`, `/search-provider`, `/credits`, `/away`, `/smithery`, `/memories`, `/reminders`, `/scrapecreators`. Add new ones to the `slashCommands` array and the `handleSlashCommand` switch in [src/discord/slash-commands/index.ts](src/discord/slash-commands/index.ts).
- OpenAI chat/vision model selection is stored in MongoDB as a server/private-chat scoped AI model preset and edited from Discord with `/model`; do not add model IDs back to `.env`.

## Logging & error handling

- Use child loggers from [src/logger.ts](src/logger.ts): `botLogger`, `aiLogger`, `toolLogger`, `syncLogger`, `mcpLogger`, `dbLogger`. Root level comes from `env.LOG_LEVEL`.
- Every `catch` should log structured context (`channelId`, `user`, `tool`, `messageId`, `error.message`, `stack`, `name` as available). Avoid silent `.catch(() => {})` and bare `} catch { ... }` — at minimum debug-log them.
- Discord user-facing failure text comes from `getErrorMessage(error)` in [src/discord/utils/messages.ts](src/discord/utils/messages.ts); prefer it over inline strings so HTTP status mapping stays consistent.
- Slash-command handlers must reply/editReply on error (otherwise Discord shows "interaction failed") **and** log via `botLogger`.

## Persona / system prompt

Ruyi speaks with authentic Nine Sols cadence (formal, deferential — "your humble servant", "please forgive my apprehension"), English by default, no speaker prefixes, embraces being an AI character, and must use `memory_recall` / `memory_store` for personal facts. Tool-usage hints live in [src/ai/prompt.ts](src/ai/prompt.ts) — keep them in sync when adding tools.

## Conventions

- TypeScript strict; **no `any`**. Tools are typed via `tool()` inference from `@openai/agents`.
- When adding a tool: append to the registry in [src/tools/index.ts](src/tools/index.ts), set `surfaces` when it is not shared, mark self-responding/external-service if applicable, and ensure the tool only accesses platform context via `toolContextManager.get()`.
- Keep cognitive complexity under 15 per function. Extract handlers from large switch statements (see [src/discord/tools/role.ts](src/discord/tools/role.ts), [src/tools/memory.ts](src/tools/memory.ts)).
- Mongo writes must be bounded (slices, caps) — never unbounded growth.
- NEVER add runtime legacy compatibility paths, old-field fallbacks, or "maybe legacy" branches. Normalize old data with a migration, then keep application code strict and current.

If a section here looks stale relative to the current code, fix it — this file is the contract for new agents.
