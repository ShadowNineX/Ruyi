import { randomUUID } from "node:crypto";
import type { RunToolApprovalItem } from "@openai/agents";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  ComponentType,
  EmbedBuilder,
  type InteractionCollector,
  type Message,
  MessageFlags,
} from "discord.js";
import { aiLogger } from "../logger";
import { PERMISSION_TIMEOUT_MS } from "../constants";
import {
  addPermissionPromptMessage,
  clearPermissionContext,
  getPermissionContext,
  setPermissionContext,
  takePermissionPromptMessages,
  type PermissionContext,
  type PermissionPromptController,
  type PermissionPromptPayload,
} from "../stores";
import {
  argumentEntriesToRecord,
  formatToolArgumentLines,
  parseNullableToolArguments,
  parseToolArguments,
} from "../utils/tool-arguments";

export type PermissionDecision =
  | "approve_once"
  | "approve_tool"
  | "deny_once"
  | "deny_tool";

export interface PermissionResult {
  approved: boolean;
  rememberTool: boolean;
  decision: PermissionDecision;
}

const DENY_ONCE_RESULT: PermissionResult = {
  approved: false,
  rememberTool: false,
  decision: "deny_once",
};
const DISCORD_UNKNOWN_MESSAGE_CODE = 10008;
const SMITHERY_SERVICE_NAMES: Record<string, string> = {
  youtube: "YouTube",
};
const EMBED_DESCRIPTION_LIMIT = 4096;
const ARGUMENT_LINE_LIMIT = 8;

type DiscordTimestampStyle = "R" | "T";

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function formatDiscordTimestamp(
  timestampMs: number,
  style: DiscordTimestampStyle,
): string {
  return `<t:${Math.floor(timestampMs / 1000)}:${style}>`;
}

export function getApprovalToolName(
  approvalItem: RunToolApprovalItem,
): string {
  return approvalItem.name ?? approvalItem.toolName ?? "unknown_tool";
}

function getDecisionLabel(decision: PermissionDecision): string {
  switch (decision) {
    case "approve_once":
      return "allowed once";
    case "approve_tool":
      return "allowed this tool for this turn";
    case "deny_once":
      return "denied once";
    case "deny_tool":
      return "denied this tool for this turn";
  }
}

function resultFromDecision(decision: PermissionDecision): PermissionResult {
  return {
    approved: decision.startsWith("approve"),
    rememberTool: decision.endsWith("tool"),
    decision,
  };
}

function decisionFromCustomId(customId: string): PermissionDecision | null {
  if (customId.startsWith("perm_approve_tool_")) return "approve_tool";
  if (customId.startsWith("perm_approve_once_")) return "approve_once";
  if (customId.startsWith("perm_deny_tool_")) return "deny_tool";
  if (customId.startsWith("perm_deny_once_")) return "deny_once";
  return null;
}

function parseApprovalArguments(
  rawArguments: string | undefined,
): Record<string, unknown> | null {
  return parseNullableToolArguments(rawArguments);
}

function getStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function hasToolArguments(args: Record<string, unknown>): boolean {
  return Object.keys(args).length > 0;
}

function getApprovalToolArguments(
  approvalArgs: Record<string, unknown>,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const toolArgumentEntries = argumentEntriesToRecord(approvalArgs.tool_arguments);
  if (toolArgumentEntries && hasToolArguments(toolArgumentEntries)) {
    return toolArgumentEntries;
  }

  const directArgs = parseToolArguments(approvalArgs.arguments);
  if (hasToolArguments(directArgs)) return directArgs;

  const argumentsJson = approvalArgs.arguments_json;
  if (typeof argumentsJson !== "string") return fallback;

  const parsedArgumentsJson = parseToolArguments(argumentsJson);
  return hasToolArguments(parsedArgumentsJson) ? parsedArgumentsJson : fallback;
}

function formatPermissionArgumentLines(args: Record<string, unknown>): string[] {
  return formatToolArgumentLines(args, {
    lineLimit: ARGUMENT_LINE_LIMIT,
    valueMaxLength: 700,
  });
}

