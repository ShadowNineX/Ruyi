import type { AgentInputItem, ModelSettings, RunToolApprovalItem, Tool } from '@openai/agents';
import type { TextBasedChannel } from 'discord.js';
import type { ConfigScope } from '../config';
import type { MessageImageInput } from '../discord/utils/messages';
import type { RuyiUserIdentity } from '../utils/user-identity';
import type { ChatRuntimeSession } from './chat-runtime-session';
import type { ChatMessage, ConversationSurface } from './context';
import type { PermissionResult } from './permissions';
import type { AssistantPersonality } from './prompt';
import {
  Agent,

  user,
} from '@openai/agents';
import { z } from 'zod';
import {
  AGENT_MAX_TURNS,
  CHAT_TIMEOUT_MS,
  MAX_AGENT_IMAGE_INPUTS,
} from '../constants';
import { env } from '../env';
import { aiLogger } from '../logger';
import {
  getToolNamesForSurface,
  getToolsForSurface,
  isExternalToolName,
} from '../tools';
import { getApprovalToolName } from '../utils/permission-summary';
import { parseToolArguments } from '../utils/tool-arguments';
import {
  buildDiscordUserIdentity,

} from '../utils/user-identity';
import { agentsRuntimeManager } from './client';
import {

  conversationContext,

} from './context';
import { autoExtractFacts } from './extraction';
import { permissionManager } from './permissions';
import {
  buildSystemPrompt,
  getSystemPromptVersion,
} from './prompt';
import { sessionManager } from './session';

const ToolCallSchema = z.looseObject({
  arguments: z.unknown().optional(),
});

interface ChatOptions {
  userMessage: string;
  username: string;
  channelId: string;
  channel?: TextBasedChannel | null;
  configScope?: ConfigScope | null;
  userId: string;
  session: ChatRuntimeSession;
  chatHistory?: ChatMessage[];
  imageInputs?: MessageImageInput[];
  profileContext?: string;
  messageId: string;
  surface?: ConversationSurface;
  identity?: RuyiUserIdentity | null;
  surfaceLabel?: string;
  signal?: AbortSignal;
  persistUserMessage?: boolean;
  messageTimestamp?: Date;
  personality?: AssistantPersonality;
  sessionLabel?: string;
}

interface TextStreamResult {
  completed: Promise<void>;
  error: unknown;
  toTextStream: (options: {
    compatibleWithNodeStreams: true;
  }) => AsyncIterable<unknown>;
}

interface ApprovalState {
  approve: (
    item: RunToolApprovalItem,
    options?: { alwaysApprove?: boolean },
  ) => void;
  reject: (
    item: RunToolApprovalItem,
    options?: { alwaysReject?: boolean; message?: string },
  ) => void;
}

interface TurnToolUsage {
  localToolCallCount: number;
  externalToolCallCount: number;
}

interface ChatAbortState {
  abortController: AbortController;
  cleanup: () => void;
}

interface PersistIncomingUserMessageOptions {
  cacheIdentity: RuyiUserIdentity;
  conversationId: string;
  messageId: string;
  messageTimestamp?: Date;
  persistUserMessage: boolean;
  surface: ConversationSurface;
  steamAccountId: string | null;
  userMessage: string;
  username: string;
}

function getLifecycleToolArgs(toolCall: unknown): Record<string, unknown> {
  const parsed = ToolCallSchema.safeParse(toolCall);
  return parseToolArguments(parsed.success ? parsed.data.arguments : undefined);
}

