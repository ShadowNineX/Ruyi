import { MCPServer, type MCPHealthCheckResult } from "./base";
import { braveMCP } from "./brave";
import { githubMCP } from "./github";
import { youtubeMCP } from "./youtube";
import { mcpLogger } from "../logger";

export {
  MCPServer,
  type MCPServerConfig,
  type MCPHealthCheckResult,
} from "./base";

function getStatusIcon(result: MCPHealthCheckResult): string {
  if (result.connected) return "\x1b[32m● CONNECTED\x1b[0m";
  if (result.reachable) return "\x1b[33m◐ REACHABLE\x1b[0m";
  if (result.enabled) return "\x1b[31m✗ FAILED\x1b[0m";
  return "\x1b[90m○ DISABLED\x1b[0m";
}

function logServerResult(result: MCPHealthCheckResult): void {
  const lines = [
    `\n${result.name.toUpperCase()}`,
    `  Status: ${getStatusIcon(result)}`,
    `  URL: ${result.url}`,
  ];

  if (result.responseTimeMs !== undefined) {
    lines.push(`  Response: ${result.responseTimeMs}ms`);
  }

  if (result.tools && result.tools.length > 0) {
    const preview = result.tools.slice(0, 5).join(", ");
    const more =
      result.tools.length > 5 ? `, +${result.tools.length - 5} more` : "";
    lines.push(
      `  Tools: ${result.tools.length} available`,
      `    \u2192 ${preview}${more}`,
    );
  }

  if (result.error) {
    lines.push(`  Note: ${result.error}`);
  }

  mcpLogger.info(lines.join("\n"));
}

export class MCPRegistry {
  readonly servers: MCPServer[] = [braveMCP, githubMCP, youtubeMCP];

  getServerForTool(toolName: string): string | undefined {
    for (const server of this.servers) {
      if (server.ownsTool(toolName)) {
        return server.name;
      }
    }
    return undefined;
  }

  async checkHealth(): Promise<MCPHealthCheckResult[]> {
    return Promise.all(this.servers.map((server) => server.checkHealth()));
  }

  async logHealth(): Promise<void> {
    mcpLogger.info("MCP servers health check starting");

    const results = await this.checkHealth();

    for (const result of results) {
      logServerResult(result);
    }

    const connectedCount = results.filter((r) => r.connected).length;
    const reachableCount = results.filter((r) => r.reachable).length;
    const enabledCount = results.filter((r) => r.enabled).length;
    mcpLogger.info(
      {
        connected: connectedCount,
        reachable: reachableCount - connectedCount,
        failed: enabledCount - reachableCount,
      },
      "MCP servers health check complete",
    );
  }
}

export const mcpRegistry = new MCPRegistry();