function formatRawArgumentLine(rawArguments: string | undefined): string | null {
  if (!rawArguments?.trim()) return null;

  return `- input: ${truncate(rawArguments.replace(/\s+/g, " "), 700)}`;
}

function appendArgumentLines(
  lines: string[],
  argumentLines: string[],
): void {
  if (argumentLines.length === 0) return;
  lines.push("", "Request details:", ...argumentLines);
}

function getGenericPermissionDescription(
  approvalItem: RunToolApprovalItem,
  approvalArgs: Record<string, unknown> | null,
): string {
  const toolName = getApprovalToolName(approvalItem);
  const lines = [`Tool: \`${toolName}\``];

  if (approvalArgs) {
    appendArgumentLines(
      lines,
      formatPermissionArgumentLines(
        getApprovalToolArguments(approvalArgs, approvalArgs),
      ),
    );
  } else {
    const rawArgumentLine = formatRawArgumentLine(approvalItem.arguments);
    if (rawArgumentLine) appendArgumentLines(lines, [rawArgumentLine]);
  }

  return truncate(lines.join("\n"), 3900);
}

function getSmitheryPermissionDescription(
  approvalArgs: Record<string, unknown>,
): string {
  const serverId = getStringField(approvalArgs, "server_id") ?? "unknown";
  const serviceName = SMITHERY_SERVICE_NAMES[serverId] ?? serverId;
  const toolName = getStringField(approvalArgs, "tool_name") ?? "unknown";
  const mcpArgs = getApprovalToolArguments(approvalArgs, {});
  const lines = [
    `Service: **${serviceName}**`,
    `MCP tool: \`${toolName}\``,
  ];

  const argumentLines = formatPermissionArgumentLines(mcpArgs);
  appendArgumentLines(lines, argumentLines);

  return truncate(lines.join("\n"), 3900);
}

function getPermissionDisplayName(approvalItem: RunToolApprovalItem): string {
  const toolName = getApprovalToolName(approvalItem);
  if (toolName !== "smithery_call_tool") return toolName;

  const approvalArgs = parseApprovalArguments(approvalItem.arguments);
  if (!approvalArgs) return toolName;

  const serverId = getStringField(approvalArgs, "server_id") ?? "Smithery";
  const serviceName = SMITHERY_SERVICE_NAMES[serverId] ?? serverId;
  const mcpToolName = getStringField(approvalArgs, "tool_name");
  return mcpToolName ? `${serviceName} ${mcpToolName}` : serviceName;
}

function getPermissionDescription(approvalItem: RunToolApprovalItem): string {
  const toolName = getApprovalToolName(approvalItem);
  const approvalArgs = parseApprovalArguments(approvalItem.arguments);
  if (toolName === "smithery_call_tool" && approvalArgs) {
    return getSmitheryPermissionDescription(approvalArgs);
  }

  return getGenericPermissionDescription(approvalItem, approvalArgs);
}

function getPermissionDescriptionWithExpiration(
  approvalItem: RunToolApprovalItem,
  expiresAtMs: number | undefined,
): string {
  const description = getPermissionDescription(approvalItem);
  if (!expiresAtMs) return description;

  const expirationLine = `\n\nExpires ${formatDiscordTimestamp(
    expiresAtMs,
    "R",
  )} (${formatDiscordTimestamp(expiresAtMs, "T")})`;
  const descriptionLimit = EMBED_DESCRIPTION_LIMIT - expirationLine.length;
  return `${truncate(description, descriptionLimit)}${expirationLine}`;
}

function createPermissionEmbed(
  title: string,
  approvalItem: RunToolApprovalItem,
  color: number,
  footer: string,
  expiresAtMs?: number,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      getPermissionDescriptionWithExpiration(approvalItem, expiresAtMs),
    )
    .setColor(color)
    .setFooter({ text: footer })
    .setTimestamp();
}

function getErrorCode(error: unknown): number | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : null;
}

interface ApprovalPromptArgs {
  approvalItem: RunToolApprovalItem;
  channelId: string;
  promptMessage: Message;
  promptController: PermissionPromptController | null;
  sessionId: string;
  timeoutMs: number;
  toolName: string;
  userId: string;
}