function formatToolDisplayName(toolName: string, isLocal: boolean): string {
  if (isLocal) { return toolName; }
  return `mcp:${toolName}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) { return; }
  const reason: unknown = signal.reason;
  if (reason instanceof Error) { throw reason; }
  throw new Error('Chat request was aborted');
}

function uniqueImageInputs(
  imageInputs: MessageImageInput[],
): MessageImageInput[] {
  const seen = new Set<string>();
  const unique: MessageImageInput[] = [];

  for (const imageInput of imageInputs) {
    const dedupeKey = getImageDedupeKey(imageInput.url);
    if (seen.has(dedupeKey)) { continue; }
    seen.add(dedupeKey);
    unique.push(imageInput);
    if (unique.length >= MAX_AGENT_IMAGE_INPUTS) { break; }
  }

  return unique;
}

function getImageDedupeKey(imageUrl: string): string {
  try {
    const url = new URL(imageUrl);
    if (
      url.hostname === 'cdn.discordapp.com'
      || url.hostname === 'media.discordapp.net'
    ) {
      return `${url.origin}${url.pathname}`;
    }
  } catch (error) {
    aiLogger.debug(
      { error: (error as Error).message, imageUrl },
      'Could not parse image URL for dedupe',
    );
  }

  return imageUrl;
}

function formatImageInputSummary(imageInputs: MessageImageInput[]): string {
  const uniqueInputs = uniqueImageInputs(imageInputs);
  if (uniqueInputs.length === 0) { return ''; }

  const omittedCount = imageInputs.length - uniqueInputs.length;
  const capNote
    = omittedCount > 0
      ? `\nOnly the first ${uniqueInputs.length} unique image inputs were attached natively; ${omittedCount} duplicate or over-limit image input(s) were omitted.`
      : '';

  return `\n\nNative image inputs attached for vision:${capNote}\n${uniqueInputs
    .map((imageInput, index) => `${index + 1}. ${imageInput.source}`)
    .join('\n')}`;
}

function buildRunnerInput(
  enrichedMessage: string,
  imageInputs: MessageImageInput[],
): string | AgentInputItem[] {
  const images = uniqueImageInputs(imageInputs);
  if (images.length === 0) { return enrichedMessage; }

  const content: Exclude<Parameters<typeof user>[0], string> = [
    { type: 'input_text', text: enrichedMessage },
    ...images.map(imageInput => ({
      type: 'input_image' as const,
      image: imageInput.url,
      detail: imageInput.detail,
    })),
  ];

  return [user(content)];
}

function createTurnToolUsage(): TurnToolUsage {
  return {
    localToolCallCount: 0,
    externalToolCallCount: 0,
  };
}

function createChatAbortState(signal: AbortSignal | undefined): ChatAbortState {
  const abortController = new AbortController();
  const abortFromParent = (): void => {
    const reason: unknown = signal?.reason;
    if (reason instanceof Error) {
      abortController.abort(reason);
      return;
    }

    abortController.abort();
  };

  if (signal?.aborted) {
    abortFromParent();
  } else {
    signal?.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    abortController,
    cleanup: () => signal?.removeEventListener('abort', abortFromParent),
  };
}

class ChatService {
  async chat(options: ChatOptions): Promise<string | null> {
    const {
      userMessage,
      username,
      channelId,
      channel = null,
      configScope = null,
      userId,
      session,
      chatHistory = [],
      imageInputs = [],
      profileContext = '',
      messageId,
      surface = 'discord',
      identity = buildDiscordUserIdentity(userId, username),
      surfaceLabel,
      signal,
      persistUserMessage = true,
      personality = 'ruyi',
      sessionLabel = personality,
    } = options;
    const conversationId = channelId;
    const cacheIdentity = identity ?? buildDiscordUserIdentity(userId, username);

    this.bindPermissionContext({
      channel,
      channelId,
      messageId,
      session,
      surface,
      userId,
    });

    const abortState = createChatAbortState(signal);
    const timeout = setTimeout(
      () => abortState.abortController.abort(),
      CHAT_TIMEOUT_MS,
    );
    session.onThinking();

    try {
      throwIfAborted(signal);

      const dynamicContext = await conversationContext.buildDynamicContext(
        username,
        userId,
        conversationId,
        chatHistory,
        configScope,
        {
          surface,
          identity: cacheIdentity,
          surfaceLabel,
          steamAccountId: surface === 'steam' ? sessionLabel : null,
          personality,
        },
      );
      throwIfAborted(signal);

      const uniqueImageInputCount = uniqueImageInputs(imageInputs).length;
      const imageInputSummary = formatImageInputSummary(imageInputs);
      const profileBlock = profileContext ? `\n\n${profileContext}` : '';
      const enrichedMessage = `${dynamicContext}${profileBlock}\n\nUser message from ${username}:\n${userMessage}${imageInputSummary}`;
      const runnerInput = buildRunnerInput(enrichedMessage, imageInputs);

      this.debugPromptIfEnabled(enrichedMessage, personality);

      const promptVersion = getSystemPromptVersion(personality);

      aiLogger.info(
        {
          username,
          personality,
          promptVersion,
          contextLength: dynamicContext.length,
          profileContextLength: profileContext.length,
          historyCount: chatHistory.length,
          imageInputCount: imageInputs.length,
          uniqueImageInputCount,
          maxImageInputs: MAX_AGENT_IMAGE_INPUTS,
          userMessagePreview: userMessage.slice(0, 80),
        },
        'Chat input received',
      );

      await this.persistIncomingUserMessage({
        cacheIdentity,
        conversationId,
        messageId,
        messageTimestamp: options.messageTimestamp,
        persistUserMessage,
        steamAccountId: surface === 'steam' ? sessionLabel : null,
        surface,
        userMessage,
        username,
      });

      const model = agentsRuntimeManager.getModel(configScope);
      const modelSettings = agentsRuntimeManager.getModelSettings(configScope);
      const agentSession = await sessionManager.getOrCreate(
        conversationId,
        messageId,
        model,
        modelSettings,
        surface,
        promptVersion,
        sessionLabel,
      );
      throwIfAborted(signal);

      const agentSessionId = await agentSession.getSessionId();
      const toolUsage = createTurnToolUsage();
      const agent = this.createAgent(
        session,
        toolUsage,
        model,
        modelSettings,
        surface,
        personality,
      );
      const runner = agentsRuntimeManager.getRunner();
      const runOptions = {
        stream: true,
        session: agentSession,
        maxTurns: AGENT_MAX_TURNS,
        signal: abortState.abortController.signal,
        toolExecution: { maxFunctionToolConcurrency: 1 },
      } as const;

      aiLogger.debug(
        {
          surface,
          conversationId,
          sessionId: agentSessionId,
          personality,
          promptVersion,
          localToolCount: getToolsForSurface(surface).length,
          maxTurns: AGENT_MAX_TURNS,
        },
        'Using persistent OpenAI Agents session',
      );

      let stream = await runner.run(agent, runnerInput, runOptions);
      await this.drainStream(stream, session);

      let approvalCycles = 0;
      while (stream.interruptions.length > 0) {
        approvalCycles += 1;
        if (approvalCycles > 5) {
          throw new Error('Too many tool approval cycles in one chat turn');
        }

        session.onApprovalPending();
        await this.resolveApprovals(
          channelId,
          agentSessionId,
          stream.interruptions,
          stream.state,
        );
        session.onThinking();

        stream = await runner.run(agent, stream.state, runOptions);
        await this.drainStream(stream, session);
      }

      const finalOutput = stream.finalOutput;
      const finalContent
        = typeof finalOutput === 'string' && finalOutput.length > 0
          ? finalOutput
          : null;

      aiLogger.info(
        {
          responseLength: finalContent?.length ?? 0,
          preview: finalContent?.slice(0, 200) ?? null,
          localToolCallCount: toolUsage.localToolCallCount,
          externalToolCallCount: toolUsage.externalToolCallCount,
        },
        'Chat response generated',
      );

      session.onComplete();

      if (!finalContent) {
        aiLogger.warn(
          { username, surface, conversationId },
          'Chat request returned empty response from model',
        );
      }

      return finalContent;
    } catch (error) {
      const err = error as Error & { status?: number; code?: number };
      aiLogger.error(
        {
          error: err.message,
          stack: err.stack,
          name: err.name,
          status: err.status ?? err.code,
          username,
          surface,
          conversationId,
        },
        'Chat request failed',
      );

      await sessionManager.invalidate(conversationId, surface, sessionLabel);
      session.onError();
      throw error;
    } finally {
      clearTimeout(timeout);
      abortState.cleanup();
      permissionManager.clearContext(channelId);
    }
  }

  private bindPermissionContext({
    channel,
    channelId,
    messageId,
    session,
    surface,
    userId,
  }: {
    channel: TextBasedChannel | null;
    channelId: string;
    messageId: string;
    session: ChatRuntimeSession;
    surface: ConversationSurface;
    userId: string;
  }): void {
    if (
      surface !== 'discord'
      || !channel?.isSendable()
      || !session.getPermissionPromptController
    ) {
      return;
    }

    permissionManager.setContext(channelId, {
      channel,
      promptController: session.getPermissionPromptController(),
      turnId: messageId,
      userId,
    });
  }

  private debugPromptIfEnabled(
    enrichedMessage: string,
    personality: AssistantPersonality,
  ): void {
    if (!env.DEBUG_PROMPTS) { return; }

    aiLogger.debug(
      { systemPrompt: buildSystemPrompt(personality), personality },
      'system prompt (debug dump)',
    );
    aiLogger.debug(
      { enrichedMessage },
      'enriched user message (debug dump)',
    );
  }

  private async persistIncomingUserMessage({
    cacheIdentity,
    conversationId,
    messageId,
    messageTimestamp,
    persistUserMessage,
    surface,
    steamAccountId,
    userMessage,
    username,
  }: PersistIncomingUserMessageOptions): Promise<void> {
    if (!persistUserMessage) { return; }

    await this.rememberIncomingUserMessage({
      cacheIdentity,
      conversationId,
      messageId,
      messageTimestamp,
      surface,
      steamAccountId,
      userMessage,
      username,
    });

    const { shouldExtract } = conversationContext.trackUserMessage(
      conversationId,
      cacheIdentity,
      surface,
      steamAccountId,
    );
    if (shouldExtract) {
      this.scheduleFactExtraction(
        username,
        cacheIdentity,
        conversationId,
        surface,
        steamAccountId,
      );
    }
  }

  private async rememberIncomingUserMessage({
    cacheIdentity,
    conversationId,
    messageId,
    messageTimestamp,
    surface,
    steamAccountId,
    userMessage,
    username,
  }: Omit<PersistIncomingUserMessageOptions, 'persistUserMessage'>): Promise<void> {
    if (surface === 'discord') {
      await conversationContext.rememberMessage(
        conversationId,
        username,
        userMessage,
        false,
        messageId,
      );
      return;
    }

    await conversationContext.rememberSteamMessage({
      accountId: this.requireSteamAccountId(steamAccountId),
      profileId: conversationId,
      authorSteamId: cacheIdentity.surfaceUserId,
      authorName: username,
      content: userMessage,
      isBot: false,
      commentId: messageId,
      timestamp: messageTimestamp,
    });
  }

  private requireSteamAccountId(steamAccountId: string | null): string {
    if (steamAccountId) { return steamAccountId; }
    throw new Error('Steam chat persistence requires an explicit account id');
  }

  private scheduleFactExtraction(
    username: string,
    cacheIdentity: RuyiUserIdentity,
    conversationId: string,
    surface: ConversationSurface,
    steamAccountId: string | null,
  ): void {
    void autoExtractFacts(
      username,
      cacheIdentity,
      conversationId,
      surface,
      steamAccountId,
    )
      .then((completed) => {
        if (completed) {
          conversationContext.markExtracted(
            conversationId,
            cacheIdentity,
            surface,
            steamAccountId,
          );
        }
      })
      .catch((error: unknown) =>
        aiLogger.warn(
          {
            error: (error as Error).message,
            username,
            surface,
            conversationId,
          },
          'Background fact extraction crashed',
        ),
      );
  }

  private createAgent(
    session: ChatRuntimeSession,
    toolUsage: TurnToolUsage,
    model: string,
    modelSettings: ModelSettings,
    surface: ConversationSurface,
    personality: AssistantPersonality,
  ) {
    const agent = new Agent({
      name: personality === 'tails' ? 'Tails' : 'Ruyi',
      instructions: buildSystemPrompt(personality),
      model,
      modelSettings,
      tools: [...getToolsForSurface(surface)],
      toolUseBehavior: 'run_llm_again',
    });

    agent.on('agent_tool_start', (_context, tool, details) => {
      this.handleToolStart(tool, details.toolCall, session, toolUsage, surface);
    });
    agent.on('agent_tool_end', (_context, tool) => {
      this.handleToolEnd(tool, session, surface);
    });

    return agent;
  }

  private async drainStream(
    stream: TextStreamResult,
    session: ChatRuntimeSession,
  ): Promise<void> {
    const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });
    const completion = stream.completed.then(
      () => null,
      (error: unknown) => error,
    );

    let textError: unknown = null;
    try {
      await this.consumeTextStream(textStream, session);
    } catch (error) {
      textError = error;
    }

    const completionError = await completion;
    if (textError) { throw textError; }
    if (completionError) { throw completionError; }
    if (stream.error) { throw stream.error; }
  }

  private async consumeTextStream(
    textStream: AsyncIterable<unknown>,
    session: ChatRuntimeSession,
  ): Promise<void> {
    try {
      for await (const chunk of textStream) {
        const delta = typeof chunk === 'string' ? chunk : String(chunk);
        session.onTextGenerationStart(delta);
      }
    } finally {
      session.onTextGenerationEnd();
    }
  }

  private getToolDisplayName(toolName: string, surface: ConversationSurface): {
    displayName: string;
    isLocalTool: boolean;
  } {
    const isLocalTool = getToolNamesForSurface(surface).has(toolName);
    const displayName = formatToolDisplayName(toolName, isLocalTool);
    return { displayName, isLocalTool };
  }

  private handleToolStart(
    tool: Tool,
    toolCall: unknown,
    session: ChatRuntimeSession,
    toolUsage: TurnToolUsage,
    surface: ConversationSurface,
  ): void {
    const { displayName, isLocalTool } = this.getToolDisplayName(tool.name, surface);
    if (isExternalToolName(tool.name, surface)) {
      toolUsage.externalToolCallCount += 1;
    } else if (isLocalTool) {
      toolUsage.localToolCallCount += 1;
    } else {
      toolUsage.externalToolCallCount += 1;
    }
    aiLogger.info(
      { tool: tool.name, external: isExternalToolName(tool.name, surface) },
      'Tool execution starting',
    );
    session.onToolStart(displayName, getLifecycleToolArgs(toolCall));
  }

  private handleToolEnd(
    tool: Tool,
    session: ChatRuntimeSession,
    surface: ConversationSurface,
  ): void {
    const { displayName } = this.getToolDisplayName(tool.name, surface);
    aiLogger.debug({ tool: displayName }, 'Tool execution complete');
    session.onToolEnd(displayName);
    session.onThinking();
  }

  private async resolveApprovals(
    channelId: string,
    sessionId: string,
    approvals: RunToolApprovalItem[],
    state: ApprovalState,
  ): Promise<void> {
    const rememberedDecisions = new Map<string, PermissionResult>();

    for (const approval of approvals) {
      const toolName = getApprovalToolName(approval);
      const decision
        = rememberedDecisions.get(toolName)
          ?? (await permissionManager.requestToolApproval(
            channelId,
            approval,
            sessionId,
          ));

      if (decision.rememberTool) {
        rememberedDecisions.set(toolName, decision);
      }

      this.applyApprovalDecision(approval, decision, state);
    }
  }

  private applyApprovalDecision(
    approval: RunToolApprovalItem,
    decision: PermissionResult,
    state: ApprovalState,
  ): void {
    if (decision.approved) {
      state.approve(approval, { alwaysApprove: decision.rememberTool });
      return;
    }

    state.reject(approval, {
      alwaysReject: decision.rememberTool,
      message: 'The Discord user denied approval for this tool call.',
    });
  }
}

export const chatService = new ChatService();
