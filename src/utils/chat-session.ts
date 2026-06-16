import {
  EmbedBuilder,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { botLogger } from "../logger";
import {
  CHAT_TYPING_INTERVAL_MS,
  STREAM_PREVIEW_EDIT_INTERVAL_MS,
  STREAM_PREVIEW_MAX_LENGTH,
} from "../constants";
import {
  createChatSessionStore,
  incrementChatSessionToolCount,
  setChatSessionPartial,
  type ChatSessionState,
  type PermissionPromptController,
  type PermissionPromptPayload,
  type SessionStatusListener,
} from "../stores";

const TOOL_STATUS_REFRESH_INTERVAL_MS = 1000;

type ChatSessionStatus = ChatSessionState["status"];

function getStatusColor(status: ChatSessionStatus): number {
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

function getStatusTitle(status: ChatSessionStatus): string {
  if (status === "approval") return "Permission Needed";
  if (status === "tool") return "Using Tool";
  return "Tool Activity";
}

function getStatusDescription(state: ChatSessionState): string {
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

function buildToolStatusEmbed(state: ChatSessionState): EmbedBuilder {
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

function buildToolStatusPayload(
  state: ChatSessionState,
): PermissionPromptPayload {
  return {
    embeds: [buildToolStatusEmbed(state)],
    components: [],
  };
}

function formatStreamPreviewContent(text: string): string | null {
  if (text.trim().length === 0) return null;
  if (text.length <= STREAM_PREVIEW_MAX_LENGTH) return text;

  return `${text.slice(0, STREAM_PREVIEW_MAX_LENGTH - 3)}...`;
}

/**
 * Manages a chat session's typing indicator and temporary tool-call embed.
 */
export class ChatSession {
  private readonly store = createChatSessionStore();
  private readonly channel: TextBasedChannel;
  private readonly onStatusChange?: SessionStatusListener;

  constructor(
    channel: TextBasedChannel,
    onStatusChange?: SessionStatusListener,
  ) {
    this.channel = channel;
    this.onStatusChange = onStatusChange;
  }

  private notifyStatusChange(): void {
    if (this.store.state.closed) return;

    setChatSessionPartial(this.store, { hasNotifiedStatus: true });
    this.onStatusChange?.({
      status: this.store.state.status,
      currentTool: this.store.state.currentTool,
    });
  }

  private setStatus(status: ChatSessionStatus, currentTool?: string): void {
    const state = this.store.state;
    if (state.closed) return;

    const changed =
      state.status !== status || state.currentTool !== currentTool;
    setChatSessionPartial(this.store, { status, currentTool });
    if (changed || !state.hasNotifiedStatus) this.notifyStatusChange();
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
    if (this.store.state.closed) return;
    if (this.store.state.typingInterval) return;
    if ("sendTyping" in this.channel) {
      this.sendTypingOnce("initial");
      const typingInterval = setInterval(() => {
        this.sendTypingOnce("periodic");
      }, CHAT_TYPING_INTERVAL_MS);
      setChatSessionPartial(this.store, { typingInterval });
    }
  }

  /** Stop the typing indicator */
  stopTyping(): void {
    const { typingInterval } = this.store.state;
    if (typingInterval) {
      clearInterval(typingInterval);
      setChatSessionPartial(this.store, { typingInterval: null });
    }
  }

  private startToolEmbedRefresh(): void {
    if (this.store.state.closed) return;
    if (this.store.state.statusRefreshInterval) return;

    const statusRefreshInterval = setInterval(() => {
      void this.refreshToolEmbedTimer();
    }, TOOL_STATUS_REFRESH_INTERVAL_MS);
    setChatSessionPartial(this.store, { statusRefreshInterval });
  }

  private stopToolEmbedRefresh(): void {
    const { statusRefreshInterval } = this.store.state;
    if (!statusRefreshInterval) return;

    clearInterval(statusRefreshInterval);
    setChatSessionPartial(this.store, { statusRefreshInterval: null });
  }

  private async refreshToolEmbedTimer(): Promise<void> {
    const state = this.store.state;
    if (state.closed) return;
    if (!state.statusMessage) return;
    if (state.permissionPromptActive) return;
    if (!this.shouldShowToolEmbed()) return;
    if (state.statusRefreshInFlight) return;

    setChatSessionPartial(this.store, { statusRefreshInFlight: true });
    try {
      if (this.store.state.permissionPromptActive) return;
      await state.statusMessage.edit(buildToolStatusPayload(this.store.state));
    } catch (error) {
      botLogger.debug(
        { error: (error as Error)?.message },
        "Tool embed timer refresh failed",
      );
    } finally {
      setChatSessionPartial(this.store, { statusRefreshInFlight: false });
    }
  }

  /** Set the message that temporary tool-call embeds should reply to. */
  setReplyTarget(replyTo: Message): void {
    setChatSessionPartial(this.store, { replyTarget: replyTo });
  }

  private shouldShowToolEmbed(): boolean {
    const state = this.store.state;
    return (
      state.status === "tool" ||
      state.status === "approval" ||
      state.toolCounts.size > 0
    );
  }

  private async createStatusMessage(
    payload: PermissionPromptPayload,
  ): Promise<Message | null> {
    const { closed, replyTarget } = this.store.state;
    if (closed) return null;
    if (!replyTarget) return null;

    const replyTo = replyTarget;
    try {
      const statusMessage = await replyTo.reply(payload);
      if (this.store.state.closed) {
        await statusMessage.delete().catch((error: unknown) => {
          botLogger.debug(
            { error: (error as Error)?.message },
            "Late status embed delete failed",
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
        "Status embed send failed",
      );
      return null;
    }
  }

  private async createReplyMessage(content: string): Promise<Message | null> {
    const { closed, replyTarget } = this.store.state;
    if (closed) return null;

    try {
      const sent = replyTarget
        ? await replyTarget.reply(content)
        : "send" in this.channel
          ? await this.channel.send(content)
          : null;

      if (!sent) return null;
      if (this.store.state.closed) {
        await sent.delete().catch((error: unknown) => {
          botLogger.debug(
            { error: (error as Error)?.message },
            "Late stream preview delete failed",
          );
        });
        return null;
      }
      return sent;
    } catch (error) {
      botLogger.debug(
        {
          error: (error as Error)?.message,
          channelId: this.channel.id,
          messageId: replyTarget?.id,
        },
        "Stream preview send failed",
      );
      return null;
    }
  }

  private trackStatusMessagePromise(
    statusMessagePromise: Promise<Message | null>,
  ): Promise<Message | null> {
    setChatSessionPartial(this.store, { statusMessagePromise });
    return statusMessagePromise;
  }

  private async resolveStatusMessagePromise(
    pendingMessage: Promise<Message | null>,
  ): Promise<Message | null> {
    try {
      const statusMessage = await pendingMessage;
      setChatSessionPartial(this.store, { statusMessage });
      return statusMessage;
    } finally {
      if (this.store.state.statusMessagePromise === pendingMessage) {
        setChatSessionPartial(this.store, { statusMessagePromise: null });
      }
    }
  }

  private async resolveStreamPreviewMessagePromise(
    pendingMessage: Promise<Message | null>,
  ): Promise<Message | null> {
    try {
      const streamPreviewMessage = await pendingMessage;
      setChatSessionPartial(this.store, { streamPreviewMessage });
      return streamPreviewMessage;
    } finally {
      if (this.store.state.streamPreviewMessagePromise === pendingMessage) {
        setChatSessionPartial(this.store, {
          streamPreviewMessagePromise: null,
        });
      }
    }
  }

  private async ensureToolEmbed(): Promise<void> {
    const state = this.store.state;
    if (state.statusMessage) return;
    const statusMessagePromise =
      state.statusMessagePromise ??
      this.createStatusMessage(buildToolStatusPayload(state));
    const statusMessage = await this.resolveStatusMessagePromise(
      this.trackStatusMessagePromise(statusMessagePromise),
    );
    if (statusMessage) this.startToolEmbedRefresh();
  }

  /** Update the temporary tool-call embed. */
  private async updateToolEmbed(): Promise<void> {
    if (this.store.state.closed) return;
    if (this.store.state.permissionPromptActive) return;
    if (!this.shouldShowToolEmbed()) return;
    if (!this.store.state.statusMessage) {
      await this.ensureToolEmbed();
      if (!this.store.state.statusMessage) return;
    }

    try {
      await this.store.state.statusMessage.edit(
        buildToolStatusPayload(this.store.state),
      );
      this.startToolEmbedRefresh();
    } catch (error) {
      botLogger.debug(
        { error: (error as Error)?.message },
        "Tool embed update failed",
      );
    }
  }

  private appendStreamPreviewDelta(delta: string): void {
    setChatSessionPartial(this.store, {
      streamPreviewText: `${this.store.state.streamPreviewText}${delta}`,
    });
  }

  private clearStreamPreviewEditTimer(): void {
    const { streamPreviewEditTimer } = this.store.state;
    if (!streamPreviewEditTimer) return;

    clearTimeout(streamPreviewEditTimer);
    setChatSessionPartial(this.store, { streamPreviewEditTimer: null });
  }

  private async ensureStreamPreviewMessage(
    content: string,
  ): Promise<Message | null> {
    const state = this.store.state;
    if (state.streamPreviewMessage) return state.streamPreviewMessage;

    const streamPreviewMessagePromise =
      state.streamPreviewMessagePromise ?? this.createReplyMessage(content);
    setChatSessionPartial(this.store, { streamPreviewMessagePromise });
    return this.resolveStreamPreviewMessagePromise(
      streamPreviewMessagePromise,
    );
  }

  private async flushStreamPreview(): Promise<void> {
    const state = this.store.state;
    if (state.closed) return;
    if (state.streamPreviewEditInFlight) return;

    const content = formatStreamPreviewContent(state.streamPreviewText);
    if (!content) return;

    setChatSessionPartial(this.store, { streamPreviewEditInFlight: true });
    try {
      const message = await this.ensureStreamPreviewMessage(content);
      if (!message) return;

      await message.edit(content);
      setChatSessionPartial(this.store, {
        streamPreviewLastEditAt: Date.now(),
      });
    } catch (error) {
      botLogger.debug(
        { error: (error as Error)?.message },
        "Stream preview update failed",
      );
    } finally {
      setChatSessionPartial(this.store, {
        streamPreviewEditInFlight: false,
      });
    }
  }

  private scheduleStreamPreviewUpdate(): void {
    if (this.store.state.closed) return;
    if (this.store.state.streamPreviewEditTimer) return;

    const elapsedSinceLastEdit =
      Date.now() - this.store.state.streamPreviewLastEditAt;
    const delay = Math.max(
      0,
      STREAM_PREVIEW_EDIT_INTERVAL_MS - elapsedSinceLastEdit,
    );

    const streamPreviewEditTimer = setTimeout(() => {
      setChatSessionPartial(this.store, { streamPreviewEditTimer: null });
      void this.flushStreamPreview();
    }, delay);
    setChatSessionPartial(this.store, { streamPreviewEditTimer });
  }

  private async deleteStreamPreview(): Promise<void> {
    this.clearStreamPreviewEditTimer();
    const { streamPreviewMessage, streamPreviewMessagePromise } =
      this.store.state;
    const pendingMessage = streamPreviewMessagePromise
      ? await streamPreviewMessagePromise
      : null;
    const message = streamPreviewMessage ?? pendingMessage;
    setChatSessionPartial(this.store, {
      streamPreviewMessage: null,
      streamPreviewMessagePromise: null,
      streamPreviewText: "",
      streamPreviewEditInFlight: false,
    });

    if (!message) return;

    try {
      await message.delete();
    } catch (error) {
      botLogger.debug(
        { error: (error as Error)?.message },
        "Stream preview delete failed",
      );
    }
  }

  private async getExistingStatusMessage(): Promise<Message | null> {
    const state = this.store.state;
    if (state.statusMessage) return state.statusMessage;
    if (!state.statusMessagePromise) return null;

    return this.resolveStatusMessagePromise(state.statusMessagePromise);
  }

  getPermissionPromptController(): PermissionPromptController {
    return {
      showPrompt: async (payload) => {
        if (this.store.state.closed) return null;

        setChatSessionPartial(this.store, { permissionPromptActive: true });
        this.stopToolEmbedRefresh();

        const existingMessage = await this.getExistingStatusMessage();
        if (existingMessage) {
          try {
            await existingMessage.edit(payload);
            return existingMessage;
          } catch (error) {
            botLogger.debug(
              { error: (error as Error)?.message },
              "Status embed permission prompt update failed",
            );
            setChatSessionPartial(this.store, { statusMessage: null });
          }
        }

        const statusMessagePromise = this.createStatusMessage(payload);
        return this.resolveStatusMessagePromise(
          this.trackStatusMessagePromise(statusMessagePromise),
        );
      },
      releasePrompt: () => {
        setChatSessionPartial(this.store, { permissionPromptActive: false });
      },
    };
  }

  private async deleteToolEmbed(): Promise<void> {
    this.stopToolEmbedRefresh();
    const { statusMessage, statusMessagePromise } = this.store.state;
    const pendingMessage = statusMessagePromise
      ? await statusMessagePromise
      : null;
    const message = statusMessage ?? pendingMessage;
    setChatSessionPartial(this.store, {
      statusMessage: null,
      statusMessagePromise: null,
    });

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
    setChatSessionPartial(this.store, { closed: true });
    this.stopTyping();
    await this.deleteStreamPreview();
    await this.deleteToolEmbed();
  }

  /** Called when the AI is preparing a response, but not streaming text yet. */
  onThinking(): void {
    this.setStatus("thinking");
    this.startTyping();
    void this.updateToolEmbed();
  }

  /** Called when the SDK is actively streaming assistant text. */
  onTextGenerationStart(delta?: string): void {
    this.setStatus("generating");
    this.startTyping();
    if (delta) {
      this.appendStreamPreviewDelta(delta);
      this.scheduleStreamPreviewUpdate();
    }
    void this.updateToolEmbed();
  }

  /** Called when the current assistant text stream finishes. */
  onTextGenerationEnd(): void {
    this.stopTyping();
    this.clearStreamPreviewEditTimer();
    void this.flushStreamPreview();
  }

  /** Called when a tool starts executing */
  onToolStart(toolName: string, _args: Record<string, unknown>): void {
    this.setStatus("tool", toolName);
    this.stopTyping();
    void this.updateToolEmbed();
  }

  /** Called when a tool finishes executing */
  onToolEnd(toolName: string): void {
    if (this.store.state.closed) return;

    incrementChatSessionToolCount(this.store, toolName);
    void this.updateToolEmbed();
  }

  /** Called when the SDK pauses for Discord-side tool approval. */
  onApprovalPending(): void {
    this.setStatus("approval");
    this.stopTyping();
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
    setChatSessionPartial(this.store, { closed: true });
    this.stopTyping();
    this.stopToolEmbedRefresh();
    this.clearStreamPreviewEditTimer();
  }

  /** Check if a self-responding tool was used */
  usedSelfRespondingTool(selfRespondingTools: ReadonlySet<string>): boolean {
    for (const toolName of this.store.state.toolCounts.keys()) {
      if (selfRespondingTools.has(toolName)) return true;
    }
    return false;
  }
}
