import type { CopilotSession as SDKSession } from "@github/copilot-sdk";
import { allTools } from "../tools";
import { aiLogger } from "../logger";
import { CopilotSession as CopilotSessionModel } from "../db/models";
import { mcpConnectionManager } from "../mcp/client";
import { copilotClientManager } from "./client";
import { permissionManager } from "./permissions";
import { systemPromptVersion } from "./prompt";

export class SessionManager {
  private readonly activeSessions = new Map<string, SDKSession>();

  /**
   * Combined list of locally-defined tools and any MCP tools currently
   * registered. Recomputed on each call so newly-connected MCP servers
   * are picked up.
   */
  private getAllAvailableTools() {
    const mcpTools = mcpConnectionManager.getTools();
    return [...allTools, ...mcpTools];
  }

  async loadPersisted(): Promise<void> {
    try {
      const client = await copilotClientManager.getClient();
      const persistedSessions = await CopilotSessionModel.find({
        isActive: true,
      });

      const allAvailableTools = this.getAllAvailableTools();

      aiLogger.info(
        { count: persistedSessions.length },
        "Loading persisted sessions",
      );

      for (const persisted of persistedSessions) {
        if (
          persisted.promptVersion &&
          persisted.promptVersion !== systemPromptVersion
        ) {
          aiLogger.info(
            {
              channelId: persisted.channelId,
              sessionId: persisted.sessionId,
              storedVersion: persisted.promptVersion,
              currentVersion: systemPromptVersion,
            },
            "Skipping resume: system prompt changed since session was created",
          );
          await CopilotSessionModel.updateOne(
            { channelId: persisted.channelId },
            { $set: { isActive: false } },
          );
          continue;
        }
        try {
          const session = await client.resumeSession(persisted.sessionId, {
            tools: [...allAvailableTools],
            onPermissionRequest: permissionManager.createHandler(
              persisted.channelId,
            ),
          });

          this.activeSessions.set(persisted.channelId, session);
          aiLogger.debug(
            {
              channelId: persisted.channelId,
              sessionId: persisted.sessionId,
            },
            "Resumed persisted session",
          );
        } catch (error) {
          aiLogger.warn(
            {
              channelId: persisted.channelId,
              sessionId: persisted.sessionId,
              error: (error as Error).message,
            },
            "Failed to resume session, marking inactive",
          );
          await CopilotSessionModel.updateOne(
            { channelId: persisted.channelId },
            { $set: { isActive: false } },
          );
        }
      }

      aiLogger.info(
        { activeCount: this.activeSessions.size },
        "Session loading complete",
      );
    } catch (error) {
      aiLogger.error({ error }, "Failed to load persisted sessions");
    }
  }

  async getOrCreate(
    channelId: string,
    systemMessage: string,
  ): Promise<SDKSession> {
    const existingSession = this.activeSessions.get(channelId);
    if (existingSession) {
      aiLogger.debug({ channelId }, "Using cached session");
      await CopilotSessionModel.updateOne(
        { channelId },
        { $set: { lastUsed: new Date() } },
      );
      return existingSession;
    }

    const client = await copilotClientManager.getClient();

    const persistedSession = await CopilotSessionModel.findOne({
      channelId,
      isActive: true,
    });

    if (persistedSession) {
      const versionMatches =
        !persistedSession.promptVersion ||
        persistedSession.promptVersion === systemPromptVersion;

      if (versionMatches) {
        try {
          const allAvailableTools = this.getAllAvailableTools();

          const session = await client.resumeSession(
            persistedSession.sessionId,
            {
              tools: [...allAvailableTools],
              onPermissionRequest: permissionManager.createHandler(channelId),
            },
          );

          this.activeSessions.set(channelId, session);
          await CopilotSessionModel.updateOne(
            { channelId },
            { $set: { lastUsed: new Date() } },
          );

          aiLogger.debug(
            { channelId, sessionId: persistedSession.sessionId },
            "Resumed session from DB",
          );
          return session;
        } catch (error) {
          aiLogger.warn(
            { channelId, error: (error as Error).message },
            "Failed to resume session, creating new one",
          );
          await CopilotSessionModel.updateOne(
            { channelId },
            { $set: { isActive: false } },
          );
        }
      } else {
        aiLogger.info(
          {
            channelId,
            sessionId: persistedSession.sessionId,
            storedVersion: persistedSession.promptVersion,
            currentVersion: systemPromptVersion,
          },
          "System prompt changed; creating fresh session",
        );
        await CopilotSessionModel.updateOne(
          { channelId },
          { $set: { isActive: false } },
        );
      }
    }

    const sessionId = `ruyi-${channelId}-${Date.now()}`;

    const allAvailableTools = this.getAllAvailableTools();
    const mcpTools = allAvailableTools.slice(allTools.length);

    const permissionHandler = permissionManager.createHandler(channelId);

    const session = await client.createSession({
      sessionId,
      model: copilotClientManager.model,
      provider: copilotClientManager.getProviderConfig(),
      tools: [...allAvailableTools],
      systemMessage: {
        mode: "replace",
        content: systemMessage,
      },
      streaming: false,
      infiniteSessions: { enabled: true },
      onPermissionRequest: permissionHandler,
    });

    if (mcpTools.length > 0) {
      aiLogger.info(
        {
          channelId,
          mcpToolCount: mcpTools.length,
          tools: mcpTools.map((t) => t.name),
        },
        "Session created with MCP tools",
      );
    }

    this.activeSessions.set(channelId, session);

    await CopilotSessionModel.findOneAndUpdate(
      { channelId },
      {
        $set: {
          sessionId: session.sessionId,
          lastUsed: new Date(),
          isActive: true,
          promptVersion: systemPromptVersion,
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );

    aiLogger.info(
      { channelId, sessionId: session.sessionId },
      "Created new session",
    );

    return session;
  }

  async invalidate(channelId: string): Promise<void> {
    const session = this.activeSessions.get(channelId);
    if (session) {
      try {
        await session.disconnect();
      } catch (error) {
        aiLogger.warn(
          { channelId, error: (error as Error).message },
          "Error disconnecting session",
        );
      }
      this.activeSessions.delete(channelId);
    }

    await CopilotSessionModel.updateOne(
      { channelId },
      { $set: { isActive: false } },
    );

    aiLogger.debug({ channelId }, "Session invalidated");
  }

  async destroyAll(): Promise<void> {
    for (const [channelId, session] of this.activeSessions) {
      try {
        await session.disconnect();
        aiLogger.debug({ channelId }, "Session disconnected on shutdown");
      } catch (error) {
        aiLogger.warn(
          { channelId, error: (error as Error).message },
          "Error disconnecting session on shutdown",
        );
      }
    }
    this.activeSessions.clear();
  }

  getActiveCount(): number {
    return this.activeSessions.size;
  }
}

export const sessionManager = new SessionManager();
