import { createStore } from "@tanstack/store";

interface MessageSyncStoreState {
  syncInterval: ReturnType<typeof setInterval> | null;
  isRunning: boolean;
}

const messageSyncStore = createStore<MessageSyncStoreState>({
  syncInterval: null,
  isRunning: false,
});

export function getMessageSyncInterval(): ReturnType<
  typeof setInterval
> | null {
  return messageSyncStore.state.syncInterval;
}

export function setMessageSyncInterval(
  syncInterval: ReturnType<typeof setInterval> | null,
): void {
  messageSyncStore.setState((state) => ({ ...state, syncInterval }));
}

export function isMessageSyncRunning(): boolean {
  return messageSyncStore.state.isRunning;
}

export function setMessageSyncRunning(isRunning: boolean): void {
  messageSyncStore.setState((state) => ({ ...state, isRunning }));
}
