import { createStore } from '@tanstack/store';

export interface ActiveChatTurn {
  controller: AbortController;
  messageId: string;
  referencedMessageId: string | null;
}

export interface PresenceResetTimer {
  session: symbol;
  timer: ReturnType<typeof setTimeout>;
}

interface BotStoreState {
  activePresenceSession: symbol | null;
  activeChatTurns: Map<string, ActiveChatTurn>;
  presenceResetTimer: PresenceResetTimer | null;
}

const botStore = createStore<BotStoreState>({
  activePresenceSession: null,
  activeChatTurns: new Map(),
  presenceResetTimer: null,
});

export function getActivePresenceSession(): symbol | null {
  return botStore.state.activePresenceSession;
}

export function setActivePresenceSession(session: symbol | null): void {
  botStore.setState(state => ({ ...state, activePresenceSession: session }));
}

export function getPresenceResetTimer(): PresenceResetTimer | null {
  return botStore.state.presenceResetTimer;
}

export function setPresenceResetTimer(timer: PresenceResetTimer | null): void {
  botStore.setState(state => ({ ...state, presenceResetTimer: timer }));
}

export function getActiveChatTurn(
  channelId: string,
): ActiveChatTurn | undefined {
  return botStore.state.activeChatTurns.get(channelId);
}

export function setActiveChatTurn(
  channelId: string,
  turn: ActiveChatTurn,
): void {
  botStore.setState((state) => {
    const activeChatTurns = new Map(state.activeChatTurns);
    activeChatTurns.set(channelId, turn);
    return { ...state, activeChatTurns };
  });
}

export function deleteActiveChatTurn(channelId: string): void {
  botStore.setState((state) => {
    const activeChatTurns = new Map(state.activeChatTurns);
    activeChatTurns.delete(channelId);
    return { ...state, activeChatTurns };
  });
}
