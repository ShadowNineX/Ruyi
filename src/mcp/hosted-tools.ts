import { hostedMcpTool, type Tool } from "@openai/agents";
import { countConnectedSmitheryConnections } from "../db/models";
import { mcpLogger } from "../logger";
import {
  getSmitheryMcpMode,
  getSmitheryNamespaceMcpUrl,
  getSmitheryServiceToken,
  isSmitheryConfigured,
} from "./smithery-api";

const SMITHERY_DISCOVERY_TOOL_NAMES = [
  "get_toolbox_status",
  "mcp_list_tools",
  "search_toolbox",
];

export async function getHostedMcpServerCount(): Promise<number> {
  if (!isSmitheryConfigured()) return 0;
  return (await countConnectedSmitheryConnections()) > 0 ? 1 : 0;
}

export async function getHostedMcpTools(): Promise<Tool[]> {
  if ((await getHostedMcpServerCount()) === 0) return [];

  let serviceToken: string;
  try {
    serviceToken = await getSmitheryServiceToken();
  } catch (error) {
    mcpLogger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to create Smithery service token",
    );
    return [];
  }

  return [
    hostedMcpTool({
      serverLabel: "smithery",
      serverUrl: getSmitheryNamespaceMcpUrl(),
      serverDescription:
        getSmitheryMcpMode() === "smart"
          ? "Smithery Connect smart toolbox for the configured namespace"
          : "Smithery Connect namespace with connected tools such as GitHub issues, Brave Search, and YouTube",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
      },
      deferLoading: false,
      requireApproval: {
        never: {
          readOnly: true,
          toolNames: SMITHERY_DISCOVERY_TOOL_NAMES,
        },
        always: { readOnly: false },
      },
    }),
  ];
}
