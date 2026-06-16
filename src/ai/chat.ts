import {
  Agent,
  user,
  type AgentInputItem,
  type RunToolApprovalItem,
  type Tool,
  type ModelSettings,
} from "@openai/agents";
import type { TextBasedChannel } from "discord.js";
import type { ConfigScope } from "../config";
import { z } from "zod";
import { allTools, externalToolNames } from "../tools";
import { aiLogger } from "../logger";
import { env } from "../env";
import {
  AGENT_MAX_TURNS,
  CHAT_TIMEOUT_MS,
  MAX_AGENT_IMAGE_INPUTS,
} from "../constants";
import type { ChatSession } from "../utils/chat-session";
import type { MessageImageInput } from "../utils/messages";
import { systemPrompt } from "./prompt";
import { sessionManager } from "./session";
import { agentsRuntimeManager } from "./client";
import { conversationContext, type ChatMessage } from "./context";
import {
  getApprovalToolName,
  permissionManager,
  type PermissionResult,
} from "./permissions";
import { autoExtractFacts } from "./extraction";

const LOCAL_TOOL_NAMES = new Set(allTools.map((tool) => tool.name));
const ToolCallSchema = z.looseObject({
  arguments: z.unknown().optional(),
});

interface ChatOptions {
  userMessage: string;
  username: string;
  channelId: string;
  channel: TextBasedChannel;
  configScope?: ConfigScope | null;
  userId: string;
  session: ChatSession;
  chatHistory?: ChatMessage[];
  imageInputs?: MessageImageInput[];
  profileContext?: string;
  messageId: string;
  signal?: AbortSignal;
  persistUserMessage?: boolean;
}

