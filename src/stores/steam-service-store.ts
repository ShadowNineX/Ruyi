import { createStore } from '@tanstack/store';

interface SteamServiceStoreState {
  pendingCommentCheck: boolean;
  processingCommentCheck: boolean;
  running: boolean;
}

const steamServiceStore = createStore<SteamServiceStoreState>({
  pendingCommentCheck: false,
  processingCommentCheck: false,
  running: false,
});

export function isSteamProfileCommentServiceRunning(): boolean {
  return steamServiceStore.state.running;
}

export function setSteamProfileCommentServiceRunning(running: boolean): void {
  steamServiceStore.setState(state => ({ ...state, running }));
}

export function isSteamProfileCommentCheckProcessing(): boolean {
  return steamServiceStore.state.processingCommentCheck;
}

export function setSteamProfileCommentCheckProcessing(
  processingCommentCheck: boolean,
): void {
  steamServiceStore.setState(state => ({ ...state, processingCommentCheck }));
}

export function hasPendingSteamProfileCommentCheck(): boolean {
  return steamServiceStore.state.pendingCommentCheck;
}

export function setPendingSteamProfileCommentCheck(
  pendingCommentCheck: boolean,
): void {
  steamServiceStore.setState(state => ({ ...state, pendingCommentCheck }));
}
