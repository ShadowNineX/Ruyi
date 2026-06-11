import { randomUUID } from "node:crypto";
import type { RunToolApprovalItem } from "@openai/agents";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  ComponentType,
  EmbedBuilder,
  type GuildTextBasedChannel,
  type InteractionCollector,
  type Message,
  MessageFlags,
} from "discord.js";
import { aiLogger } from "../logger";
import { PERMISSION_TIMEOUT_MS } from "../constants";

export interface PermissionContext {
  channel: GuildTextBasedChannel;
  userId: string;
}

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

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
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

function formatArguments(rawArguments: string | undefined): string {
  if (!rawArguments) return "";

  try {
    const parsed: unknown = JSON.parse(rawArguments);
    return JSON.stringify(parsed, null, 2);
  } catch (error) {
    aiLogger.debug(
      { error: (error as Error).message },
      "Tool approval arguments were not JSON",
    );
    return rawArguments;
  }
}

function getPermissionDescription(approvalItem: RunToolApprovalItem): string {
  const toolName = getApprovalToolName(approvalItem);
  const formattedArgs = formatArguments(approvalItem.arguments);
  const lines = [`Tool: \`${toolName}\``];

  if (formattedArgs) {
    lines.push("", "Arguments:", "```json", truncate(formattedArgs, 3000), "```");
  }

  return truncate(lines.join("\n"), 3900);
}

function createPermissionEmbed(
  title: string,
  approvalItem: RunToolApprovalItem,
  color: number,
  footer: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(getPermissionDescription(approvalItem))
    .setColor(color)
    .setFooter({ text: footer })
    .setTimestamp();
}

interface ApprovalPromptArgs {
  approvalItem: RunToolApprovalItem;
  channelId: string;
  promptMessage: Message;
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
  const resultEmbed = createPermissionEmbed(
    result.approved
      ? `Permission Granted: ${args.toolName}`
      : `Permission Denied: ${args.toolName}`,
    args.approvalItem,
    result.approved ? 0x00aa55 : 0xcc3333,
    `${getDecisionLabel(decision)} by ${interaction.user.username}`,
  );

  try {
    await interaction.update({
      embeds: [resultEmbed],
      components: [],
    });
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

  const timeoutEmbed = createPermissionEmbed(
    `Permission Expired: ${args.toolName}`,
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

export class PermissionManager {
  private readonly contexts = new Map<string, PermissionContext>();

  setContext(channelId: string, context: PermissionContext): void {
    this.contexts.set(channelId, context);
  }

  clearContext(channelId: string): void {
    this.contexts.delete(channelId);
  }

  async requestToolApproval(
    channelId: string,
    approvalItem: RunToolApprovalItem,
    sessionId: string,
    timeoutMs = PERMISSION_TIMEOUT_MS,
  ): Promise<PermissionResult> {
    const context = this.contexts.get(channelId);
    const toolName = getApprovalToolName(approvalItem);

    if (!context) {
      aiLogger.warn(
        { channelId, tool: toolName },
        "No permission context found, denying tool approval request",
      );
      return DENY_ONCE_RESULT;
    }

    const { channel, userId } = context;

    try {
      const embed = createPermissionEmbed(
        `Permission Required: ${toolName}`,
        approvalItem,
        0xffa500,
        `Choose once for one call, or tool this turn for repeats. Expires in ${Math.round(timeoutMs / 1000)}s`,
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

      const promptMessage = await channel.send({
        embeds: [embed],
        components: [row],
      });

      aiLogger.info(
        { channelId, sessionId, tool: toolName, userId },
        "Tool approval prompt sent, waiting for user response",
      );

      return await waitForApproval({
        approvalItem,
        channelId,
        promptMessage,
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
