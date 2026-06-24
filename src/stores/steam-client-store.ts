import { createStore } from '@tanstack/store';

interface SteamClientAccountState {
  loginInProgress: boolean;
  lifecycleListenersAttached: boolean;
  ready: boolean;
  reconnectAttempts: number;
  reconnectEnabled: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  startPromise: Promise<void> | null;
}

interface SteamClientStoreState {
  accounts: Record<string, SteamClientAccountState>;
}

const defaultAccountState: SteamClientAccountState = {
  loginInProgress: false,
  lifecycleListenersAttached: false,
  ready: false,
  reconnectAttempts: 0,
  reconnectEnabled: false,
  reconnectTimer: null,
  startPromise: null,
};

const steamClientStore = createStore<SteamClientStoreState>({
  accounts: {},
});

function getAccountState(accountId: string): SteamClientAccountState {
  return steamClientStore.state.accounts[accountId] ?? defaultAccountState;
}

function setAccountState(
  accountId: string,
  patch: Partial<SteamClientAccountState>,
): void {
  steamClientStore.setState((state) => {
    const current = state.accounts[accountId] ?? defaultAccountState;
    return {
      ...state,
      accounts: {
        ...state.accounts,
        [accountId]: { ...current, ...patch },
      },
    };
  });
}

export function isSteamCommunityLoginInProgress(accountId: string): boolean {
  return getAccountState(accountId).loginInProgress;
}

export function setSteamCommunityLoginInProgress(
  accountId: string,
  loginInProgress: boolean,
): void {
  setAccountState(accountId, { loginInProgress });
}

export function isSteamCommunityReady(accountId: string): boolean {
  return getAccountState(accountId).ready;
}

export function isAnySteamCommunityReady(): boolean {
  return Object.values(steamClientStore.state.accounts).some(
    account => account.ready,
  );
}

export function setSteamCommunityReady(
  accountId: string,
  ready: boolean,
): void {
  setAccountState(accountId, { ready });
}

export function isSteamCommunityReconnectEnabled(accountId: string): boolean {
  return getAccountState(accountId).reconnectEnabled;
}

export function setSteamCommunityReconnectEnabled(
  accountId: string,
  reconnectEnabled: boolean,
): void {
  setAccountState(accountId, { reconnectEnabled });
}

export function incrementSteamCommunityReconnectAttempts(
  accountId: string,
): number {
  const reconnectAttempts = getAccountState(accountId).reconnectAttempts + 1;
  setAccountState(accountId, { reconnectAttempts });
  return reconnectAttempts;
}

export function resetSteamCommunityReconnectAttempts(accountId: string): void {
  setAccountState(accountId, { reconnectAttempts: 0 });
}

export function getSteamCommunityReconnectTimer(
  accountId: string,
): ReturnType<typeof setTimeout> | null {
  return getAccountState(accountId).reconnectTimer;
}

export function setSteamCommunityReconnectTimer(
  accountId: string,
  reconnectTimer: ReturnType<typeof setTimeout> | null,
): void {
  setAccountState(accountId, { reconnectTimer });
}

export function getSteamCommunityStartPromise(
  accountId: string,
): Promise<void> | null {
  return getAccountState(accountId).startPromise;
}

export function setSteamCommunityStartPromise(
  accountId: string,
  startPromise: Promise<void> | null,
): void {
  setAccountState(accountId, { startPromise });
}

export function areSteamCommunityLifecycleListenersAttached(
  accountId: string,
): boolean {
  return getAccountState(accountId).lifecycleListenersAttached;
}

export function setSteamCommunityLifecycleListenersAttached(
  accountId: string,
  lifecycleListenersAttached: boolean,
): void {
  setAccountState(accountId, { lifecycleListenersAttached });
}
