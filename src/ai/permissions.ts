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
      const embed = new EmbedBuilder()
        .setTitle(`Permission Required: ${toolName}`)
        .setDescription(getPermissionDescription(approvalItem))
        .setColor(0xffa500)
        .setFooter({
          text: `Only the requesting user can respond. Expires in ${Math.round(timeoutMs / 1000)}s`,
        })
        .setTimestamp();

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

      try {
        const interaction = await promptMessage.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i: ButtonInteraction) => i.user.id === userId,
          time: timeoutMs,
        });

        const approved = interaction.customId.startsWith("perm_approve");
        const resultEmbed = new EmbedBuilder()
          .setTitle(
            approved
              ? `Permission Granted: ${toolName}`
              : `Permission Denied: ${toolName}`,
          )
          .setDescription(getPermissionDescription(approvalItem))
          .setColor(approved ? 0x00aa55 : 0xcc3333)
          .setFooter({ text: `Decided by ${interaction.user.username}` })
          .setTimestamp();

        await interaction.update({
          embeds: [resultEmbed],
          components: [],
        });

        aiLogger.info(
          { channelId, sessionId, tool: toolName, approved },
          "User responded to tool approval request",
        );

        return approved;
      } catch (error) {
        const timeoutEmbed = new EmbedBuilder()
          .setTitle(`Permission Expired: ${toolName}`)
          .setDescription(getPermissionDescription(approvalItem))
          .setColor(0x95a5a6)
          .setFooter({ text: "Request timed out" })
          .setTimestamp();

        await promptMessage
          .edit({
            embeds: [timeoutEmbed],
            components: [],
          })
          .catch((editError: unknown) => {
            aiLogger.debug(
              {
                error: (editError as Error)?.message,
                channelId,
                sessionId,
                tool: toolName,
              },
              "Failed to edit timed-out tool approval prompt",
            );
          });

        aiLogger.warn(
          {
            channelId,
            sessionId,
            tool: toolName,
            error: (error as Error).message,
          },
          "Tool approval request timed out",
        );

        return false;
      }
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
