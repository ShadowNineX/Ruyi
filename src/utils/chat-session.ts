import { EmbedBuilder, type Message, type TextBasedChannel } from "discord.js";
import { botLogger } from "../logger";
import { CHAT_TYPING_INTERVAL_MS } from "../constants";

const TOOL_STATUS_REFRESH_INTERVAL_MS = 1000;

export type SessionStatus =
  | "thinking"
  | "generating"
  | "tool"
  | "approval"
  | "complete"
  | "error";

export interface SessionStatusSnapshot {
  status: SessionStatus;
  currentTool?: string;
}

export type SessionStatusListener = (state: SessionStatusSnapshot) => void;

interface StatusState {
  status: SessionStatus;
  currentTool?: string;
  toolCounts: Map<string, number>;
  startTime: number;
}

function getStatusColor(status: SessionStatus): number {
  if (status === "tool") return 0x5865f2;
  if (status === "approval") return 0xffaa00;
  if (status === "error") return 0xff0000;
  return 0x2b2d31;
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

function formatToolList(toolCounts: Map<string, number>): string | null {
  if (toolCounts.size === 0) return null;

  return [...toolCounts.entries()]
    .map(([tool, count]) =>
      count > 1 ? `\`${tool}\` x${count}` : `\`${tool}\``,
    )
    .join("  ");
}

function getStatusTitle(status: SessionStatus): string {
  if (status === "approval") return "Permission Needed";
  if (status === "tool") return "Using Tool";
  return "Tool Activity";
}

function getStatusDescription(state: StatusState): string {
  if (state.status === "approval") {
    return "Waiting for your choice in the permission prompt.";
  }
  if (state.status === "tool") {
    return `Using \`${state.currentTool ?? "tool"}\`.`;
  }
  if (state.status === "generating") {
    return "Writing the reply with the tool results.";
  }
  if (state.status === "error") {
    return "The turn hit an error while using tools.";
  }

  return "Reviewing tool results.";
}

function buildToolStatusEmbed(state: StatusState): EmbedBuilder {
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);

  const embed = new EmbedBuilder()
    .setColor(getStatusColor(state.status))
    .setTitle(getStatusTitle(state.status))
    .setDescription(getStatusDescription(state))
    .setFooter({ text: `Active for ${formatElapsedTime(elapsed)}` });

  const toolList = formatToolList(state.toolCounts);
  if (toolList) {
    embed.addFields({ name: "Used This Turn", value: toolList });
  }

  return embed;
}

/**
 * Manages a chat session's typing indicator and temporary tool-call embed.
 */
export class ChatSession {
  private readonly state: StatusState;
  private typingInterval: ReturnType<typeof setInterval> | null = null;
  private statusRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private statusMessage: Message | null = null;
  private statusMessagePromise: Promise<Message | null> | null = null;
  private statusRefreshInFlight = false;
  private replyTarget: Message | null = null;
  private hasNotifiedStatus = false;
  private closed = false;
  private readonly channel: TextBasedChannel;
  private readonly onStatusChange?: SessionStatusListener;

  constructor(
    channel: TextBasedChannel,
    onStatusChange?: SessionStatusListener,
  ) {
    this.channel = channel;
    this.onStatusChange = onStatusChange;
    this.state = {
      status: "thinking",
      toolCounts: new Map(),
      startTime: Date.now(),
    };
  }

  private notifyStatusChange(): void {
    if (this.closed) return;

    this.hasNotifiedStatus = true;
    this.onStatusChange?.({
      status: this.state.status,
      currentTool: this.state.currentTool,
    });
  }

