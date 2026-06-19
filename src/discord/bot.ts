import type { Interaction, Message, PartialMessage } from 'discord.js';
import type { SessionStatusSnapshot } from '../stores';
import type { ToolContext } from '../utils/types';
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,

  Partials,
  REST,
  Routes,
} from 'discord.js';
import {
  chatService,
  conversationContext,
  editClassifier,
  permissionManager,
  replyClassifier,
  sessionManager,
} from '../ai';
import { userConfigScope } from '../config';
import {
  CHAT_TURN_TIMEOUT_MS,
  DISCORD_OPERATION_TIMEOUT_MS,
} from '../constants';
import { env } from '../env';
import { botLogger } from '../logger';
import {
  deleteActiveChatTurn,
  getActiveChatTurn,
  getActivePresenceSession,
  getPresenceResetTimer,

  setActiveChatTurn,
  setActivePresenceSession,
  setPresenceResetTimer,
} from '../stores';
import { selfRespondingToolNames } from '../tools';
import { runWithToolContext } from '../utils/types';
import { buildDiscordUserIdentity } from '../utils/user-identity';
import { handleCommands } from './commands';
import { awayMessageService } from './services/away-messages';
import { messageSyncService } from './services/message-sync';
import { reminderService } from './services/reminders';
import {
  handleMemoriesButton,
  handleMemoriesModal,
  handleModelSelect,
  handleReminderAutocomplete,
  handleSearchProviderSelect,
  handleSlashCommand,
  handleSmitheryCheckButton,
  handleSmitherySelect,
  handleSmitheryUnlinkSelect,
  isMemoriesButton,
  isMemoriesModal,
  isModelSelect,
  isSearchProviderSelect,
  slashCommands,
} from './slash-commands';
import { ChatSession } from './utils/chat-session';
import {
  buildDiscordProfile,
  buildDiscordUserProfile,
  formatProfileContext,
} from './utils/discord-profile';
import {
  editReplyChunks,
  fetchChatHistory,
  fetchReferencedMessage,
  fetchReplyChain,
  formatMessageForAI,
  getErrorMessage,
  getMessageImageInputs,
  sendReplyChunks,
} from './utils/messages';

interface ResponseGate {
  isMentioned: boolean;
  isDM: boolean;
  isReplyToBot: boolean;
}

interface PresenceActivity {
  name: string;
  type: ActivityType;
}

const EDIT_REGENERATION_PREFIX
  = '[The user edited this earlier Discord message after Ruyi already replied. Treat the edited message below as authoritative. Regenerate the answer for the edited version, but do not mention the edit unless it is necessary for clarity. Previous visible bot replies may reflect the pre-edit message.]';

const SIDE_EFFECT_EDIT_NOTICE
  = 'I noticed this request was edited after I had already answered. I have updated my context, but I will not repeat tool or external actions automatically from an edit. Please send a new message if you want me to redo the action.';