interface ApprovalCollectorState {
  settled: boolean;
  resolve: (result: PermissionResult) => void;
  collector: InteractionCollector<ButtonInteraction>;
}

async function replyToUnauthorizedClick(
  interaction: ButtonInteraction,
  args: ApprovalPromptArgs,
): Promise<void> {
  await interaction
    .reply({
      content: "Only the user who requested this action can respond.",
      flags: MessageFlags.Ephemeral,
    })
    .catch((replyError: unknown) => {
      aiLogger.debug(
        {
          error: (replyError as Error)?.message,
          channelId: args.channelId,
          sessionId: args.sessionId,
          tool: args.toolName,
        },
        "Failed to reply to unauthorized approval click",
      );
    });
}

async function settleApprovalFromInteraction(
  interaction: ButtonInteraction,
  args: ApprovalPromptArgs,
  state: ApprovalCollectorState,
): Promise<void> {
  const decision = decisionFromCustomId(interaction.customId);
  if (!decision) {
    aiLogger.warn(
      {
        channelId: args.channelId,
        sessionId: args.sessionId,
        tool: args.toolName,
        customId: interaction.customId,
      },
      "Unknown tool approval button clicked",
    );
    return;
  }

  const result = resultFromDecision(decision);
  const displayName = getPermissionDisplayName(args.approvalItem);
  const resultEmbed = createPermissionEmbed(
    result.approved
      ? `Permission Granted: ${displayName}`
      : `Permission Denied: ${displayName}`,
    args.approvalItem,
    result.approved ? 0x00aa55 : 0xcc3333,
    `${getDecisionLabel(decision)} by ${interaction.user.username}`,
  );

  try {
    await interaction.update({
      embeds: [resultEmbed],
      components: [],
    });
    args.promptController?.releasePrompt();
    state.settled = true;
    state.collector.stop(result.approved ? "approved" : "denied");

    aiLogger.info(
      {
        channelId: args.channelId,
        sessionId: args.sessionId,
        tool: args.toolName,
        approved: result.approved,
        rememberTool: result.rememberTool,
        decision,
      },
      "User responded to tool approval request",
    );

    state.resolve(result);
  } catch (error) {
    state.settled = true;
    args.promptController?.releasePrompt();
    state.collector.stop("update_failed");
    aiLogger.error(
      {
        channelId: args.channelId,
        sessionId: args.sessionId,
        tool: args.toolName,
        error: (error as Error).message,
      },
      "Failed to update tool approval prompt",
    );
    state.resolve(DENY_ONCE_RESULT);
  }
}

function handleApprovalCollect(
  interaction: ButtonInteraction,
  args: ApprovalPromptArgs,
  state: ApprovalCollectorState,
): void {
  if (interaction.user.id !== args.userId) {
    void replyToUnauthorizedClick(interaction, args);
    return;
  }

  void settleApprovalFromInteraction(interaction, args, state);
}

function handleApprovalEnd(
  reason: string,
  args: ApprovalPromptArgs,
  state: ApprovalCollectorState,
): void {
  if (state.settled) return;
  state.settled = true;
  args.promptController?.releasePrompt();

  const timeoutEmbed = createPermissionEmbed(
    `Permission Expired: ${getPermissionDisplayName(args.approvalItem)}`,
    args.approvalItem,
    0x95a5a6,
    "Request timed out",
  );

  void args.promptMessage
    .edit({
      embeds: [timeoutEmbed],
      components: [],
    })
    .catch((editError: unknown) => {
      aiLogger.debug(
        {
          error: (editError as Error)?.message,
          channelId: args.channelId,
          sessionId: args.sessionId,
          tool: args.toolName,
        },
        "Failed to edit timed-out tool approval prompt",
      );
    });

  aiLogger.warn(
    {
      channelId: args.channelId,
      sessionId: args.sessionId,
      tool: args.toolName,
      reason,
    },
    "Tool approval request ended without approval",
  );

  state.resolve(DENY_ONCE_RESULT);
}

