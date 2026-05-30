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

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function getToolName(approvalItem: RunToolApprovalItem): string {
  return approvalItem.name ?? approvalItem.toolName ?? "unknown_tool";
}

function formatArguments(rawArguments: string | undefined): string {
  if (!rawArguments) return "";

  try {
    const parsed = JSON.parse(rawArguments) as unknown;
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
  const toolName = getToolName(approvalItem);
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
  resolve: (approved: boolean) => void;
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
  const approved = interaction.customId.startsWith("perm_approve");
  const resultEmbed = createPermissionEmbed(
    approved
      ? `Permission Granted: ${args.toolName}`
      : `Permission Denied: ${args.toolName}`,
    args.approvalItem,
    approved ? 0x00aa55 : 0xcc3333,
    `Decided by ${interaction.user.username}`,
  );

  try {
    await interaction.update({
      embeds: [resultEmbed],
      components: [],
    });
    state.settled = true;
    state.collector.stop(approved ? "approved" : "denied");

    aiLogger.info(
      {
        channelId: args.channelId,
        sessionId: args.sessionId,
        tool: args.toolName,
        approved,
      },
      "User responded to tool approval request",
    );

    state.resolve(approved);
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
    state.resolve(false);
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

  state.resolve(false);
}

function waitForApproval(args: ApprovalPromptArgs): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
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
  ): Promise<boolean> {
    const context = this.contexts.get(channelId);
    const toolName = getToolName(approvalItem);

    if (!context) {
      aiLogger.warn(
        { channelId, tool: toolName },
        "No permission context found, denying tool approval request",
      );
      return false;
    }

    const { channel, userId } = context;

    try {
      const embed = createPermissionEmbed(
        `Permission Required: ${toolName}`,
        approvalItem,
        0xffa500,
        `Only the requesting user can respond. Expires in ${Math.round(timeoutMs / 1000)}s`,
      );

      const buttonId = randomUUID().slice(0, 12);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`perm_approve_${buttonId}`)
          .setLabel("Allow")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`perm_deny_${buttonId}`)
          .setLabel("Deny")
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
      return false;
    }
  }
}

export const permissionManager = new PermissionManager();
