import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type Interaction,
  type Message,
  type GuildTextBasedChannel,
  type TextChannel,
} from "discord.js";
import {
  chatService,
  permissionManager,
  replyClassifier,
  sessionManager,
} from "./ai";
import { runWithToolContext, type ToolContext } from "./utils/types";
import { env } from "./env";
import { selfRespondingToolNames } from "./tools";
import { botLogger } from "./logger";
import { handleCommands } from "./commands";
import {
  slashCommands,
  handleSlashCommand,
  handleSmitherySelect,
  handleSmitheryUnlinkSelect,
  handleSmitheryCheckButton,
  handleSearchProviderSelect,
  isSearchProviderSelect,
} from "./slash-commands";
import {
  ChatSession,
  type SessionStatusSnapshot,
} from "./utils/chat-session";
import {
  fetchReplyChain,
  fetchChatHistory,
  fetchReferencedMessage,
  formatMessageForAI,
  getMessageImageInputs,
  sendReplyChunks,
  getErrorMessage,
} from "./utils/messages";
import { messageSyncService } from "./services/message-sync";
import { CHAT_TURN_TIMEOUT_MS, DISCORD_OPERATION_TIMEOUT_MS } from "./constants";

interface ResponseGate {
  isMentioned: boolean;
  isDM: boolean;
  isReplyToBot: boolean;
}

interface PresenceActivity {
  name: string;
  type: ActivityType;
}

