import { createStore, type Store } from "@tanstack/store";
import type { Message } from "discord.js";

type SessionStatus =
  | "thinking"
  | "generating"
  | "tool"
  | "approval"
  | "complete"
  | "error";

export interface SessionStatusSnapshot {
  status: SessionStatus;
  currentTool?: string;
}

export type SessionStatusListener = (state: SessionStatusSnapshot) => void;

export interface ChatSessionState {
  status: SessionStatus;
  currentTool?: string;
  toolCounts: Map<string, number>;
  startTime: number;
  typingInterval: ReturnType<typeof setInterval> | null;
  statusRefreshInterval: ReturnType<typeof setInterval> | null;
  statusMessage: Message | null;
  statusMessagePromise: Promise<Message | null> | null;
  statusRefreshInFlight: boolean;
  permissionPromptActive: boolean;
  replyTarget: Message | null;
  hasNotifiedStatus: boolean;
  closed: boolean;
}

export type ChatSessionStore = Store<ChatSessionState>;

export function createChatSessionStore(): ChatSessionStore {
  return createStore<ChatSessionState>({
    status: "thinking",
    toolCounts: new Map(),
    startTime: Date.now(),
    typingInterval: null,
    statusRefreshInterval: null,
    statusMessage: null,
    statusMessagePromise: null,
    statusRefreshInFlight: false,
    permissionPromptActive: false,
    replyTarget: null,
    hasNotifiedStatus: false,
    closed: false,
  });
}

export function setChatSessionPartial(
  store: ChatSessionStore,
  partial: Partial<ChatSessionState>,
): void {
  store.setState((state) => ({ ...state, ...partial }));
}

export function incrementChatSessionToolCount(
  store: ChatSessionStore,
  toolName: string,
): void {
  store.setState((state) => {
    const toolCounts = new Map(state.toolCounts);
    toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
    return { ...state, toolCounts };
  });
}