class RuyiBot {
  readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildScheduledEvents,
    ],
    partials: [Partials.Channel],
  });

  // ---- Presence helpers ----------------------------------------------------

  private setDefaultPresence(): void {
    this.setActivityPresence({
      name: 'over the pavilion',
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
    const status = snapshot.status;
    if (status === 'complete') {
      this.setDefaultPresence();
      return;
    }

    const toolName = snapshot.currentTool ?? 'a tool';
    const activities: Record<
      Exclude<SessionStatusSnapshot['status'], 'complete'>,
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
      error: {
        name: 'for recovery',
        type: ActivityType.Watching,
      },
    };

    this.setActivityPresence(activities[status]);
  }

  private clearPresenceResetTimer(presenceSession?: symbol): void {
    const presenceResetTimer = getPresenceResetTimer();
    if (!presenceResetTimer) { return; }
    if (
      presenceSession
      && presenceResetTimer.session !== presenceSession
    ) {
      return;
    }

    clearTimeout(presenceResetTimer.timer);
    setPresenceResetTimer(null);
  }

  private resetPresenceSession(presenceSession: symbol): void {
    if (getActivePresenceSession() !== presenceSession) { return; }

    setActivePresenceSession(null);
    this.setDefaultPresence();
  }

  private schedulePresenceReset(
    presenceSession: symbol,
    context: Record<string, unknown>,
  ): void {
    this.clearPresenceResetTimer();

    const timeoutMs
      = CHAT_TURN_TIMEOUT_MS + DISCORD_OPERATION_TIMEOUT_MS + 5000;
    const timer = setTimeout(() => {
      if (getActivePresenceSession() !== presenceSession) { return; }

      botLogger.warn(
        { ...context, timeoutMs },
        'Presence session fallback reset fired',
      );
      this.resetPresenceSession(presenceSession);
    }, timeoutMs);
    setPresenceResetTimer({ session: presenceSession, timer });
  }

  // ---- Reply gating --------------------------------------------------------

  private computeResponseGate(
    message: Message,
    referencedMessage: Message | null,
  ): ResponseGate {
    const botUser = this.client.user;
    const isMentioned = botUser ? message.mentions.has(botUser) : false;
    const isDM = message.channel.isDMBased();
    const isReplyToBot
      = Boolean(botUser) && referencedMessage?.author.id === botUser?.id;

    return { isMentioned, isDM, isReplyToBot };
  }

  private async shouldBotRespond(
    message: Message,
    gate: ResponseGate,
  ): Promise<boolean> {
    const username = message.author.username;
    const channelName = 'name' in message.channel ? message.channel.name : 'DM';

    if (gate.isMentioned || gate.isDM || gate.isReplyToBot) {
      botLogger.info(
        { user: username, channel: channelName, ...gate },
        'Replying to mention/DM/reply',
      );
      return true;
    }

    try {
      const classifierMessage = formatMessageForAI(message);
      const shouldRespond = await replyClassifier.shouldReply(
        classifierMessage,
        this.client.user?.username ?? 'Bot',
        message.channel.id,
      );
      botLogger.debug(
        {
          user: username,
          channel: channelName,
          decision: shouldRespond ? 'reply' : 'skip',
        },
        'Reply classifier decision',
      );
      return shouldRespond;
    } catch (error) {
      botLogger.error(
        { error: (error as Error)?.message, user: username },
        'Reply classifier failed; skipping',
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
    return {
      surface: 'discord',
      identity: buildDiscordUserIdentity(
        message.author.id,
        message.author.username,
      ),
      message,
      channel: message.channel,
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
    const username = message.author.username;
    const reply = await this.generateChatReply(
      message,
      session,
      toolCtx,
      signal,
    );
    this.throwIfAborted(signal);

    await session.deleteStatusEmbed();
    this.throwIfAborted(signal);

    if (reply) {
      const sentChunks = await sendReplyChunks(message, reply, username);
      await sessionManager.recordAssistantMessages(
        message.channel.id,
        message.id,
        sentChunks.map(chunk => chunk.id),
      );
      await awayMessageService.scheduleAfterHandledTurn(message);
      return;
    }

    if (!session.usedSelfRespondingTool(selfRespondingToolNames)) {
      botLogger.warn(
        {
          user: username,
          channelId: message.channel.id,
          messageId: message.id,
        },
        'Chat returned empty reply and no self-responding tool was used',
      );
      try {
        await message.reply(
          'Forgive me, my lord — your humble servant could not produce a reply this time. Please try again in a moment.',
        );
      } catch (replyError) {
        botLogger.error(
          {
            error: (replyError as Error).message,
            channelId: message.channel.id,
          },
          'Failed to send empty-reply notice',
        );
      }
      return;
    }

    await awayMessageService.scheduleAfterHandledTurn(message);
  }

  private async generateChatReply(
    message: Message,
    session: ChatSession,
    toolCtx: ToolContext,
    signal: AbortSignal,
    userMessagePrefix?: string,
    persistUserMessage = true,
  ): Promise<string | null> {
    this.throwIfAborted(signal);

    const username = message.author.username;
    const textChannel = message.channel;
    const identity = buildDiscordUserIdentity(
      message.author.id,
      message.author.username,
    );

    const [replyChain, chatHistory] = await Promise.all([
      fetchReplyChain(message, toolCtx.referencedMessage),
      fetchChatHistory(message),
    ]);
    this.throwIfAborted(signal);

    const combinedHistory = [...replyChain, ...chatHistory];
    const profileContext = await this.buildCurrentUserProfileContext(message);
    const imageInputs = [
      ...getMessageImageInputs(message, 'current message'),
      ...(toolCtx.referencedMessage
        ? getMessageImageInputs(toolCtx.referencedMessage, 'replied message')
        : []),
    ];

    botLogger.debug(
      {
        replyChainLength: replyChain.length,
        historyCount: chatHistory.length,
        imageInputCount: imageInputs.length,
      },
      'Fetched message context',
    );

    session.setReplyTarget(message);

    const formattedMessage = formatMessageForAI(message);
    const userMessage = userMessagePrefix
      ? `${userMessagePrefix}\n\n${formattedMessage}`
      : formattedMessage;

    return runWithToolContext(toolCtx, () =>
      chatService.chat({
        userMessage,
        username,
        channelId: message.channel.id,
        channel: textChannel,
        configScope: userConfigScope(
          message.guild?.id ?? null,
          message.author.id,
        ),
        userId: message.author.id,
        session,
        surface: 'discord',
        identity,
        chatHistory: combinedHistory,
        imageInputs,
        profileContext,
        messageId: message.id,
        signal,
        persistUserMessage,
      }));
  }

  private async buildCurrentUserProfileContext(
    message: Message,
  ): Promise<string> {
    try {
      if (!message.guild) {
        const profile = await buildDiscordUserProfile(message.author);
        return formatProfileContext(profile);
      }

      const member = await message.guild.members.fetch(message.author.id);
      const profile = await buildDiscordProfile(member);
      return formatProfileContext(profile);
    } catch (error) {
      botLogger.debug(
        {
          error: (error as Error).message,
          channelId: message.channel.id,
          userId: message.author.id,
        },
        'Could not build current user profile context',
      );
      return '';
    }
  }

  private createChatTurnTimeoutError(): Error {
    const timeoutSeconds = Math.round(CHAT_TURN_TIMEOUT_MS / 1000);
    const error = new Error(
      `Chat turn timed out after ${timeoutSeconds} seconds`,
    );
    error.name = 'ChatTurnTimeoutError';
    return error;
  }

  private createChatTurnSupersededError(): Error {
    const error = new Error(
      'Chat turn was superseded by a newer direct request',
    );
    error.name = 'ChatTurnSupersededError';
    return error;
  }

  private createChatTurnSourceDeletedError(): Error {
    const error = new Error('Chat turn source message was deleted');
    error.name = 'ChatTurnSourceDeletedError';
    return error;
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) { return; }
    const reason: unknown = signal.reason;
    if (reason instanceof Error) { throw reason; }
    throw this.createChatTurnTimeoutError();
  }

  private getAbortError(signal: AbortSignal): Error {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) { return reason; }
    return new Error('Chat turn was aborted');
  }

  private abortActiveChatTurn(channelId: string, nextMessageId: string): void {
    const activeTurn = getActiveChatTurn(channelId);
    if (!activeTurn || activeTurn.controller.signal.aborted) { return; }

    activeTurn.controller.abort(this.createChatTurnSupersededError());
    botLogger.warn(
      { channelId, nextMessageId },
      'Aborted previous chat turn for newer direct request',
    );
  }

  private abortActiveChatTurnIfMessagesDeleted(
    channelId: string,
    messageIds: string[],
  ): void {
    const activeTurn = getActiveChatTurn(channelId);
    if (!activeTurn || activeTurn.controller.signal.aborted) { return; }

    const deletedIds = new Set(messageIds);
    const sourceDeleted = deletedIds.has(activeTurn.messageId);
    const referenceDeleted = activeTurn.referencedMessageId
      ? deletedIds.has(activeTurn.referencedMessageId)
      : false;
    if (!sourceDeleted && !referenceDeleted) { return; }

    activeTurn.controller.abort(this.createChatTurnSourceDeletedError());
    botLogger.warn(
      {
        channelId,
        messageIds,
        activeMessageId: activeTurn.messageId,
        referencedMessageId: activeTurn.referencedMessageId,
        sourceDeleted,
        referenceDeleted,
      },
      'Aborted active chat turn because its Discord context was deleted',
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
      if (timeout) { clearTimeout(timeout); }
    }
  }

  private async deleteStatusEmbedSafely(
    session: ChatSession,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.withOperationTimeout(
      session.deleteStatusEmbed(),
      'Tool embed delete',
      context,
    );
  }

  private async deletePermissionPromptsSafely(
    turnId: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.withOperationTimeout(
      permissionManager.deletePromptMessages(turnId),
      'Permission prompt cleanup',
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
      'Error reply send',
      context,
    );
  }

  private getAbortPromise(signal: AbortSignal): Promise<never> {
    if (signal.aborted) { return Promise.reject(this.getAbortError(signal)); }

    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
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
          'Chat turn watchdog timed out',
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
      if (timeout) { clearTimeout(timeout); }
    }
  }

  private async runEditedReplyWithWatchdog(
    message: Message,
    existingReplyIds: string[],
    abortController: AbortController,
    context: Record<string, unknown>,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const signal = abortController.signal;
    const presenceSession = Symbol(`edit:${message.id}`);
    setActivePresenceSession(presenceSession);
    this.schedulePresenceReset(presenceSession, context);
    const session = new ChatSession(message.channel, (state) => {
      if (getActivePresenceSession() !== presenceSession) { return; }
      this.setSessionPresence(message.author.displayName, state);
    });
    session.onThinking();

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = this.createChatTurnTimeoutError();
        abortController.abort(error);
        botLogger.warn(
          { ...context, timeoutMs: CHAT_TURN_TIMEOUT_MS },
          'Edited message regeneration timed out',
        );
        reject(error);
      }, CHAT_TURN_TIMEOUT_MS);
    });

    try {
      const operation = this.regenerateEditedReply(
        message,
        existingReplyIds,
        session,
        signal,
      );
      await Promise.race([
        operation,
        timeoutPromise,
        this.getAbortPromise(signal),
      ]);
    } finally {
      if (timeout) { clearTimeout(timeout); }
      session.cleanup();
      this.resetPresenceSession(presenceSession);
      this.clearPresenceResetTimer(presenceSession);
      await this.deleteStatusEmbedSafely(session, context);
      await this.deletePermissionPromptsSafely(message.id, context);
    }
  }

  private async regenerateEditedReply(
    message: Message,
    existingReplyIds: string[],
    session: ChatSession,
    signal: AbortSignal,
  ): Promise<void> {
    const toolCtx = this.buildToolContext(
      message,
      await fetchReferencedMessage(message),
    );
    const reply = await this.generateChatReply(
      message,
      session,
      toolCtx,
      signal,
      EDIT_REGENERATION_PREFIX,
      false,
    );
    this.throwIfAborted(signal);
    await session.deleteStatusEmbed();
    this.throwIfAborted(signal);

    if (!reply) {
      botLogger.warn(
        {
          user: message.author.username,
          channelId: message.channel.id,
          messageId: message.id,
        },
        'Edited message regeneration returned empty reply',
      );
      return;
    }

    const editedChunks = await editReplyChunks(
      message,
      existingReplyIds,
      reply,
      message.author.username,
    );
    await sessionManager.recordAssistantMessages(
      message.channel.id,
      message.id,
      editedChunks.map(chunk => chunk.id),
    );
  }

  private async resolveUpdatedUserMessage(
    message: Message | PartialMessage,
  ): Promise<Message | null> {
    try {
      const resolved = message.partial ? await message.fetch() : message;
      if (resolved.author.bot) { return null; }
      return resolved;
    } catch (error) {
      botLogger.debug(
        {
          error: (error as Error).message,
          channelId: message.channelId,
          messageId: message.id,
        },
        'Could not fetch updated Discord message',
      );
      return null;
    }
  }

  private async editExistingReplyWithNotice(
    message: Message,
    existingReplyIds: string[],
  ): Promise<void> {
    const editedChunks = await editReplyChunks(
      message,
      existingReplyIds,
      SIDE_EFFECT_EDIT_NOTICE,
      message.author.username,
    );
    if (editedChunks.length > 0) {
      await sessionManager.recordAssistantMessages(
        message.channel.id,
        message.id,
        editedChunks.map(chunk => chunk.id),
      );
    }
  }

  private async handleMessageUpdate(
    _oldMessage: Message | PartialMessage,
    newMessage: Message | PartialMessage,
  ): Promise<void> {
    const message = await this.resolveUpdatedUserMessage(newMessage);
    if (!message) { return; }

    const formattedMessage = formatMessageForAI(message);
    const update = await conversationContext.updateMessageContent(
      message.channel.id,
      message.id,
      message.author.username,
      formattedMessage,
    );
    if (!update.found || !update.changed || !update.oldContent) { return; }

    const existingReplyIds
      = await sessionManager.getAssistantReplyIdsForUserMessage(
        message.channel.id,
        message.id,
      );
    const sessionInvalidated
      = await sessionManager.invalidateIfUserMessageEdited(
        message.channel.id,
        message.id,
      );
    const assessment = await editClassifier.classifyEdit(
      update.oldContent,
      update.newContent,
    );

    botLogger.info(
      {
        user: message.author.username,
        channelId: message.channel.id,
        messageId: message.id,
        foundReply: existingReplyIds.length > 0,
        sessionInvalidated,
        ...assessment,
      },
      'Processed edited Discord message',
    );

    if (!assessment.meaningful || existingReplyIds.length === 0) { return; }

    this.abortActiveChatTurn(message.channel.id, message.id);

    const context = {
      user: message.author.username,
      channelId: message.channel.id,
      messageId: message.id,
      reason: assessment.reason,
    };

    if (!assessment.shouldRegenerate) {
      await this.editExistingReplyWithNotice(message, existingReplyIds);
      return;
    }

    const abortController = new AbortController();
    setActiveChatTurn(message.channel.id, {
      controller: abortController,
      messageId: message.id,
      referencedMessageId: null,
    });
    try {
      await this.runEditedReplyWithWatchdog(
        message,
        existingReplyIds,
        abortController,
        context,
      );
    } catch (error) {
      botLogger.error(
        {
          ...context,
          error: (error as Error).message,
          stack: (error as Error).stack,
          name: (error as Error).name,
        },
        'Failed to regenerate reply after message edit',
      );
    } finally {
      if (
        getActiveChatTurn(message.channel.id)?.controller === abortController
      ) {
        deleteActiveChatTurn(message.channel.id);
      }
    }
  }

  private async handleAIChat(message: Message): Promise<void> {
    const referencedMessage
      = (await this.withOperationTimeout(
        fetchReferencedMessage(message),
        'Referenced message fetch',
        {
          user: message.author.username,
          channelId: message.channel.id,
          messageId: message.id,
        },
      )) ?? null;
    const gate = this.computeResponseGate(message, referencedMessage);
    if (!(await this.shouldBotRespond(message, gate))) { return; }
    if (this.isDirectResponseGate(gate)) {
      this.abortActiveChatTurn(message.channel.id, message.id);
    }

    const displayName = message.author.displayName;
    const presenceSession = Symbol(message.id);
    const abortController = new AbortController();
    setActiveChatTurn(message.channel.id, {
      controller: abortController,
      messageId: message.id,
      referencedMessageId: referencedMessage?.id ?? null,
    });
    setActivePresenceSession(presenceSession);
    this.schedulePresenceReset(presenceSession, {
      user: message.author.username,
      channelId: message.channel.id,
      messageId: message.id,
    });
    const session = new ChatSession(message.channel, (state) => {
      if (getActivePresenceSession() !== presenceSession) { return; }
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
      const isSuperseded = err?.name === 'ChatTurnSupersededError';
      const isSourceDeleted = err?.name === 'ChatTurnSourceDeletedError';
      const isSilentAbort = isSuperseded || isSourceDeleted;
      const logPayload = {
        status: err?.status ?? err?.code,
        name: err?.name,
        error: err?.error?.message ?? err?.message,
        stack: err?.stack,
        user: message.author.username,
        channelId: message.channel.id,
        messageId: message.id,
      };

      if (isSilentAbort) {
        botLogger.warn(
          logPayload,
          'Chat turn stopped without user-facing error',
        );
      } else {
        botLogger.error(logPayload, 'Failed to generate reply');
      }

      await this.deleteStatusEmbedSafely(session, logPayload);
      if (!isSilentAbort) {
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
      if (
        getActiveChatTurn(message.channel.id)?.controller === abortController
      ) {
        deleteActiveChatTurn(message.channel.id);
      }
    }
  }

  private readonly dispatchMessage = async (
    message: Message,
  ): Promise<void> => {
    try {
      if (message.author.bot) { return; }
      awayMessageService.recordUserActivity(message);
      if (await handleCommands(message)) { return; }
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
        'Message dispatch failed',
      );
    }
  };

  // ---- Slash command registration -----------------------------------------

  private async registerSlashCommands() {
    const rest = new REST().setToken(env.DISCORD_TOKEN);
    try {
      const commands = slashCommands.map(cmd => cmd.toJSON());
      await rest.put(Routes.applicationCommands(this.client.user!.id), {
        body: commands,
      });
      botLogger.info({ count: commands.length }, 'Registered slash commands');
    } catch (error) {
      botLogger.error({ error }, 'Failed to register slash commands');
    }
  }

  private readonly dispatchInteraction = async (
    interaction: Interaction,
  ): Promise<void> => {
    if (interaction.isAutocomplete()) {
      await handleReminderAutocomplete(interaction);
    } else if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (
      interaction.isStringSelectMenu()
      && isSearchProviderSelect(interaction.customId)
    ) {
      await handleSearchProviderSelect(interaction);
    } else if (
      interaction.isStringSelectMenu()
      && isModelSelect(interaction.customId)
    ) {
      await handleModelSelect(interaction);
    } else if (
      interaction.isStringSelectMenu()
      && interaction.customId === 'smithery_select_server'
    ) {
      await handleSmitherySelect(interaction);
    } else if (
      interaction.isStringSelectMenu()
      && interaction.customId === 'smithery_unlink_server'
    ) {
      await handleSmitheryUnlinkSelect(interaction);
    } else if (
      interaction.isButton()
      && interaction.customId.startsWith('smithery_check:')
    ) {
      await handleSmitheryCheckButton(interaction);
    } else if (
      interaction.isButton()
      && isMemoriesButton(interaction.customId)
    ) {
      await handleMemoriesButton(interaction);
    } else if (
      interaction.isModalSubmit()
      && isMemoriesModal(interaction.customId)
    ) {
      await handleMemoriesModal(interaction);
    }
  };

  registerEvents() {
    this.client.once(Events.ClientReady, async (readyClient) => {
      botLogger.info({ tag: readyClient.user.tag }, 'Bot logged in');
      this.setDefaultPresence();
      await this.registerSlashCommands();
      messageSyncService.start(this.client);
      reminderService.start(this.client);
    });

    this.client.on(Events.InteractionCreate, this.dispatchInteraction);

    this.client.on(Events.MessageCreate, (message) => {
      void this.dispatchMessage(message);
    });

    this.client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
      void this.handleMessageUpdate(oldMessage, newMessage);
    });

    this.client.on(Events.MessageDelete, async (message) => {
      if (message.id && message.channelId) {
        this.abortActiveChatTurnIfMessagesDeleted(message.channelId, [
          message.id,
        ]);
        await messageSyncService.deleteMessage(message.channelId, message.id);
      }
    });

    this.client.on(Events.MessageBulkDelete, async (messages, channel) => {
      const messageIds = [...messages.keys()];
      if (messageIds.length === 0) { return; }

      this.abortActiveChatTurnIfMessagesDeleted(channel.id, messageIds);
      await messageSyncService.deleteMessages(channel.id, messageIds);
    });
  }

  start() {
    botLogger.info('Starting bot...');
    return this.client.login(env.DISCORD_TOKEN);
  }
}

export const ruyiBot = new RuyiBot();