export class RuyiBot {
  private activePresenceSession: symbol | null = null;
  private readonly activeChatTurns = new Map<string, AbortController>();
  private presenceResetTimer: {
    session: symbol;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  // ---- Presence helpers ----------------------------------------------------

  private setDefaultPresence(): void {
    this.setActivityPresence({
      name: "over the pavilion",
      type: ActivityType.Watching,
    });
  }

  private setActivityPresence(activity: PresenceActivity): void {
    this.client.user?.setPresence({
      activities: [
        {
          name: this.truncateActivityName(activity.name),
          type: activity.type,
        },
      ],
    });
  }

  private truncateActivityName(name: string): string {
    return name.length > 128 ? `${name.slice(0, 125)}...` : name;
  }

  private setSessionPresence(
    username: string,
    snapshot: SessionStatusSnapshot,
  ): void {
    const toolName = snapshot.currentTool ?? "a tool";
    const activities: Record<
      SessionStatusSnapshot["status"],
      PresenceActivity
    > = {
      thinking: {
        name: `${username}'s request`,
        type: ActivityType.Listening,
      },
      generating: {
        name: `a reply for ${username}`,
        type: ActivityType.Playing,
      },
      tool: {
        name: `${toolName} for ${username}`,
        type: ActivityType.Watching,
      },
      approval: {
        name: `approval from ${username}`,
        type: ActivityType.Watching,
      },
      complete: {
        name: `the finished reply for ${username}`,
        type: ActivityType.Watching,
      },
      error: {
        name: "for recovery",
        type: ActivityType.Watching,
      },
    };

    this.setActivityPresence(activities[snapshot.status]);
  }

  private clearPresenceResetTimer(presenceSession?: symbol): void {
    if (!this.presenceResetTimer) return;
    if (
      presenceSession &&
      this.presenceResetTimer.session !== presenceSession
    ) {
      return;
    }

    clearTimeout(this.presenceResetTimer.timer);
    this.presenceResetTimer = null;
  }

  private resetPresenceSession(presenceSession: symbol): void {
    if (this.activePresenceSession !== presenceSession) return;

    this.activePresenceSession = null;
    this.setDefaultPresence();
  }

  private schedulePresenceReset(
    presenceSession: symbol,
    context: Record<string, unknown>,
  ): void {
    this.clearPresenceResetTimer();

    const timeoutMs = CHAT_TURN_TIMEOUT_MS + DISCORD_OPERATION_TIMEOUT_MS + 5000;
    const timer = setTimeout(() => {
      if (this.activePresenceSession !== presenceSession) return;

      botLogger.warn(
        { ...context, timeoutMs },
        "Presence session fallback reset fired",
      );
      this.resetPresenceSession(presenceSession);
    }, timeoutMs);
    this.presenceResetTimer = { session: presenceSession, timer };
  }

  // ---- Reply gating --------------------------------------------------------

  private computeResponseGate(
    message: Message,
    referencedMessage: Message | null,
  ): ResponseGate {
    const botUser = this.client.user;
    const isMentioned = botUser ? message.mentions.has(botUser) : false;
    const isDM = message.channel.isDMBased();
    const isReplyToBot =
      Boolean(botUser) && referencedMessage?.author.id === botUser?.id;

    return { isMentioned, isDM, isReplyToBot };
  }

  private async shouldBotRespond(
    message: Message,
    gate: ResponseGate,
  ): Promise<boolean> {
    const username = message.author.username;
    const channelName = "name" in message.channel ? message.channel.name : "DM";

    if (gate.isMentioned || gate.isDM || gate.isReplyToBot) {
      botLogger.info(
        { user: username, channel: channelName, ...gate },
        "Replying to mention/DM/reply",
      );
      return true;
    }

    try {
      const classifierMessage = formatMessageForAI(message);
      const shouldRespond = await replyClassifier.shouldReply(
        classifierMessage,
        this.client.user?.username ?? "Bot",
        message.channel.id,
      );
      botLogger.debug(
        {
          user: username,
          channel: channelName,
          decision: shouldRespond ? "reply" : "skip",
        },
        "Reply classifier decision",
      );
      return shouldRespond;
    } catch (error) {
      botLogger.error(
        { error: (error as Error)?.message, user: username },
        "Reply classifier failed; skipping",
      );
      return false;
    }
  }

  private isDirectResponseGate(gate: ResponseGate): boolean {
    return gate.isMentioned || gate.isDM || gate.isReplyToBot;
  }

  // ---- Chat handling -------------------------------------------------------

  private buildToolContext(
    message: Message,
    referencedMessage: Message | null,
  ): ToolContext {
    const channel: TextChannel | null =
      "name" in message.channel && "messages" in message.channel
        ? (message.channel as TextChannel)
        : null;

    return {
      message,
      channel,
      guild: message.guild,
      referencedMessage,
    };
  }

  private async runChat(
    message: Message,
    session: ChatSession,
    toolCtx: ToolContext,
    signal: AbortSignal,
  ): Promise<void> {
    this.throwIfAborted(signal);

    const username = message.author.username;
    const guildChannel = message.channel as GuildTextBasedChannel;

    const [replyChain, chatHistory] = await Promise.all([
      fetchReplyChain(message, toolCtx.referencedMessage),
      fetchChatHistory(message),
    ]);
    this.throwIfAborted(signal);

    const combinedHistory = [...replyChain, ...chatHistory];
    const imageInputs = [
      ...getMessageImageInputs(message, "current message"),
      ...(toolCtx.referencedMessage
        ? getMessageImageInputs(toolCtx.referencedMessage, "replied message")
        : []),
    ];

    botLogger.debug(
      {
        replyChainLength: replyChain.length,
        historyCount: chatHistory.length,
        imageInputCount: imageInputs.length,
      },
      "Fetched message context",
    );

    await session.sendStatusEmbed(message);
    this.throwIfAborted(signal);

    const userMessage = formatMessageForAI(message);
    const reply = await runWithToolContext(toolCtx, () =>
      chatService.chat({
        userMessage,
        username,
        channelId: message.channel.id,
        channel: guildChannel,
        userId: message.author.id,
        session,
        chatHistory: combinedHistory,
        imageInputs,
        messageId: message.id,
        signal,
      }),
    );
    this.throwIfAborted(signal);

    await session.deleteStatusEmbed();

    if (reply) {
      const sentChunks = await sendReplyChunks(message, reply, username);
      await sessionManager.recordAssistantMessages(
        message.channel.id,
        sentChunks.map((chunk) => chunk.id),
      );
      return;
    }

    if (!session.usedSelfRespondingTool(selfRespondingToolNames)) {
      botLogger.warn(
        {
          user: username,
          channelId: message.channel.id,
          messageId: message.id,
        },
        "Chat returned empty reply and no self-responding tool was used",
      );
      try {
        await message.reply(
          "Forgive me, my lord — your humble servant could not produce a reply this time. Please try again in a moment.",
        );
      } catch (replyError) {
        botLogger.error(
          {
            error: (replyError as Error).message,
            channelId: message.channel.id,
          },
          "Failed to send empty-reply notice",
        );
      }
    }
  }

  private createChatTurnTimeoutError(): Error {
    const timeoutSeconds = Math.round(CHAT_TURN_TIMEOUT_MS / 1000);
    const error = new Error(
      `Chat turn timed out after ${timeoutSeconds} seconds`,
    );
    error.name = "ChatTurnTimeoutError";
    return error;
  }

  private createChatTurnSupersededError(): Error {
    const error = new Error("Chat turn was superseded by a newer direct request");
    error.name = "ChatTurnSupersededError";
    return error;
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const reason: unknown = signal.reason;
    if (reason instanceof Error) throw reason;
    throw this.createChatTurnTimeoutError();
  }

  private getAbortError(signal: AbortSignal): Error {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) return reason;
    return new Error("Chat turn was aborted");
  }

