import { createStore } from '@tanstack/store';

interface SteamClientStoreState {
  lifecycleListenersAttached: boolean;
  ready: boolean;
  startPromise: Promise<void> | null;
}

const steamClientStore = createStore<SteamClientStoreState>({
  lifecycleListenersAttached: false,
  ready: false,
  startPromise: null,
});

export function isSteamCommunityReady(): boolean {
  return steamClientStore.state.ready;
}

export function setSteamCommunityReady(ready: boolean): void {
  steamClientStore.setState(state => ({ ...state, ready }));
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
