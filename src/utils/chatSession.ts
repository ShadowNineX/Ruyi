import { EmbedBuilder, type Message, type TextBasedChannel } from "discord.js";
import { botLogger } from "../logger";
import {
  CHAT_STATUS_UPDATE_INTERVAL_MS,
  CHAT_TYPING_INTERVAL_MS,
} from "../constants";

export type SessionStatus =
  | "thinking"
  | "generating"
  | "tool"
  | "complete"
  | "error";

interface StatusState {
  status: SessionStatus;
  currentTool?: string;
  toolCounts: Map<string, number>;
  startTime: number;
}

function getStatusColor(status: SessionStatus): number {
  if (status === "complete") return 0x00ff00;
  if (status === "error") return 0xff0000;
  return 0xffaa00;
}

function formatElapsedTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

function buildStatusEmbed(state: StatusState): EmbedBuilder {
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);

  let statusText: string;
  switch (state.status) {
    case "thinking":
      statusText = "Preparing response...";
      break;
    case "generating":
      statusText = "Writing response...";
      break;
    case "tool":
      statusText = `Running: \`${state.currentTool}\``;
      break;
    case "complete":
      statusText = "Complete";
      break;
    case "error":
      statusText = "Error";
      break;
  }

  let description = `**${statusText}** • ${formatElapsedTime(elapsed)}`;
  if (state.toolCounts.size > 0) {
    const toolList = [...state.toolCounts.entries()]
      .map(([tool, count]) =>
        count > 1 ? `\`${tool}\` ×${count}` : `\`${tool}\``,
      )
      .join(" ");
    description += `\n${toolList}`;
  }

  return new EmbedBuilder()
    .setColor(getStatusColor(state.status))
    .setDescription(description);
}

/**
 * Manages the state of a chat session including typing indicators,
 * status embeds, and tool execution tracking.
 */
export class ChatSession {
  private readonly state: StatusState;
  private typingInterval: ReturnType<typeof setInterval> | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private statusMessage: Message | null = null;
  private readonly channel: TextBasedChannel;

  constructor(channel: TextBasedChannel) {
    this.channel = channel;
    this.state = {
      status: "thinking",
      toolCounts: new Map(),
      startTime: Date.now(),
    };
  }

  private sendTypingOnce(reason: "initial" | "periodic"): void {
    if (!("sendTyping" in this.channel)) return;

    this.channel.sendTyping().catch((error: unknown) => {
      botLogger.debug(
        { error: (error as Error)?.message },
        `sendTyping failed (${reason})`,
      );
    });
  }

  /** Start the typing indicator */
  startTyping(): void {
    if (this.typingInterval) return;
    if ("sendTyping" in this.channel) {
      this.sendTypingOnce("initial");
      this.typingInterval = setInterval(() => {
        this.sendTypingOnce("periodic");
      }, CHAT_TYPING_INTERVAL_MS);
    }
  }

  /** Stop the typing indicator */
  stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  /** Create and send the status embed as a reply */
  async sendStatusEmbed(replyTo: Message): Promise<void> {
    try {
      this.statusMessage = await replyTo.reply({
        embeds: [buildStatusEmbed(this.state)],
      });
    } catch (error) {
      botLogger.debug(
        {
          error: (error as Error)?.message,
          channelId: replyTo.channel.id,
          messageId: replyTo.id,
        },
        "Status embed send failed",
      );
      return;
    }

    this.updateInterval = setInterval(() => {
      if (this.state.status !== "complete" && this.state.status !== "error") {
        this.updateEmbed();
      }
    }, CHAT_STATUS_UPDATE_INTERVAL_MS);
  }

  /** Update the status embed */
  private async updateEmbed(): Promise<void> {
    if (!this.statusMessage) return;
    try {
      await this.statusMessage.edit({ embeds: [buildStatusEmbed(this.state)] });
    } catch (error) {
      botLogger.debug(
        { error: (error as Error)?.message },
        "Status embed update failed",
      );
    }
  }

  /** Delete the status embed */
  async deleteStatusEmbed(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    if (this.statusMessage) {
      try {
        await this.statusMessage.delete();
      } catch (error) {
        botLogger.debug(
          { error: (error as Error)?.message },
          "Status embed delete failed",
        );
      }
      this.statusMessage = null;
    }
  }

  /** Called when the AI is preparing a response, but not streaming text yet. */
  onThinking(): void {
    this.state.status = "thinking";
    this.state.currentTool = undefined;
    this.stopTyping();
  }

  /** Called when the SDK is actively streaming assistant text. */
  onTextGenerationStart(): void {
    this.state.status = "generating";
    this.state.currentTool = undefined;
    this.startTyping();
    this.updateEmbed();
  }

  /** Called when the current assistant text stream finishes. */
  onTextGenerationEnd(): void {
    this.stopTyping();
  }

  /** Called when a tool starts executing */
  onToolStart(toolName: string, _args: Record<string, unknown>): void {
    this.state.status = "tool";
    this.state.currentTool = toolName;
    this.stopTyping();
    this.updateEmbed();
  }

  /** Called when a tool finishes executing */
  onToolEnd(toolName: string): void {
    this.state.toolCounts.set(
      toolName,
      (this.state.toolCounts.get(toolName) ?? 0) + 1,
    );
  }

  /** Called when generation is complete */
  onComplete(): void {
    this.state.status = "complete";
    this.state.currentTool = undefined;
    this.stopTyping();
  }

  /** Called on error */
  onError(): void {
    this.state.status = "error";
    this.stopTyping();
  }

  /** Clean up all resources */
  cleanup(): void {
    this.stopTyping();
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /** Check if a self-responding tool was used */
  usedSelfRespondingTool(selfRespondingTools: ReadonlySet<string>): boolean {
    for (const toolName of this.state.toolCounts.keys()) {
      if (selfRespondingTools.has(toolName)) return true;
    }
    return false;
  }

  /** Get current status */
  get status(): SessionStatus {
    return this.state.status;
  }
}