  private abortActiveChatTurn(channelId: string, nextMessageId: string): void {
    const activeController = this.activeChatTurns.get(channelId);
    if (!activeController || activeController.signal.aborted) return;

    activeController.abort(this.createChatTurnSupersededError());
    botLogger.warn(
      { channelId, nextMessageId },
      "Aborted previous chat turn for newer direct request",
    );
  }

  private async withOperationTimeout<T>(
    operation: Promise<T>,
    operationName: string,
    context: Record<string, unknown>,
  ): Promise<T | null> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const guardedOperation = operation.catch((error: unknown) => {
      botLogger.error(
        {
          ...context,
          error: (error as Error)?.message,
          name: (error as Error)?.name,
        },
        `${operationName} failed`,
      );
      return null;
    });

    const timeoutPromise = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        botLogger.warn(
          { ...context, timeoutMs: DISCORD_OPERATION_TIMEOUT_MS },
          `${operationName} timed out`,
        );
        resolve(null);
      }, DISCORD_OPERATION_TIMEOUT_MS);
    });

    try {
      return await Promise.race([guardedOperation, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async deleteStatusEmbedSafely(
    session: ChatSession,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.withOperationTimeout(
      session.deleteStatusEmbed(),
      "Status embed delete",
      context,
    );
  }

  private async deletePermissionPromptsSafely(
    turnId: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.withOperationTimeout(
      permissionManager.deletePromptMessages(turnId),
      "Permission prompt cleanup",
      context,
    );
  }

  private async replySafely(
    message: Message,
    content: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.withOperationTimeout(
      message.reply(content),
      "Error reply send",
      context,
    );
  }

  private getAbortPromise(signal: AbortSignal): Promise<never> {
    if (signal.aborted) return Promise.reject(this.getAbortError(signal));

    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(this.getAbortError(signal));
        },
        { once: true },
      );
    });
  }

  private async runChatWithWatchdog(
    message: Message,
    session: ChatSession,
    toolCtx: ToolContext,
    abortController: AbortController,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const signal = abortController.signal;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = this.createChatTurnTimeoutError();
        abortController.abort(error);
        botLogger.warn(
          {
            user: message.author.username,
            channelId: message.channel.id,
            messageId: message.id,
            timeoutMs: CHAT_TURN_TIMEOUT_MS,
          },
          "Chat turn watchdog timed out",
        );
        reject(error);
      }, CHAT_TURN_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        this.runChat(message, session, toolCtx, signal),
        timeoutPromise,
        this.getAbortPromise(signal),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async handleAIChat(message: Message): Promise<void> {
    const referencedMessage =
      (await this.withOperationTimeout(
        fetchReferencedMessage(message),
        "Referenced message fetch",
        {
          user: message.author.username,
          channelId: message.channel.id,
          messageId: message.id,
        },
      )) ?? null;
    const gate = this.computeResponseGate(message, referencedMessage);
    if (!(await this.shouldBotRespond(message, gate))) return;
    if (this.isDirectResponseGate(gate)) {
      this.abortActiveChatTurn(message.channel.id, message.id);
    }

    const displayName = message.author.displayName;
    const presenceSession = Symbol(message.id);
    const abortController = new AbortController();
    this.activeChatTurns.set(message.channel.id, abortController);
    this.activePresenceSession = presenceSession;
    this.schedulePresenceReset(presenceSession, {
      user: message.author.username,
      channelId: message.channel.id,
      messageId: message.id,
    });
    const session = new ChatSession(message.channel, (state) => {
      if (this.activePresenceSession !== presenceSession) return;
      this.setSessionPresence(displayName, state);
    });
    session.onThinking();

    const toolCtx = this.buildToolContext(message, referencedMessage);

    try {
      await this.runChatWithWatchdog(
        message,
        session,
        toolCtx,
        abortController,
      );
    } catch (error) {
      const err = error as {
        status?: number;
        code?: number;
        error?: { message?: string };
        message?: string;
        stack?: string;
        name?: string;
      };
      const isSuperseded = err?.name === "ChatTurnSupersededError";
      const logPayload = {
        status: err?.status ?? err?.code,
        name: err?.name,
        error: err?.error?.message ?? err?.message,
        stack: err?.stack,
        user: message.author.username,
        channelId: message.channel.id,
        messageId: message.id,
      };

      if (isSuperseded) {
        botLogger.warn(logPayload, "Chat turn superseded");
      } else {
        botLogger.error(logPayload, "Failed to generate reply");
      }

      await this.deleteStatusEmbedSafely(session, logPayload);
      if (!isSuperseded) {
        await this.replySafely(message, getErrorMessage(error), logPayload);
      }
    } finally {
      session.cleanup();
      this.resetPresenceSession(presenceSession);
      this.clearPresenceResetTimer(presenceSession);

      await this.deletePermissionPromptsSafely(message.id, {
        user: message.author.username,
        channelId: message.channel.id,
        messageId: message.id,
      });
      if (this.activeChatTurns.get(message.channel.id) === abortController) {
        this.activeChatTurns.delete(message.channel.id);
      }
    }
  }

  private readonly dispatchMessage = async (message: Message): Promise<void> => {
    try {
      if (message.author.bot) return;
      if (await handleCommands(message)) return;
      await this.handleAIChat(message);
    } catch (error) {
      botLogger.error(
        {
          error: (error as Error)?.message,
          stack: (error as Error)?.stack,
          name: (error as Error)?.name,
          user: message.author.username,
          channelId: message.channel.id,
          messageId: message.id,
        },
        "Message dispatch failed",
      );
    }
  };

  // ---- Slash command registration -----------------------------------------

  private async registerSlashCommands() {
    const rest = new REST().setToken(env.DISCORD_TOKEN);
    try {
      const commands = slashCommands.map((cmd) => cmd.toJSON());
      await rest.put(Routes.applicationCommands(this.client.user!.id), {
        body: commands,
      });
      botLogger.info({ count: commands.length }, "Registered slash commands");
    } catch (error) {
      botLogger.error({ error }, "Failed to register slash commands");
    }
  }

  private readonly dispatchInteraction = async (
    interaction: Interaction,
  ): Promise<void> => {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (
      interaction.isStringSelectMenu() &&
      isSearchProviderSelect(interaction.customId)
    ) {
      await handleSearchProviderSelect(interaction);
    } else if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "smithery_select_server"
    ) {
      await handleSmitherySelect(interaction);
    } else if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "smithery_unlink_server"
    ) {
      await handleSmitheryUnlinkSelect(interaction);
    } else if (
      interaction.isButton() &&
      interaction.customId.startsWith("smithery_check:")
    ) {
      await handleSmitheryCheckButton(interaction);
    }
  };

  registerEvents() {
    this.client.once(Events.ClientReady, async (readyClient) => {
      botLogger.info({ tag: readyClient.user.tag }, "Bot logged in");
      this.setDefaultPresence();
      await this.registerSlashCommands();
      messageSyncService.start(this.client);
    });

    this.client.on(Events.InteractionCreate, this.dispatchInteraction);

    this.client.on(Events.MessageCreate, (message) => {
      void this.dispatchMessage(message);
    });

    this.client.on(Events.MessageDelete, async (message) => {
      if (message.id && message.channelId) {
        await messageSyncService.deleteMessage(message.channelId, message.id);
      }
    });

    this.client.on(Events.MessageBulkDelete, async (messages, channel) => {
      const messageIds = [...messages.keys()];
      if (messageIds.length === 0) return;

      await messageSyncService.deleteMessages(channel.id, messageIds);
    });
  }

  start() {
    botLogger.info("Starting bot...");
    return this.client.login(env.DISCORD_TOKEN);
  }
}

export const ruyiBot = new RuyiBot();
