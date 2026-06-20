import { createStore } from '@tanstack/store';

interface SteamClientStoreState {
  lifecycleListenersAttached: boolean;
  ready: boolean;
  reconnectAttempts: number;
  reconnectEnabled: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  startPromise: Promise<void> | null;
}

const steamClientStore = createStore<SteamClientStoreState>({
  lifecycleListenersAttached: false,
  ready: false,
  reconnectAttempts: 0,
  reconnectEnabled: false,
  reconnectTimer: null,
  startPromise: null,
});

export function isSteamCommunityReady(): boolean {
  return steamClientStore.state.ready;
}

export function setSteamCommunityReady(ready: boolean): void {
  steamClientStore.setState(state => ({ ...state, ready }));
}

export function isSteamCommunityReconnectEnabled(): boolean {
  return steamClientStore.state.reconnectEnabled;
}

export function setSteamCommunityReconnectEnabled(
  reconnectEnabled: boolean,
): void {
  steamClientStore.setState(state => ({ ...state, reconnectEnabled }));
}

export function incrementSteamCommunityReconnectAttempts(): number {
  const reconnectAttempts = steamClientStore.state.reconnectAttempts + 1;
  steamClientStore.setState(state => ({ ...state, reconnectAttempts }));
  return reconnectAttempts;
}

export function resetSteamCommunityReconnectAttempts(): void {
  steamClientStore.setState(state => ({ ...state, reconnectAttempts: 0 }));
}

export function getSteamCommunityReconnectTimer(): ReturnType<typeof setTimeout> | null {
  return steamClientStore.state.reconnectTimer;
}

export function setSteamCommunityReconnectTimer(
  reconnectTimer: ReturnType<typeof setTimeout> | null,
): void {
  steamClientStore.setState(state => ({ ...state, reconnectTimer }));
}

export function getSteamCommunityStartPromise(): Promise<void> | null {
  return steamClientStore.state.startPromise;
}

export function setSteamCommunityStartPromise(
  startPromise: Promise<void> | null,
): void {
  steamClientStore.setState(state => ({ ...state, startPromise }));
}

export function areSteamCommunityLifecycleListenersAttached(): boolean {
  return steamClientStore.state.lifecycleListenersAttached;
}

export function setSteamCommunityLifecycleListenersAttached(
  lifecycleListenersAttached: boolean,
): void {
  steamClientStore.setState(state => ({
    ...state,
    lifecycleListenersAttached,
  }));
}
