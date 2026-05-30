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

      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const collector = promptMessage.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: timeoutMs,
        });

        collector.on("collect", (interaction: ButtonInteraction) => {
          void (async () => {
            if (interaction.user.id !== userId) {
              await interaction
                .reply({
                  content: "Only the user who requested this action can respond.",
                  flags: MessageFlags.Ephemeral,
                })
                .catch((replyError: unknown) => {
                  aiLogger.debug(
                    {
                      error: (replyError as Error)?.message,
                      channelId,
                      sessionId,
                      tool: toolName,
                    },
                    "Failed to reply to unauthorized approval click",
                  );
                });
              return;
            }

            const approved = interaction.customId.startsWith("perm_approve");
            const resultEmbed = createPermissionEmbed(
              approved
                ? `Permission Granted: ${toolName}`
                : `Permission Denied: ${toolName}`,
              approvalItem,
              approved ? 0x00aa55 : 0xcc3333,
              `Decided by ${interaction.user.username}`,
            );

            try {
              await interaction.update({
                embeds: [resultEmbed],
                components: [],
              });
              settled = true;
              collector.stop(approved ? "approved" : "denied");

              aiLogger.info(
                { channelId, sessionId, tool: toolName, approved },
                "User responded to tool approval request",
              );

              resolve(approved);
            } catch (error) {
              settled = true;
              collector.stop("update_failed");
              aiLogger.error(
                {
                  channelId,
                  sessionId,
                  tool: toolName,
                  error: (error as Error).message,
                },
                "Failed to update tool approval prompt",
              );
              resolve(false);
            }
          })();
        });

        collector.on("end", (_collected, reason) => {
          if (settled) return;
          settled = true;

          const timeoutEmbed = createPermissionEmbed(
            `Permission Expired: ${toolName}`,
            approvalItem,
            0x95a5a6,
            "Request timed out",
          );

          void promptMessage
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
              reason,
            },
            "Tool approval request ended without approval",
          );

          resolve(false);
        });
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
