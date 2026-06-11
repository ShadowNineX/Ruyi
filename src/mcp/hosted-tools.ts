import { hostedMcpTool, type Tool } from "@openai/agents";
import { mcpRegistry } from "./index";

export function getHostedMcpServerCount(): number {
  return mcpRegistry.servers.filter((server) => server.isEnabled()).length;
}

export function getHostedMcpTools(): Tool[] {
  return mcpRegistry.servers.flatMap((server) => {
    if (!server.isEnabled()) return [];

    const config = server.getConfig();
    if (!config) return [];

    return [
      hostedMcpTool({
        serverLabel: server.name,
        serverUrl: config.url,
        serverDescription: `${server.name} MCP server`,
        headers: config.headers,
        deferLoading: true,
        requireApproval: {
          never: { readOnly: true },
          always: { readOnly: false },
        },
      }),
    ];
  });
}
