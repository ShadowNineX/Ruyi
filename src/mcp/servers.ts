import {
  MCPServerStreamableHttp,
  type MCPServer,
  type MCPToolErrorFunction,
  type RunToolApprovalItem,
} from "@openai/agents";
import { countConnectedSmitheryConnections } from "../db/models";
import { mcpLogger } from "../logger";
import { permissionManager, type PermissionResult } from "../ai/permissions";
import { toolContextManager } from "../utils/types";
import {
  getSmitheryNamespaceMcpUrl,
  getSmitheryServiceToken,
  isSmitheryConfigured,
} from "./smithery-api";
import { sanitizeMcpInputSchema } from "./schema";

const MCP_CONNECT_TIMEOUT_MS = 30_000;
const APPROVAL_FREE_SMART_TOOL_NAMES = new Set([
  "get_toolbox_status",
  "search_toolbox",
]);
const BLOCKED_SMART_TOOL_NAMES = ["remove_server"];

type McpToolList = Awaited<ReturnType<MCPServer["listTools"]>>;
type McpToolOutput = Awaited<ReturnType<MCPServer["callTool"]>>;
type McpTool = McpToolList[number];

function formatMcpToolError({ error }: Parameters<MCPToolErrorFunction>[0]): string {
  return error instanceof Error ? error.message : String(error);
}

function approvalItemForMcpTool(
  toolName: string,
  args: Record<string, unknown> | null,
): RunToolApprovalItem {
  return {
    name: toolName,
    toolName,
    arguments: args ? JSON.stringify(args) : undefined,
  } as RunToolApprovalItem;
}

function deniedMcpToolOutput(toolName: string): McpToolOutput {
  return [
    {
      type: "text",
      text: `The Discord user denied approval for MCP tool ${toolName}.`,
    },
  ];
}

function schemaFingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function sanitizeMcpTool(tool: McpTool): McpTool {
  const inputSchema = sanitizeMcpInputSchema(tool.inputSchema);
  if (schemaFingerprint(inputSchema) !== schemaFingerprint(tool.inputSchema)) {
    mcpLogger.debug(
      { tool: tool.name },
      "Sanitized MCP tool input schema for OpenAI compatibility",
    );
  }

  return {
    ...tool,
    inputSchema,
  };
}

class ApprovalMcpServer implements MCPServer {
  readonly cacheToolsList: boolean;
  readonly toolFilter?: MCPServer["toolFilter"];
  readonly toolMetaResolver?: MCPServer["toolMetaResolver"];
  readonly errorFunction?: MCPServer["errorFunction"];

  private readonly rememberedDecisions = new Map<string, PermissionResult>();

  constructor(private readonly inner: MCPServer) {
    this.cacheToolsList = inner.cacheToolsList;
    this.toolFilter = inner.toolFilter;
    this.toolMetaResolver = inner.toolMetaResolver;
    this.errorFunction = inner.errorFunction;
  }

  get name(): string {
    return this.inner.name;
  }

  connect(): Promise<void> {
    return this.inner.connect();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async listTools(): Promise<McpToolList> {
    const tools = await this.inner.listTools();
    return tools
      .filter((tool) => !BLOCKED_SMART_TOOL_NAMES.includes(tool.name))
      .map(sanitizeMcpTool);
  }

  invalidateToolsCache(): Promise<void> {
    return this.inner.invalidateToolsCache();
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
  ): Promise<McpToolOutput> {
    if (await this.isApproved(toolName, args)) {
      return this.inner.callTool(toolName, args, meta);
    }

    return deniedMcpToolOutput(toolName);
  }

  private async isApproved(
    toolName: string,
    args: Record<string, unknown> | null,
  ): Promise<boolean> {
    if (APPROVAL_FREE_SMART_TOOL_NAMES.has(toolName)) return true;

    const context = toolContextManager.get();
    const channelId = context.channel?.id;
    if (!channelId) {
      mcpLogger.warn({ tool: toolName }, "No Discord context for MCP approval");
      return false;
    }

    const rememberedDecision = this.rememberedDecisions.get(toolName);
    const decision =
      rememberedDecision ??
      (await permissionManager.requestToolApproval(
        channelId,
        approvalItemForMcpTool(toolName, args),
        `mcp-${channelId}`,
      ));

    if (decision.rememberTool) {
      this.rememberedDecisions.set(toolName, decision);
    }

    return decision.approved;
  }
}

export async function getMcpServerCount(): Promise<number> {
  if (!isSmitheryConfigured()) return 0;
  return (await countConnectedSmitheryConnections()) > 0 ? 1 : 0;
}

export async function connectMcpServersForRun(): Promise<MCPServer[]> {
  if ((await getMcpServerCount()) === 0) return [];

  const serverUrl = getSmitheryNamespaceMcpUrl();
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

  const server = new MCPServerStreamableHttp({
    name: "smithery",
    url: serverUrl,
    cacheToolsList: true,
    timeout: MCP_CONNECT_TIMEOUT_MS,
    toolFilter: {
      blockedToolNames: BLOCKED_SMART_TOOL_NAMES,
    },
    requestInit: {
      headers: {
        Authorization: `Bearer ${serviceToken}`,
      },
    },
    errorFunction: formatMcpToolError,
  });

  try {
    await server.connect();
    const approvalServer = new ApprovalMcpServer(server);
    const tools = await approvalServer.listTools();
    mcpLogger.info(
      {
        server: server.name,
        url: serverUrl,
        toolCount: tools.length,
        toolSample: tools.slice(0, 10).map((tool) => tool.name),
      },
      "Connected Smithery MCP server",
    );
    return [approvalServer];
  } catch (error) {
    await closeMcpServers([server]);
    mcpLogger.error(
      {
        url: serverUrl,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      "Failed to connect Smithery MCP server",
    );
    return [];
  }

}

export async function closeMcpServers(servers: MCPServer[]): Promise<void> {
  await Promise.all(
    servers.map(async (server) => {
      try {
        await server.close();
      } catch (error) {
        mcpLogger.debug(
          {
            server: server.name,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to close MCP server",
        );
      }
    }),
  );
}
