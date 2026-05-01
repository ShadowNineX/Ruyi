import { EmbedBuilder, type Message, type TextBasedChannel } from "discord.js";
import { botLogger } from "../logger";

export type SessionStatus = "thinking" | "tool" | "complete" | "error";

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
      statusText = "Thinking...";
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

  /** Start the typing indicator */
  startTyping(): void {
    if (this.typingInterval) return;
    if ("sendTyping" in this.channel) {
      this.channel.sendTyping().catch((error: unknown) => {
        botLogger.debug(
          { error: (error as Error)?.message },
          "sendTyping failed (initial)",
        );
      });
      this.typingInterval = setInterval(() => {
        if ("sendTyping" in this.channel) {
          this.channel.sendTyping().catch((error: unknown) => {
            botLogger.debug(
              { error: (error as Error)?.message },
              "sendTyping failed (periodic)",
            );
          });
        }
      }, 8000);
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
    this.statusMessage = await replyTo.reply({
      embeds: [buildStatusEmbed(this.state)],
    });

    // Start periodic updates
    this.updateInterval = setInterval(() => {
      if (this.state.status !== "complete" && this.state.status !== "error") {
        this.updateEmbed();
      }
    }, 1000);
  }

  /** Update the status embed */
  private async updateEmbed(): Promise<void> {
    if (!this.statusMessage) return;
    try {
      await this.statusMessage.edit({ embeds: [buildStatusEmbed(this.state)] });
    } catch {
      // Ignore edit failures
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
      } catch {
        // Ignore delete failures
      }
      this.statusMessage = null;
    }
  }

  /** Called when the AI starts thinking/generating */
  onThinking(): void {
    this.state.status = "thinking";
    this.state.currentTool = undefined;
    this.startTyping();
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
    return [...this.state.toolCounts.keys()].some((t) =>
      selfRespondingTools.has(t),
    );
  }

  /** Get current status */
  get status(): SessionStatus {
    return this.state.status;
  }
}
