import { tool } from "@openai/agents";
import { z } from "zod";
import type { ConfigScope } from "../config";
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
import { getCurrentToolConfigScope } from "../utils/discord-scope";

const SmitheryServerIdSchema = z.enum(SMITHERY_SERVER_IDS);
const ToolArgumentValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const ToolArgumentEntrySchema = z.object({
  name: z.string().min(1).describe("MCP argument name."),
  value: ToolArgumentValueSchema.describe(
    "String, number, boolean, or null argument value. Use this for ordinary values.",
  ),
  json_value: z
    .string()
    .nullable()
    .describe(
      "Optional JSON string for array or object values. Leave null for ordinary values.",
    ),
});

type ToolArgumentEntry = z.infer<typeof ToolArgumentEntrySchema>;

function parseJsonValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as unknown;
}

function toolArgumentEntriesToRecord(
  entries: ToolArgumentEntry[] | null,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const entry of entries ?? []) {
    record[entry.name] =
      entry.json_value === null ? entry.value : parseJsonValue(entry.json_value);
  }
  return record;
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

function getCurrentSmitheryScope(): ConfigScope | null {
  return getCurrentToolConfigScope();
}

export const smitheryListToolsTool = tool({
  name: "smithery_list_tools",
  description:
    "List MCP tools available through Smithery Connect. Use this before calling a Smithery tool when you need the exact tool name or argument schema.",
  parameters: z.object({
    server_id: SmitheryServerIdSchema.nullable().describe(
      "Optional Smithery service to inspect. Use youtube for YouTube.",
    ),
    include_input_schema: z
      .boolean()
      .nullable()
      .describe("Whether to include each tool's MCP input schema."),
  }),
  execute: async ({ server_id, include_input_schema }) => {
    const scope = getCurrentSmitheryScope();
    if (!scope) {
      return { error: "Smithery tools need active Discord context." };
    }

    if (!isSmitheryConfigured()) {
      return {
        error:
          "Smithery Connect is not configured. Set SMITHERY_API_KEY and SMITHERY_NAMESPACE.",
      };
    }

    const includeInputSchema = include_input_schema === true;
    const targetServerIds = server_id
      ? [server_id]
      : (await getAllSmitheryConnections(scope))
          .filter((connection) => connection.status === "connected")
          .map((connection) => connection.serverId);

    try {
      const services = await Promise.all(
        targetServerIds.map(async (serverId) => {
          const tools = await listSmitheryConnectionTools(scope, serverId);
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
          scope: scope.kind,
          scopeId: scope.id,
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
        {
          scope: scope.kind,
          scopeId: scope.id,
          serverId: server_id,
          error: errorMessage,
        },
        "Failed to list Smithery MCP tools",
      );
      return { error: errorMessage };
    }
  },
});

export const smitheryCallTool = tool({
  name: "smithery_call_tool",
  description:
    "Call one MCP tool through Smithery Connect. Use smithery_list_tools first if you do not know the exact tool name or argument object.",
  parameters: z.object({
    server_id: SmitheryServerIdSchema.describe(
      "Smithery service to call: youtube.",
    ),
    tool_name: z
      .string()
      .min(1)
      .describe("Exact MCP tool name from smithery_list_tools, without a connection prefix."),
    tool_arguments: z
      .array(ToolArgumentEntrySchema)
      .nullable()
      .describe(
        "MCP tool arguments as name/value entries. Use [] or null when no arguments are needed.",
      ),
  }),
  needsApproval: true,
  execute: async ({ server_id, tool_name, tool_arguments }) => {
    const scope = getCurrentSmitheryScope();
    if (!scope) {
      return { error: "Smithery tools need active Discord context." };
    }

    try {
      const args = toolArgumentEntriesToRecord(tool_arguments);
      const result = await callSmitheryConnectionTool(
        scope,
        server_id,
        tool_name,
        args,
      );

      toolLogger.info(
        {
          scope: scope.kind,
          scopeId: scope.id,
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
        {
          scope: scope.kind,
          scopeId: scope.id,
          serverId: server_id,
          toolName: tool_name,
          error: errorMessage,
        },
        "Smithery MCP tool call failed",
      );
      return { error: errorMessage };
    }
  },
});