interface TextStreamResult {
  completed: Promise<void>;
  error: unknown;
  toTextStream(options: {
    compatibleWithNodeStreams: true;
  }): AsyncIterable<unknown>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch (error) {
      aiLogger.debug(
        { error: (error as Error).message },
        "Tool arguments were not JSON",
      );
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

function getLifecycleToolArgs(toolCall: unknown): Record<string, unknown> {
  const parsed = ToolCallSchema.safeParse(toolCall);
  return parseArguments(parsed.success ? parsed.data.arguments : undefined);
}

function formatToolDisplayName(toolName: string, isLocal: boolean): string {
  if (isLocal) return toolName;
  return `mcp:${toolName}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error("Chat request was aborted");
}

function uniqueImageInputs(
  imageInputs: MessageImageInput[],
): MessageImageInput[] {
  const seen = new Set<string>();
  const unique: MessageImageInput[] = [];

  for (const imageInput of imageInputs) {
    const dedupeKey = getImageDedupeKey(imageInput.url);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push(imageInput);
    if (unique.length >= MAX_AGENT_IMAGE_INPUTS) break;
  }

  return unique;
}

function getImageDedupeKey(imageUrl: string): string {
  try {
    const url = new URL(imageUrl);
    if (
      url.hostname === "cdn.discordapp.com" ||
      url.hostname === "media.discordapp.net"
    ) {
      return `${url.origin}${url.pathname}`;
    }
  } catch (error) {
    aiLogger.debug(
      { error: (error as Error).message, imageUrl },
      "Could not parse image URL for dedupe",
    );
  }

  return imageUrl;
}

function formatImageInputSummary(imageInputs: MessageImageInput[]): string {
  const uniqueInputs = uniqueImageInputs(imageInputs);
  if (uniqueInputs.length === 0) return "";

  const omittedCount = imageInputs.length - uniqueInputs.length;
  const capNote =
    omittedCount > 0
      ? `\nOnly the first ${uniqueInputs.length} unique image inputs were attached natively; ${omittedCount} duplicate or over-limit image input(s) were omitted.`
      : "";

  return `\n\nNative image inputs attached for vision:${capNote}\n${uniqueInputs
    .map((imageInput, index) => `${index + 1}. ${imageInput.source}`)
    .join("\n")}`;
}

function buildRunnerInput(
  enrichedMessage: string,
  imageInputs: MessageImageInput[],
): string | AgentInputItem[] {
  const images = uniqueImageInputs(imageInputs);
  if (images.length === 0) return enrichedMessage;

  const content: Exclude<Parameters<typeof user>[0], string> = [
    { type: "input_text", text: enrichedMessage },
    ...images.map((imageInput) => ({
      type: "input_image" as const,
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

class ChatService {
  async chat(options: ChatOptions): Promise<string | null> {
    const {
      userMessage,
      username,
      channelId,
      channel,
      configScope = null,
      userId,
      session,
      chatHistory = [],
      imageInputs = [],
      profileContext = "",
      messageId,
      signal,
      persistUserMessage = true,
    } = options;

    if (channel.isSendable()) {
      permissionManager.setContext(channelId, {
        channel,
        promptController: session.getPermissionPromptController(),
        turnId: messageId,
        userId,
      });
    }

    const abortController = new AbortController();
    const abortFromParent = (): void => {
      const reason: unknown = signal?.reason;
      if (reason instanceof Error) {
        abortController.abort(reason);
      } else {
        abortController.abort();
      }
    };

    if (signal?.aborted) {
      abortFromParent();
    } else {
      signal?.addEventListener("abort", abortFromParent, { once: true });
    }

    const timeout = setTimeout(() => abortController.abort(), CHAT_TIMEOUT_MS);
    session.onThinking();

    try {
      throwIfAborted(signal);

      const dynamicContext = await conversationContext.buildDynamicContext(
        username,
        userId,
        channelId,
        chatHistory,
        configScope,
      );
      throwIfAborted(signal);

      const uniqueImageInputCount = uniqueImageInputs(imageInputs).length;
      const imageInputSummary = formatImageInputSummary(imageInputs);
      const profileBlock = profileContext ? `\n\n${profileContext}` : "";
      const enrichedMessage = `${dynamicContext}${profileBlock}\n\nUser message from ${username}:\n${userMessage}${imageInputSummary}`;
      const runnerInput = buildRunnerInput(enrichedMessage, imageInputs);

      if (env.DEBUG_PROMPTS) {
        aiLogger.debug({ systemPrompt }, "system prompt (debug dump)");
        aiLogger.debug(
          { enrichedMessage },
          "enriched user message (debug dump)",
        );
      }

      aiLogger.info(
        {
          username,
          contextLength: dynamicContext.length,
          profileContextLength: profileContext.length,
          historyCount: chatHistory.length,
          imageInputCount: imageInputs.length,
          uniqueImageInputCount,
          maxImageInputs: MAX_AGENT_IMAGE_INPUTS,
          userMessagePreview: userMessage.slice(0, 80),
        },
        "Chat input received",
      );

      if (persistUserMessage) {
        await conversationContext.rememberMessage(
          channelId,
          username,
          userMessage,
          false,
          messageId,
        );

        const { shouldExtract } = conversationContext.trackUserMessage(
          channelId,
          userId,
        );
        if (shouldExtract) {
          void autoExtractFacts(username, userId, channelId, configScope)
            .then((completed) => {
              if (completed) {
                conversationContext.markExtracted(channelId, userId);
              }
            })
            .catch((error: unknown) =>
              aiLogger.warn(
                { error: (error as Error).message, username, channelId },
                "Background fact extraction crashed",
              ),
            );
        }
      }

      const model = agentsRuntimeManager.getModel(configScope);
      const modelSettings = agentsRuntimeManager.getModelSettings(configScope);
      const agentSession = await sessionManager.getOrCreate(
        channelId,
        messageId,
        model,
        modelSettings,
      );
      throwIfAborted(signal);

      const agentSessionId = await agentSession.getSessionId();
      const toolUsage = createTurnToolUsage();
      const agent = this.createAgent(session, toolUsage, model, modelSettings);
      const runner = agentsRuntimeManager.getRunner();
      const runOptions = {
        stream: true,
        session: agentSession,
        maxTurns: AGENT_MAX_TURNS,
        signal: abortController.signal,
        toolExecution: { maxFunctionToolConcurrency: 1 },
      } as const;

      aiLogger.debug(
        {
          channelId,
          sessionId: agentSessionId,
          localToolCount: allTools.length,
          maxTurns: AGENT_MAX_TURNS,
        },
        "Using persistent OpenAI Agents session",
      );

      let stream = await runner.run(agent, runnerInput, runOptions);
      await this.drainStream(stream, session);

      let approvalCycles = 0;
      while (stream.interruptions.length > 0) {
        approvalCycles += 1;
        if (approvalCycles > 5) {
          throw new Error("Too many tool approval cycles in one chat turn");
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
      const finalContent =
        typeof finalOutput === "string" && finalOutput.length > 0
          ? finalOutput
          : null;

      aiLogger.info(
        {
          responseLength: finalContent?.length ?? 0,
          preview: finalContent?.slice(0, 200) ?? null,
          localToolCallCount: toolUsage.localToolCallCount,
          externalToolCallCount: toolUsage.externalToolCallCount,
        },
        "Chat response generated",
      );

      session.onComplete();

      if (!finalContent) {
        aiLogger.warn(
          { username, channelId },
          "Chat request returned empty response from model",
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
          channelId,
        },
        "Chat request failed",
      );

      await sessionManager.invalidate(channelId);
      session.onError();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
      permissionManager.clearContext(channelId);
    }
  }

  private createAgent(
    session: ChatSession,
    toolUsage: TurnToolUsage,
    model: string,
    modelSettings: ModelSettings,
  ) {
    const agent = new Agent({
      name: "Ruyi",
      instructions: systemPrompt,
      model,
      modelSettings,
      tools: [...allTools],
      toolUseBehavior: "run_llm_again",
    });

    agent.on("agent_tool_start", (_context, tool, details) => {
      this.handleToolStart(tool, details.toolCall, session, toolUsage);
    });
    agent.on("agent_tool_end", (_context, tool) => {
      this.handleToolEnd(tool, session);
    });

    return agent;
  }

  private async drainStream(
    stream: TextStreamResult,
    session: ChatSession,
  ): Promise<void> {
    const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });
    for await (const chunk of textStream) {
      const delta = typeof chunk === "string" ? chunk : String(chunk);
      session.onTextGenerationStart(delta);
    }

    session.onTextGenerationEnd();
    await stream.completed;
    if (stream.error) throw stream.error;
  }

  private getToolDisplayName(toolName: string): {
    displayName: string;
    isLocalTool: boolean;
  } {
    const isLocalTool = LOCAL_TOOL_NAMES.has(toolName);
    const displayName = formatToolDisplayName(toolName, isLocalTool);
    return { displayName, isLocalTool };
  }

  private handleToolStart(
    tool: Tool,
    toolCall: unknown,
    session: ChatSession,
    toolUsage: TurnToolUsage,
  ): void {
    const { displayName, isLocalTool } = this.getToolDisplayName(tool.name);
    if (externalToolNames.has(tool.name)) {
      toolUsage.externalToolCallCount += 1;
    } else if (isLocalTool) {
      toolUsage.localToolCallCount += 1;
    } else {
      toolUsage.externalToolCallCount += 1;
    }
    aiLogger.info(
      { tool: tool.name, external: externalToolNames.has(tool.name) },
      "Tool execution starting",
    );
    session.onToolStart(displayName, getLifecycleToolArgs(toolCall));
  }

  private handleToolEnd(tool: Tool, session: ChatSession): void {
    const { displayName } = this.getToolDisplayName(tool.name);
    aiLogger.debug({ tool: displayName }, "Tool execution complete");
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
      const decision =
        rememberedDecisions.get(toolName) ??
        (await permissionManager.requestToolApproval(
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
      message: "The Discord user denied approval for this tool call.",
    });
  }
}

export const chatService = new ChatService();
