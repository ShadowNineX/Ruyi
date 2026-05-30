import { Agent, type RunToolApprovalItem, type Tool } from "@openai/agents";
import type { GuildTextBasedChannel } from "discord.js";
import { allTools } from "../tools";
import { aiLogger } from "../logger";
import { mcpRegistry } from "../mcp";
import { mcpConnectionManager } from "../mcp/client";
import { env } from "../env";
import { CHAT_TIMEOUT_MS } from "../constants";
import type { ChatSession } from "../utils/chatSession";
import { systemPrompt } from "./prompt";
import { sessionManager } from "./session";
import { agentsRuntimeManager } from "./client";
import { conversationContext, type ChatMessage } from "./context";
import { permissionManager } from "./permissions";
import { autoExtractFacts } from "./extraction";

const LOCAL_TOOL_NAMES = new Set(allTools.map((tool) => tool.name));

export interface ChatOptions {
  userMessage: string;
  username: string;
  channelId: string;
  channel: GuildTextBasedChannel;
  userId: string;
  session: ChatSession;
  chatHistory?: ChatMessage[];
  messageId?: string;
}

interface StreamLike extends AsyncIterable<unknown> {
  completed: Promise<void>;
  error: unknown;
}

interface ApprovalState {
  approve: (item: RunToolApprovalItem) => void;
  reject: (item: RunToolApprovalItem, options?: { message?: string }) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed) ?? {};
    } catch (error) {
      aiLogger.debug(
        { error: (error as Error).message },
        "Tool arguments were not JSON",
      );
      return {};
    }
  }
  return asRecord(value) ?? {};
}

function getLifecycleToolArgs(toolCall: unknown): Record<string, unknown> {
  return parseArguments(asRecord(toolCall)?.arguments);
}

function formatToolDisplayName(
  toolName: string,
  isLocal: boolean,
  mcpServer: string | null | undefined,
): string {
  if (isLocal) return toolName;
  if (mcpServer) return `${mcpServer}:${toolName}`;
  return `mcp:${toolName}`;
}

export class ChatService {
  async chat(options: ChatOptions): Promise<string | null> {
    const {
      userMessage,
      username,
      channelId,
      channel,
      userId,
      session,
      chatHistory = [],
      messageId,
    } = options;

    permissionManager.setContext(channelId, { channel, userId });

    const dynamicContext = await conversationContext.buildDynamicContext(
      username,
      channelId,
      chatHistory,
    );

    const enrichedMessage = `${dynamicContext}\n\nUser message from ${username}:\n${userMessage}`;

    if (env.DEBUG_PROMPTS) {
      aiLogger.debug({ systemPrompt }, "system prompt (debug dump)");
      aiLogger.debug({ enrichedMessage }, "enriched user message (debug dump)");
    }

    aiLogger.info(
      {
        username,
        contextLength: dynamicContext.length,
        historyCount: chatHistory.length,
        userMessagePreview: userMessage.slice(0, 80),
      },
      "Chat input received",
    );

    conversationContext.rememberMessage(
      channelId,
      username,
      userMessage,
      false,
      messageId,
    );

    const { shouldExtract } = conversationContext.trackUserMessage(
      channelId,
      username,
    );
    if (shouldExtract) {
      conversationContext.markExtracted(channelId, username);
      void autoExtractFacts(username, channelId).catch((error) =>
        aiLogger.warn(
          { error: (error as Error).message, username, channelId },
          "Background fact extraction crashed",
        ),
      );
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), CHAT_TIMEOUT_MS);
    session.onThinking();

    try {
      const agentSession = await sessionManager.getOrCreate(
        channelId,
        messageId,
      );
      const agentSessionId = await agentSession.getSessionId();
      const agent = this.createAgent(session);
      const runner = agentsRuntimeManager.getRunner();
      const runOptions = {
        stream: true,
        session: agentSession,
        maxTurns: 12,
        signal: abortController.signal,
        toolExecution: { maxFunctionToolConcurrency: 1 },
      } as const;

      aiLogger.debug(
        {
          channelId,
          sessionId: agentSessionId,
          localToolCount: allTools.length,
          mcpToolCount: mcpConnectionManager.getTools().length,
        },
        "Using persistent OpenAI Agents session",
      );

      let stream = await runner.run(agent, enrichedMessage, runOptions);
      await this.drainStream(stream);

      let approvalCycles = 0;
      while (stream.interruptions.length > 0) {
        approvalCycles += 1;
        if (approvalCycles > 5) {
          throw new Error("Too many tool approval cycles in one chat turn");
        }

        session.onComplete();
        await this.resolveApprovals(
          channelId,
          agentSessionId,
          stream.interruptions,
          stream.state,
        );
        session.onThinking();

        stream = await runner.run(agent, stream.state, runOptions);
        await this.drainStream(stream);
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
      permissionManager.clearContext(channelId);
    }
  }

  private createAgent(session: ChatSession) {
    const agent = new Agent({
      name: "Ruyi",
      instructions: systemPrompt,
      model: agentsRuntimeManager.model,
      tools: [...allTools],
      mcpServers: mcpConnectionManager.getServers(),
      mcpConfig: {
        convertSchemasToStrict: true,
      },
      toolUseBehavior: "run_llm_again",
    });

    agent.on("agent_tool_start", (_context, tool, details) => {
      this.handleToolStart(tool, details.toolCall, session);
    });
    agent.on("agent_tool_end", (_context, tool) => {
      this.handleToolEnd(tool, session);
    });

    return agent;
  }

  private async drainStream(stream: StreamLike): Promise<void> {
    for await (const _event of stream) {
      // Consuming the stream lets the SDK execute tool calls and surface
      // lifecycle hooks; tool UI updates happen through agent_tool_* events.
    }

    await stream.completed;
    if (stream.error) throw stream.error;
  }

  private getToolDisplayName(toolName: string): {
    displayName: string;
    isLocalTool: boolean;
  } {
    const isLocalTool = LOCAL_TOOL_NAMES.has(toolName);
    const mcpServer = mcpRegistry.getServerForTool(toolName);
    const displayName = formatToolDisplayName(
      toolName,
      isLocalTool,
      mcpServer,
    );
    return { displayName, isLocalTool };
  }

  private handleToolStart(
    tool: Tool,
    toolCall: unknown,
    session: ChatSession,
  ): void {
    const { displayName, isLocalTool } = this.getToolDisplayName(tool.name);
    aiLogger.info(
      { tool: tool.name, isMCP: !isLocalTool },
      isLocalTool ? "Tool execution starting" : "MCP tool execution starting",
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
    for (const approval of approvals) {
      const approved = await permissionManager.requestToolApproval(
        channelId,
        approval,
        sessionId,
      );

      if (approved) {
        state.approve(approval);
      } else {
        state.reject(approval, {
          message: "The Discord user denied approval for this tool call.",
        });
      }
    }
  }
}

export const chatService = new ChatService();
