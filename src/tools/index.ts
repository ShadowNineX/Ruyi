import { calculatorTool } from "./calc";
import { channelInfoTool } from "./channel";
import { serverInfoTool } from "./server";
import { userInfoTool } from "./user";
import { resolveTimeTool } from "./time";
import { getEventsTool, manageEventTool } from "./events";
import { manageRoleTool } from "./role";
import { reactionTool } from "./reaction";
import { pinTool } from "./pin";
import {
  searchMessagesTool,
  deleteMessagesTool,
  editBotMessageTool,
} from "./message";
import { embedTool } from "./embed";
import { fetchUrlTool } from "./fetch";
import { webSearchTool } from "./web-search";
import { pinterestTool } from "./pinterest";
import { reverseImageSearchTool } from "./reverse-image-search";
import { generateImageTool } from "./image";
import { describeImageTool } from "./vision";
import {
  memoryStoreTool,
  memoryRecallTool,
  searchMemoryTool,
  searchConversationTool,
} from "./memory";
import { auditLogTool } from "./audit";
import { lastfmTool } from "./lastfm";
import { smitheryListToolsTool, smitheryCallTool } from "./smithery";
import { hostedMcpTool, type Tool } from "@openai/agents";
import { env } from "../env";

interface ToolRegistration {
  readonly tool: Tool;
  /**
   * True when the tool already posts visible Discord output, so an empty final
   * assistant message is acceptable.
   */
  readonly producesDiscordOutput?: boolean;
  readonly externalService?: boolean;
}

const githubMcpTool: Tool | null = env.GITHUB_PERSONAL_ACCESS_TOKEN
  ? hostedMcpTool({
      serverLabel: "github",
      serverUrl: env.GITHUB_MCP_URL,
      headers: {
        Authorization: `Bearer ${env.GITHUB_PERSONAL_ACCESS_TOKEN}`,
      },
      requireApproval: "always",
      serverDescription:
        "GitHub's official MCP server for repositories, code, issues, pull requests, workflows, notifications, and related GitHub operations.",
    })
  : null;

const baseToolRegistry: readonly ToolRegistration[] = [
  { tool: calculatorTool },
  { tool: channelInfoTool },
  { tool: serverInfoTool },
  { tool: userInfoTool },
  { tool: resolveTimeTool },
  { tool: getEventsTool },
  { tool: manageEventTool },
  { tool: manageRoleTool },
  { tool: reactionTool },
  { tool: pinTool },
  { tool: searchMessagesTool },
  { tool: deleteMessagesTool },
  { tool: editBotMessageTool, producesDiscordOutput: true },
  { tool: embedTool, producesDiscordOutput: true },
  { tool: fetchUrlTool },
  { tool: webSearchTool, externalService: true },
  { tool: pinterestTool, externalService: true },
  { tool: reverseImageSearchTool, externalService: true },
  { tool: generateImageTool, producesDiscordOutput: true },
  { tool: describeImageTool },
  { tool: memoryStoreTool },
  { tool: memoryRecallTool },
  { tool: searchMemoryTool },
  { tool: searchConversationTool },
  { tool: auditLogTool },
  { tool: lastfmTool },
  { tool: smitheryListToolsTool, externalService: true },
  { tool: smitheryCallTool, externalService: true },
];

function buildToolRegistry(): readonly ToolRegistration[] {
  if (!githubMcpTool) return baseToolRegistry;
  return [
    ...baseToolRegistry,
    { tool: githubMcpTool, externalService: true },
  ];
}

const toolRegistry = buildToolRegistry();

// Export all tools as an array for use with the OpenAI Agents runtime.
export const allTools: readonly Tool[] = toolRegistry.map(
  (registration) => registration.tool,
);

/**
 * Tools that produce their own visible Discord output (embed, image, etc.)
 * and therefore make a missing assistant text reply non-fatal.
 */
export const selfRespondingToolNames: ReadonlySet<string> = new Set(
  toolRegistry
    .filter((registration) => registration.producesDiscordOutput === true)
    .map((registration) => registration.tool.name),
);

export const externalToolNames: ReadonlySet<string> = new Set(
  toolRegistry
    .filter((registration) => registration.externalService === true)
    .map((registration) => registration.tool.name),
);
