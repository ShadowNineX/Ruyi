# Ruyi

A Discord bot assistant for the Nine Sols universe, named Ruyi (also known as Abacus), created to be a helpful and caring AI companion.

<img src="https://github.com/user-attachments/assets/41dbe29d-88b5-4478-b462-0158476f6828" width="512" height="512" />

## Run

```bash
bun install
bun run typecheck
bun run build
bun run start
```

For local development, use `bun run dev`.

## Model Preset

Ruyi's OpenAI model is selected in Discord with `/model`. The choice is stored
in MongoDB per Discord server or private DM scope and includes the chat model
plus reasoning/verbosity settings, so model selection does not use `.env`. The
default `High` intelligence level uses `gpt-5.5` with `medium` reasoning; `Pro`
uses `gpt-5.5-pro`.

## Web Search

Ruyi exposes one `web_search` tool. Default/current-info questions use the
Discord-selected primary provider for the active server/private chat first,
then the other provider as fallback. Source-heavy research queries use Tavily
directly.

```bash
TAVILY_API_KEY=tvly-your_tavily_api_key
```

Use `/search-provider` in Discord to choose OpenAI or Tavily as the primary
answer-mode search provider for that server or private chat.

## Pinterest

Ruyi can inspect public Pinterest profiles, boards, board pins, individual
pins, and Pinterest search results through ScrapeCreators:

```bash
SCRAPECREATORS_API_KEY=your_scrapecreators_api_key
```

The `pinterest` tool is read-only and returns bounded summaries so board and
pin lookups do not flood Discord.

## Steam Profile Comments

Ruyi can also use Steam Community profile comments as a second chat surface.
Steam is optional: omit all four variables to disable it, or set all four to
enable profile-comment notifications and posting. Ruyi listens for Steam
comment notifications first and uses a slow profile-comment reconciliation check
only as a fallback.

```bash
STEAM_REFRESH_TOKEN=your_steam_refresh_token
STEAM_BOT_STEAM_ID64=7656119xxxxxxxxxx
STEAM_OWNER_STEAM_ID64=7656119xxxxxxxxxx
OWNER_DISCORD_USER_ID=123456789012345678
```

Steam and Discord use the same AI/persona and memories, but separate persisted
conversation history and Agent sessions.

## Smithery MCP

Set `SMITHERY_API_KEY` and `SMITHERY_NAMESPACE`, restart the bot, then run
`/smithery` in Discord. The command creates Smithery hosted setup links for
non-GitHub MCP services, so you should not need to paste OAuth codes into
Discord. Smithery links are stored separately for each Discord server or
private DM. GitHub uses the official `github/github-mcp-server` directly
instead of Smithery.

## GitHub MCP

Ruyi attaches GitHub's hosted MCP server directly through the OpenAI Agents SDK:

```bash
GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_your_token
GITHUB_MCP_URL=https://api.githubcopilot.com/mcp/
```

Ruyi uses the official `@smithery/api` SDK for connection management and
`@smithery/api/mcp` with the MCP TypeScript SDK for tool execution. The model
sees only two stable local tools, `smithery_list_tools` and
`smithery_call_tool`; upstream MCP schemas are discovered at call time instead
of being registered as OpenAI function schemas during chat startup.

On first startup after upgrading from the old OAuth-token flow, Ruyi drops the
legacy `smitherytokens` MongoDB collection and records that migration in config.
