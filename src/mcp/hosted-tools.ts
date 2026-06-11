import { hostedMcpTool, type Tool } from "@openai/agents";
import { countConnectedSmitheryConnections } from "../db/models";
import { mcpLogger } from "../logger";
import {
  getSmitheryNamespaceMcpUrl,
  getSmitheryServiceToken,
  isSmitheryConfigured,
} from "./smithery-api";

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
      serverDescription: "Smithery Connect MCP namespace",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
      },
      deferLoading: false,
      requireApproval: {
        never: { readOnly: true },
        always: { readOnly: false },
      },
    }),
  ];
}
