import { createStore } from "@tanstack/store";

export interface CachedAgentSession {
  matchesModel(model: string): boolean;
  markInvalidated(): void;
}

interface AgentSessionStoreState {
  activeSessions: Map<string, CachedAgentSession>;
}

const agentSessionStore = createStore<AgentSessionStoreState>({
  activeSessions: new Map(),
});

export function getCachedAgentSession<
  TSession extends CachedAgentSession = CachedAgentSession,
>(channelId: string): TSession | undefined {
  return agentSessionStore.state.activeSessions.get(channelId) as
    | TSession
    | undefined;
}

export function setCachedAgentSession<TSession extends CachedAgentSession>(
  channelId: string,
  session: TSession,
): void {
  agentSessionStore.setState((state) => {
    const activeSessions = new Map(state.activeSessions);
    activeSessions.set(channelId, session);
    return { ...state, activeSessions };
  });
}

export function deleteCachedAgentSession(channelId: string): void {
  agentSessionStore.setState((state) => {
    const activeSessions = new Map(state.activeSessions);
    activeSessions.delete(channelId);
    return { ...state, activeSessions };
  });
}

export function clearCachedAgentSessions(): void {
  agentSessionStore.setState((state) => ({
    ...state,
    activeSessions: new Map(),
  }));
}

export function getCachedAgentSessions(): CachedAgentSession[] {
  return [...agentSessionStore.state.activeSessions.values()];
}

export function getCachedAgentSessionCount(): number {
  return agentSessionStore.state.activeSessions.size;
}
