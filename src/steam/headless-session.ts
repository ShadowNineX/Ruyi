import { aiLogger } from "../logger";
import { ChatRuntimeSession } from "../ai/chat-runtime-session";

export class HeadlessChatSession extends ChatRuntimeSession {
  override onThinking(): void {
    aiLogger.debug({ surface: "steam" }, "Steam chat thinking");
  }

  override onApprovalPending(): void {
    aiLogger.debug({ surface: "steam" }, "Steam chat approval pending");
  }

  override onTextGenerationStart(_delta: string): void {
    aiLogger.debug({ surface: "steam" }, "Steam chat generation started");
  }

  override onTextGenerationEnd(): void {
    aiLogger.debug({ surface: "steam" }, "Steam chat generation ended");
  }

  override onToolStart(
    toolName: string,
    _args?: Record<string, unknown>,
  ): void {
    aiLogger.debug({ surface: "steam", toolName }, "Steam chat tool started");
  }

  override onToolEnd(toolName: string): void {
    aiLogger.debug({ surface: "steam", toolName }, "Steam chat tool ended");
  }

  override onComplete(): void {
    aiLogger.debug({ surface: "steam" }, "Steam chat completed");
  }

  override onError(): void {
    aiLogger.debug({ surface: "steam" }, "Steam chat errored");
  }
}
