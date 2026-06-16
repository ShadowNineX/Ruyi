import { calculatorTool } from "./calc";
import { channelInfoTool } from "../discord/tools/channel";
import { serverInfoTool } from "../discord/tools/server";
import { userInfoTool } from "../discord/tools/user";
import { resolveTimeTool } from "./time";
import { manageReminderTool } from "../discord/tools/reminder";
import { getEventsTool, manageEventTool } from "../discord/tools/events";
import { manageRoleTool } from "../discord/tools/role";
import { reactionTool } from "../discord/tools/reaction";
import { pinTool } from "../discord/tools/pin";
import {
  searchMessagesTool,
  deleteMessagesTool,
  editBotMessageTool,
} from "../discord/tools/message";
import { embedTool } from "../discord/tools/embed";
import { fetchUrlTool } from "./fetch";
import { webSearchTool } from "./web-search";
import { pinterestTool } from "./pinterest";
import { reverseImageSearchTool } from "../discord/tools/reverse-image-search";
import { generateImageTool } from "../discord/tools/image";
import { describeImageTool } from "./vision";
import {
  memoryStoreTool,
  memoryRecallTool,
  searchMemoryTool,
  searchConversationTool,
} from "./memory";
import { auditLogTool } from "../discord/tools/audit";
import { lastfmTool } from "./lastfm";
import {
  smitheryListToolsTool,
  smitheryCallTool,
} from "../discord/tools/smithery";
import {
  steamProfileCommentTool,
  steamProfileCommentsTool,
} from "../steam/tools/profile-comment";
import { hostedMcpTool, type Tool } from "@openai/agents";
import { env } from "../env";
import type { ConversationSurface } from "../ai/context";

interface ToolRegistration {
  readonly tool: Tool;
  /**
   * True when the tool already posts visible Discord output, so an empty final
   * assistant message is acceptable.
   */
  readonly producesDiscordOutput?: boolean;
  readonly externalService?: boolean;
  readonly surfaces?: readonly ConversationSurface[];
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
  { tool: channelInfoTool, surfaces: ["discord"] },
  { tool: serverInfoTool, surfaces: ["discord"] },
  { tool: userInfoTool, surfaces: ["discord"] },
  { tool: resolveTimeTool },
  { tool: manageReminderTool, surfaces: ["discord"] },
  { tool: getEventsTool, surfaces: ["discord"] },
  { tool: manageEventTool, surfaces: ["discord"] },
  { tool: manageRoleTool, surfaces: ["discord"] },
  { tool: reactionTool, surfaces: ["discord"] },
  { tool: pinTool, surfaces: ["discord"] },
  { tool: searchMessagesTool, surfaces: ["discord"] },
  { tool: deleteMessagesTool, surfaces: ["discord"] },
  {
    tool: editBotMessageTool,
    producesDiscordOutput: true,
    surfaces: ["discord"],
  },
  { tool: embedTool, producesDiscordOutput: true, surfaces: ["discord"] },
  { tool: fetchUrlTool },
  { tool: webSearchTool, externalService: true },
  { tool: pinterestTool, externalService: true },
  {
    tool: reverseImageSearchTool,
    externalService: true,
    surfaces: ["discord"],
  },
  {
    tool: generateImageTool,
    producesDiscordOutput: true,
    surfaces: ["discord"],
  },
  { tool: describeImageTool },
  { tool: memoryStoreTool },
  { tool: memoryRecallTool },
  { tool: searchMemoryTool },
  { tool: searchConversationTool, surfaces: ["discord"] },
  { tool: auditLogTool, surfaces: ["discord"] },
  { tool: lastfmTool },
  { tool: smitheryListToolsTool, externalService: true, surfaces: ["discord"] },
  { tool: smitheryCallTool, externalService: true, surfaces: ["discord"] },
  {
    tool: steamProfileCommentTool,
    externalService: true,
    surfaces: ["discord", "steam"],
  },
  { tool: steamProfileCommentsTool, externalService: true },
];

function buildToolRegistry(): readonly ToolRegistration[] {
  if (!githubMcpTool) return baseToolRegistry;
  return [...baseToolRegistry, { tool: githubMcpTool, externalService: true }];
}

const toolRegistry = buildToolRegistry();

// Export all tools as an array for use with the OpenAI Agents runtime.
export const allTools: readonly Tool[] = toolRegistry.map(
  (registration) => registration.tool,
);

function supportsSurface(
  registration: ToolRegistration,
  surface: ConversationSurface,
): boolean {
  return !registration.surfaces || registration.surfaces.includes(surface);
}

export function getToolsForSurface(
  surface: ConversationSurface,
): readonly Tool[] {
  return toolRegistry
    .filter((registration) => supportsSurface(registration, surface))
    .map((registration) => registration.tool);
}

export function getToolNamesForSurface(
  surface: ConversationSurface,
): ReadonlySet<string> {
  return new Set(getToolsForSurface(surface).map((tool) => tool.name));
}

export function isExternalToolName(
  toolName: string,
  surface: ConversationSurface,
): boolean {
  return toolRegistry.some(
    (registration) =>
      registration.tool.name === toolName &&
      registration.externalService === true &&
      supportsSurface(registration, surface),
  );
}

/**
 * Tools that produce their own visible Discord output (embed, image, etc.)
 * and therefore make a missing assistant text reply non-fatal.
 */
export const selfRespondingToolNames: ReadonlySet<string> = new Set(
  toolRegistry
    .filter((registration) => registration.producesDiscordOutput === true)
    .map((registration) => registration.tool.name),
);
