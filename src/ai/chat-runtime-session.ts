import type { PermissionPromptController } from '../stores';

export abstract class ChatRuntimeSession {
  getPermissionPromptController?(): PermissionPromptController;
  abstract onThinking(): void;
  abstract onApprovalPending(): void;
  abstract onTextGenerationStart(delta: string): void;
  abstract onTextGenerationEnd(): void;
  abstract onToolStart(
    toolName: string,
    args?: Record<string, unknown>,
  ): void;
  abstract onToolEnd(toolName: string): void;
  abstract onComplete(): void;
  abstract onError(): void;
}
