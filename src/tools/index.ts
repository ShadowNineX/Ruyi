import type { Tool } from '@openai/agents';
import { hostedMcpTool } from '@openai/agents';
import { auditLogTool } from '../discord/tools/audit';
import { channelInfoTool } from '../discord/tools/channel';
import { embedTool } from '../discord/tools/embed';
import { getEventsTool, manageEventTool } from '../discord/tools/events';
import { generateImageTool } from '../discord/tools/image';
import {
  deleteMessagesTool,
  editBotMessageTool,
  searchMessagesTool,
  sendTextAttachmentTool,
} from '../discord/tools/message';
import { pinTool } from '../discord/tools/pin';
import { reactionTool } from '../discord/tools/reaction';
import { manageReminderTool } from '../discord/tools/reminder';
import { reverseImageSearchTool } from '../discord/tools/reverse-image-search';
import { manageRoleTool } from '../discord/tools/role';
import { serverInfoTool } from '../discord/tools/server';
import {
  smitheryCallTool,
  smitheryListToolsTool,
} from '../discord/tools/smithery';
import { userInfoTool } from '../discord/tools/user';
import { env } from '../env';
import { calculatorTool } from './calc';
import { fetchUrlTool } from './fetch';
import { lastfmTool } from './lastfm';
import {
  memoryRecallTool,
  memoryStoreTool,
  searchConversationTool,
  searchMemoryTool,
} from './memory';
import { pinterestTool } from './pinterest';
import { resolveTimeTool } from './time';
import { describeImageTool } from './vision';
import { webSearchTool } from './web-search';

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
      serverLabel: 'github',
      serverUrl: env.GITHUB_MCP_URL,
      headers: {
        Authorization: `Bearer ${env.GITHUB_PERSONAL_ACCESS_TOKEN}`,
      },
      requireApproval: 'always',
      serverDescription:
        'GitHub\'s official MCP server for repositories, code, issues, pull requests, workflows, notifications, and related GitHub operations.',
    })
  : null;

const baseToolRegistry: readonly ToolRegistration[] = [
  { tool: calculatorTool },
  { tool: channelInfoTool },
  { tool: serverInfoTool },
  { tool: userInfoTool },
  { tool: resolveTimeTool },
  { tool: manageReminderTool },
  { tool: getEventsTool },
  { tool: manageEventTool },
  { tool: manageRoleTool },
  { tool: reactionTool },
  { tool: pinTool },
  { tool: searchMessagesTool },
  { tool: deleteMessagesTool },
  {
    tool: editBotMessageTool,
    producesDiscordOutput: true,
  },
  {
    tool: sendTextAttachmentTool,
    producesDiscordOutput: true,
  },
  { tool: embedTool, producesDiscordOutput: true },
  { tool: fetchUrlTool },
  { tool: webSearchTool, externalService: true },
  { tool: pinterestTool, externalService: true },
  {
    tool: reverseImageSearchTool,
    externalService: true,
  },
  {
    tool: generateImageTool,
    externalService: true,
    producesDiscordOutput: true,
  },
  { tool: describeImageTool, externalService: true },
  { tool: memoryStoreTool },
  { tool: memoryRecallTool },
  { tool: searchMemoryTool },
  { tool: searchConversationTool },
  { tool: auditLogTool },
  { tool: lastfmTool, externalService: true },
  { tool: smitheryListToolsTool, externalService: true },
  { tool: smitheryCallTool, externalService: true },
];

function buildToolRegistry(): readonly ToolRegistration[] {
  if (!githubMcpTool) { return baseToolRegistry; }
  return [...baseToolRegistry, { tool: githubMcpTool, externalService: true }];
}

const toolRegistry = buildToolRegistry();

// Export all tools as an array for use with the OpenAI Agents runtime.
export const allTools: readonly Tool[] = toolRegistry.map(
  registration => registration.tool,
);

export function getToolNames(): ReadonlySet<string> {
  return new Set(allTools.map(tool => tool.name));
}

export function isExternalToolName(toolName: string): boolean {
  return toolRegistry.some(
    registration =>
      registration.tool.name === toolName
      && registration.externalService === true,
  );
}

/**
 * Tools that produce their own visible Discord output (embed, image, etc.)
 * and therefore make a missing assistant text reply non-fatal.
 */
export const selfRespondingToolNames: ReadonlySet<string> = new Set(
  toolRegistry
    .filter(registration => registration.producesDiscordOutput === true)
    .map(registration => registration.tool.name),
);
