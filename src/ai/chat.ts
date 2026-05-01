import type { SessionEvent } from "@github/copilot-sdk";
import type { GuildTextBasedChannel } from "discord.js";
import { allTools } from "../tools";
import { aiLogger } from "../logger";
import { mcpRegistry } from "../mcp";
import { env } from "../env";
import { CHAT_TIMEOUT_MS } from "../constants";
import type { ChatSession } from "../utils/chatSession";
import { systemPrompt } from "./prompt";
import { sessionManager } from "./session";
import { conversationContext, type ChatMessage } from "./context";
import { permissionManager } from "./permissions";
import { autoExtractFacts } from "./extraction";

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

const INTERNAL_SDK_TOOLS = new Set(["report_intent", "report_progress"]);

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

    // c.ai-style long-term memory: every N user turns, run a background
    // extraction pass to harvest durable facts. Best-effort; never blocks.
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

    session.onThinking();

    try {
      const copilotSession = await sessionManager.getOrCreate(
        channelId,
        systemPrompt,
      );

      aiLogger.debug(
        {
          channelId,
          sessionId: copilotSession.sessionId,
          toolCount: allTools.length,
        },
        "Using persistent Copilot session",
      );

      const unsubscribe = this.attachToolEventListener(copilotSession, session);

      const result = await copilotSession.sendAndWait(
        { prompt: enrichedMessage },
        CHAT_TIMEOUT_MS,
      );
      const finalContent = result?.data.content ?? null;

      unsubscribe();

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

      permissionManager.clearContext(channelId);

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
      permissionManager.clearContext(channelId);
      session.onComplete();
      // Re-throw so the caller can surface a meaningful error to the user
      // via getErrorMessage() instead of a generic "no response" string.
      throw error;
    }
  }

  /**
   * Subscribe to tool execution events on a Copilot session and forward
   * them to the Discord-side `ChatSession` for status-embed updates.
   * Returns the unsubscribe function.
   */
  private attachToolEventListener(
    copilotSession: { on: (cb: (event: SessionEvent) => void) => () => void },
    session: ChatSession,
  ): () => void {
    const toolCallMap = new Map<string, string>();
    const registeredToolNames = new Set(allTools.map((t) => t.name));

    return copilotSession.on((event: SessionEvent) => {
      if (event.type === "tool.execution_start") {
        const data = event.data as {
          toolName: string;
          toolCallId: string;
          arguments?: unknown;
        };

        if (INTERNAL_SDK_TOOLS.has(data.toolName)) return;

        const isLocalTool = registeredToolNames.has(data.toolName);
        const mcpServer = mcpRegistry.getServerForTool(data.toolName);
        const displayName = formatToolDisplayName(
          data.toolName,
          isLocalTool,
          mcpServer,
        );

        toolCallMap.set(data.toolCallId, displayName);
        aiLogger.info(
          { tool: data.toolName, isMCP: !isLocalTool },
          isLocalTool
            ? "Tool execution starting"
            : "MCP tool execution starting",
        );
        session.onComplete();
        session.onToolStart(
          displayName,
          (data.arguments as Record<string, unknown>) ?? {},
        );
      } else if (event.type === "tool.execution_complete") {
        const data = event.data as { toolCallId: string };
        const displayName = toolCallMap.get(data.toolCallId);
        if (!displayName) return;

        toolCallMap.delete(data.toolCallId);
        aiLogger.debug({ tool: displayName }, "Tool execution complete");
        session.onToolEnd(displayName);
        session.onThinking();
      }
    });
  }
}

export const chatService = new ChatService();
