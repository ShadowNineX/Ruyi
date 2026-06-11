import { tool } from "@openai/agents";
import { z } from "zod";
import { getAllSmitheryConnections } from "../db/models";
import { toolLogger } from "../logger";
import {
  callSmitheryConnectionTool,
  isSmitheryConfigured,
  listSmitheryConnectionTools,
} from "../mcp/smithery-api";
import {
  SMITHERY_SERVER_IDS,
  SMITHERY_SERVERS,
} from "../mcp/smithery-catalog";
import { formatError } from "../utils/types";

const SmitheryServerIdSchema = z.enum(SMITHERY_SERVER_IDS);
const JsonObjectSchema = z.record(z.string(), z.unknown());

function parseArgumentsJson(value: string | null): Record<string, unknown> {
  if (!value?.trim()) return {};

  const parsed: unknown = JSON.parse(value);
  const result = JsonObjectSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("arguments_json must parse to a JSON object.");
  }
  return result.data;
}

function formatToolSummary(
  toolSummary: Awaited<ReturnType<typeof listSmitheryConnectionTools>>[number],
  includeInputSchema: boolean,
) {
  return {
    name: toolSummary.name,
    title: toolSummary.title,
    description: toolSummary.description,
    readOnly: toolSummary.readOnly,
    destructive: toolSummary.destructive,
    inputSchema: includeInputSchema ? toolSummary.inputSchema : undefined,
  };
}

export const smitheryListToolsTool = tool({
  name: "smithery_list_tools",
  description:
    "List MCP tools available through Smithery Connect. Use this before calling a Smithery tool when you need the exact tool name or argument schema.",
  parameters: z.object({
    server_id: SmitheryServerIdSchema.nullable().describe(
      "Optional Smithery service to inspect. Use github for GitHub, brave for web search, youtube for YouTube.",
    ),
    include_input_schema: z
      .boolean()
      .nullable()
      .describe("Whether to include each tool's MCP input schema."),
  }),
  execute: async ({ server_id, include_input_schema }) => {
    if (!isSmitheryConfigured()) {
      return {
        error:
          "Smithery Connect is not configured. Set SMITHERY_API_KEY and SMITHERY_NAMESPACE.",
      };
    }

    const includeInputSchema = include_input_schema === true;
    const targetServerIds = server_id
      ? [server_id]
      : (await getAllSmitheryConnections())
          .filter((connection) => connection.status === "connected")
          .map((connection) => connection.serverId);

    try {
      const services = await Promise.all(
        targetServerIds.map(async (serverId) => {
          const tools = await listSmitheryConnectionTools(serverId);
          return {
            serverId,
            name: SMITHERY_SERVERS[serverId].name,
            toolCount: tools.length,
            tools: tools.map((toolSummary) =>
              formatToolSummary(toolSummary, includeInputSchema),
            ),
          };
        }),
      );

      toolLogger.info(
        {
          serverId: server_id,
          serviceCount: services.length,
          includeInputSchema,
        },
        "Listed Smithery MCP tools",
      );

      return {
        success: true,
        services,
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { serverId: server_id, error: errorMessage },
        "Failed to list Smithery MCP tools",
      );
      return { error: errorMessage };
    }
  },
});

export const smitheryCallTool = tool({
  name: "smithery_call_tool",
  description:
    "Call one MCP tool through Smithery Connect. Use smithery_list_tools first if you do not know the exact tool name or JSON arguments.",
  parameters: z.object({
    server_id: SmitheryServerIdSchema.describe(
      "Smithery service to call: github, brave, or youtube.",
    ),
    tool_name: z
      .string()
      .min(1)
      .describe("Exact MCP tool name from smithery_list_tools, without a connection prefix."),
    arguments_json: z
      .string()
      .nullable()
      .describe("JSON object string to pass as tool arguments. Use {} when no arguments are needed."),
  }),
  needsApproval: true,
  execute: async ({ server_id, tool_name, arguments_json }) => {
    try {
      const args = parseArgumentsJson(arguments_json);
      const result = await callSmitheryConnectionTool(
        server_id,
        tool_name,
        args,
      );

      toolLogger.info(
        {
          serverId: server_id,
          connectionId: result.connectionId,
          toolName: tool_name,
        },
        "Called Smithery MCP tool",
      );

      return {
        success: true,
        serverId: server_id,
        connectionId: result.connectionId,
        toolName: result.toolName,
        result: result.result,
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { serverId: server_id, toolName: tool_name, error: errorMessage },
        "Smithery MCP tool call failed",
      );
      return { error: errorMessage };
    }
  },
});