  private setStatus(status: SessionStatus, currentTool?: string): void {
    if (this.closed) return;

    const changed =
      this.state.status !== status || this.state.currentTool !== currentTool;
    this.state.status = status;
    this.state.currentTool = currentTool;
    if (changed || !this.hasNotifiedStatus) this.notifyStatusChange();
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
    if (this.closed) return;
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

  private startToolEmbedRefresh(): void {
    if (this.closed) return;
    if (this.statusRefreshInterval) return;

    this.statusRefreshInterval = setInterval(() => {
      void this.refreshToolEmbedTimer();
    }, TOOL_STATUS_REFRESH_INTERVAL_MS);
  }

  private stopToolEmbedRefresh(): void {
    if (!this.statusRefreshInterval) return;

    clearInterval(this.statusRefreshInterval);
    this.statusRefreshInterval = null;
  }

  private async refreshToolEmbedTimer(): Promise<void> {
    if (this.closed) return;
    if (!this.statusMessage) return;
    if (!this.shouldShowToolEmbed()) return;
    if (this.statusRefreshInFlight) return;

    this.statusRefreshInFlight = true;
    try {
      await this.statusMessage.edit({
        embeds: [buildToolStatusEmbed(this.state)],
      });
    } catch (error) {
      botLogger.debug(
        { error: (error as Error)?.message },
        "Tool embed timer refresh failed",
      );
    } finally {
      this.statusRefreshInFlight = false;
    }
  }

  /** Set the message that temporary tool-call embeds should reply to. */
  setReplyTarget(replyTo: Message): void {
    this.replyTarget = replyTo;
  }

  private shouldShowToolEmbed(): boolean {
    return (
      this.state.status === "tool" ||
      this.state.status === "approval" ||
      this.state.toolCounts.size > 0
    );
  }

  private async createToolEmbed(): Promise<Message | null> {
    if (this.closed) return null;
    if (!this.replyTarget) return null;
    if (!this.shouldShowToolEmbed()) return null;

    const replyTo = this.replyTarget;
    try {
      const statusMessage = await replyTo.reply({
        embeds: [buildToolStatusEmbed(this.state)],
      });
      if (this.closed || !this.shouldShowToolEmbed()) {
        await statusMessage.delete().catch((error: unknown) => {
          botLogger.debug(
            { error: (error as Error)?.message },
            "Late tool embed delete failed",
          );
        });
        return null;
      }
      return statusMessage;
    } catch (error) {
      botLogger.debug(
        {
          error: (error as Error)?.message,
          channelId: replyTo.channel.id,
          messageId: replyTo.id,
        },
        "Tool embed send failed",
      );
      return null;
    }
  }

  private async ensureToolEmbed(): Promise<void> {
    if (this.statusMessage) return;
    this.statusMessagePromise ??= this.createToolEmbed();
    const pendingMessage = this.statusMessagePromise;
    try {
      this.statusMessage = await pendingMessage;
      if (this.statusMessage) this.startToolEmbedRefresh();
    } finally {
      if (this.statusMessagePromise === pendingMessage) {
        this.statusMessagePromise = null;
      }
    }
  }

  /** Update the temporary tool-call embed. */
  private async updateToolEmbed(): Promise<void> {
    if (this.closed) return;
    if (!this.shouldShowToolEmbed()) return;
    if (!this.statusMessage) {
      await this.ensureToolEmbed();
      if (!this.statusMessage) return;
    }

    try {
      await this.statusMessage.edit({
        embeds: [buildToolStatusEmbed(this.state)],
      });
      this.startToolEmbedRefresh();
    } catch (error) {
      botLogger.debug(
        { error: (error as Error)?.message },
        "Tool embed update failed",
      );
    }
  }

  private async deleteToolEmbed(): Promise<void> {
    this.stopToolEmbedRefresh();
    const pendingMessage = this.statusMessagePromise
      ? await this.statusMessagePromise
      : null;
    const message = this.statusMessage ?? pendingMessage;
    this.statusMessage = null;

    if (!message) return;

    try {
      await message.delete();
    } catch (error) {
      botLogger.debug(
        { error: (error as Error)?.message },
        "Tool embed delete failed",
      );
    }
  }

  /** Delete the temporary tool-call embed and stop typing. */
  async deleteStatusEmbed(): Promise<void> {
    this.closed = true;
    this.stopTyping();
    await this.deleteToolEmbed();
  }

  /** Called when the AI is preparing a response, but not streaming text yet. */
  onThinking(): void {
    this.setStatus("thinking");
    this.startTyping();
    void this.updateToolEmbed();
  }

  /** Called when the SDK is actively streaming assistant text. */
  onTextGenerationStart(): void {
    this.setStatus("generating");
    this.startTyping();
    void this.updateToolEmbed();
  }

  /** Called when the current assistant text stream finishes. */
  onTextGenerationEnd(): void {
    this.stopTyping();
  }

  /** Called when a tool starts executing */
  onToolStart(toolName: string, _args: Record<string, unknown>): void {
    this.setStatus("tool", toolName);
    this.stopTyping();
    void this.updateToolEmbed();
  }

  /** Called when a tool finishes executing */
  onToolEnd(toolName: string): void {
    if (this.closed) return;

    this.state.toolCounts.set(
      toolName,
      (this.state.toolCounts.get(toolName) ?? 0) + 1,
    );
    void this.updateToolEmbed();
  }

  /** Called when the SDK pauses for Discord-side tool approval. */
  onApprovalPending(): void {
    this.setStatus("approval");
    this.stopTyping();
    void this.updateToolEmbed();
  }

  /** Called when generation is complete */
  onComplete(): void {
    this.setStatus("complete");
    this.stopTyping();
  }

  /** Called on error */
  onError(): void {
    this.setStatus("error");
    this.stopTyping();
  }

  /** Clean up all resources */
  cleanup(): void {
    this.closed = true;
    this.stopTyping();
    this.stopToolEmbedRefresh();
  }

  /** Check if a self-responding tool was used */
  usedSelfRespondingTool(selfRespondingTools: ReadonlySet<string>): boolean {
    for (const toolName of this.state.toolCounts.keys()) {
      if (selfRespondingTools.has(toolName)) return true;
    }
    return false;
  }
}