async function sendPermissionPrompt(
  context: PermissionContext,
  payload: PermissionPromptPayload,
): Promise<Message> {
  const promptMessage = await context.promptController.showPrompt(payload);
  if (promptMessage) return promptMessage;

  return context.channel.send(payload);
}

function waitForApproval(args: ApprovalPromptArgs): Promise<PermissionResult> {
  return new Promise<PermissionResult>((resolve) => {
    const collector = args.promptMessage.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: args.timeoutMs,
    });
    const state: ApprovalCollectorState = {
      settled: false,
      resolve,
      collector,
    };

    collector.on("collect", (interaction) => {
      handleApprovalCollect(interaction, args, state);
    });
    collector.on("end", (_collected, reason) => {
      handleApprovalEnd(reason, args, state);
    });
  });
}

class PermissionManager {
  setContext(channelId: string, context: PermissionContext): void {
    setPermissionContext(channelId, context);
  }

  clearContext(channelId: string): void {
    clearPermissionContext(channelId);
  }

  private trackPromptMessage(turnId: string, message: Message): void {
    addPermissionPromptMessage(turnId, message);
  }

  async deletePromptMessages(turnId: string): Promise<void> {
    const messages = takePermissionPromptMessages(turnId);
    if (messages.size === 0) return;

    const deleteResults = await Promise.allSettled(
      [...messages].map((message) => message.delete()),
    );
    let deletedCount = 0;

    for (const result of deleteResults) {
      if (result.status === "fulfilled") {
        deletedCount += 1;
        continue;
      }

      const error = result.reason as Error;
      const code = getErrorCode(error);
      if (code === DISCORD_UNKNOWN_MESSAGE_CODE) continue;

      aiLogger.debug(
        {
          code,
          error: error.message,
          name: error.name,
          turnId,
        },
        "Failed to delete permission prompt",
      );
    }

    aiLogger.debug(
      {
        deletedCount,
        promptCount: messages.size,
        turnId,
      },
      "Deleted permission prompts for completed chat turn",
    );
  }

  async requestToolApproval(
    channelId: string,
    approvalItem: RunToolApprovalItem,
    sessionId: string,
    timeoutMs = PERMISSION_TIMEOUT_MS,
  ): Promise<PermissionResult> {
    const context = getPermissionContext(channelId);
    const toolName = getApprovalToolName(approvalItem);

    if (!context) {
      aiLogger.warn(
        { channelId, tool: toolName },
        "No permission context found, denying tool approval request",
      );
      return DENY_ONCE_RESULT;
    }

    const { turnId, userId } = context;

    try {
      const expiresAtMs = Date.now() + timeoutMs;
      const embed = createPermissionEmbed(
        `Permission Required: ${getPermissionDisplayName(approvalItem)}`,
        approvalItem,
        0xffa500,
        "Choose once for one call, or tool this turn for repeats",
        expiresAtMs,
      );

      const buttonId = randomUUID().slice(0, 12);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`perm_approve_tool_${buttonId}`)
          .setLabel("Allow Tool This Turn")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`perm_approve_once_${buttonId}`)
          .setLabel("Allow Once")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`perm_deny_once_${buttonId}`)
          .setLabel("Deny Once")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`perm_deny_tool_${buttonId}`)
          .setLabel("Deny Tool This Turn")
          .setStyle(ButtonStyle.Danger),
      );

      const promptMessage = await sendPermissionPrompt(context, {
        embeds: [embed],
        components: [row],
      });
      this.trackPromptMessage(turnId, promptMessage);

      aiLogger.info(
        { channelId, sessionId, tool: toolName, userId },
        "Tool approval prompt sent, waiting for user response",
      );

      return await waitForApproval({
        approvalItem,
        channelId,
        promptMessage,
        promptController: context.promptController,
        sessionId,
        timeoutMs,
        toolName,
        userId,
      });
    } catch (error) {
      const err = error as Error;
      aiLogger.error(
        {
          channelId,
          sessionId,
          tool: toolName,
          error: err.message,
          stack: err.stack,
          name: err.name,
        },
        "Failed to send tool approval prompt",
      );
      return DENY_ONCE_RESULT;
    }
  }
}

export const permissionManager = new PermissionManager();
