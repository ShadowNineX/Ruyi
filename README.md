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

## Smithery MCP

Set `SMITHERY_API_KEY` and `SMITHERY_NAMESPACE`, restart the bot, then run
`/smithery` in Discord. The command creates Smithery hosted setup links for
GitHub and other MCP services, so you should not need to paste OAuth codes into
Discord.

Ruyi uses the official `@smithery/api` SDK for connection management and
`@smithery/api/mcp` with the MCP TypeScript SDK for tool execution. The model
sees only two stable local tools, `smithery_list_tools` and
`smithery_call_tool`; upstream MCP schemas are discovered at call time instead
of being registered as OpenAI function schemas during chat startup.

On first startup after upgrading from the old OAuth-token flow, Ruyi drops the
legacy `smitherytokens` MongoDB collection and records that migration in config.
