import { createStore } from '@tanstack/store';

interface SteamServiceAccountState {
  pendingCommentCheck: boolean;
  processingCommentCheck: boolean;
}

interface SteamServiceStoreState {
  accounts: Record<string, SteamServiceAccountState>;
  running: boolean;
}

const defaultAccountState: SteamServiceAccountState = {
  pendingCommentCheck: false,
  processingCommentCheck: false,
};

const steamServiceStore = createStore<SteamServiceStoreState>({
  accounts: {},
  running: false,
});

function getAccountState(accountId: string): SteamServiceAccountState {
  return steamServiceStore.state.accounts[accountId] ?? defaultAccountState;
}

function setAccountState(
  accountId: string,
  patch: Partial<SteamServiceAccountState>,
): void {
  steamServiceStore.setState((state) => {
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

export function isSteamProfileCommentServiceRunning(): boolean {
  return steamServiceStore.state.running;
}

export function setSteamProfileCommentServiceRunning(running: boolean): void {
  steamServiceStore.setState(state => ({ ...state, running }));
}

export function isSteamProfileCommentCheckProcessing(
  accountId: string,
): boolean {
  return getAccountState(accountId).processingCommentCheck;
}

export function setSteamProfileCommentCheckProcessing(
  accountId: string,
  processingCommentCheck: boolean,
): void {
  setAccountState(accountId, { processingCommentCheck });
}

export function hasPendingSteamProfileCommentCheck(accountId: string): boolean {
  return getAccountState(accountId).pendingCommentCheck;
}

export function setPendingSteamProfileCommentCheck(
  accountId: string,
  pendingCommentCheck: boolean,
): void {
  setAccountState(accountId, { pendingCommentCheck });
}
