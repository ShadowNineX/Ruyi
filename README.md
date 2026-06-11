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

Ruyi uses Smithery's direct namespace MCP endpoint by default, so connected
service tools are exposed to the agent immediately as first-class MCP tools.
Runtime calls use short-lived Smithery service tokens scoped to Ruyi's global
connection metadata.

On first startup after upgrading from the old OAuth-token flow, Ruyi drops the
legacy `smitherytokens` MongoDB collection and records that migration in config.
