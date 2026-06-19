import { createStore } from '@tanstack/store';

export interface AwayTimer {
  timer: ReturnType<typeof setTimeout>;
  dueAt: number;
  userId: string;
}

interface AwayStoreState {
  timers: Map<string, AwayTimer>;
  lastUserActivityAt: Map<string, number>;
  lastScopedUserActivityAt: Map<string, number>;
  lastChannelActivityAt: Map<string, number>;
}

const awayStore = createStore<AwayStoreState>({
  timers: new Map(),
  lastUserActivityAt: new Map(),
  lastScopedUserActivityAt: new Map(),
  lastChannelActivityAt: new Map(),
});

export function getAwayTimer(key: string): AwayTimer | undefined {
  return awayStore.state.timers.get(key);
}

export function setAwayTimer(key: string, timer: AwayTimer): void {
  awayStore.setState((state) => {
    const timers = new Map(state.timers);
    timers.set(key, timer);
    return { ...state, timers };
  });
}

export function deleteAwayTimer(key: string): void {
  awayStore.setState((state) => {
    const timers = new Map(state.timers);
    timers.delete(key);
    return { ...state, timers };
  });
}

export function getAwayTimerEntries(): Array<[string, AwayTimer]> {
  return [...awayStore.state.timers.entries()];
}

export function setLastUserActivityAt(userId: string, timestamp: number): void {
  awayStore.setState((state) => {
    const lastUserActivityAt = new Map(state.lastUserActivityAt);
    lastUserActivityAt.set(userId, timestamp);
    return { ...state, lastUserActivityAt };
  });
}

export function getLastUserActivityAt(userId: string): number {
  return awayStore.state.lastUserActivityAt.get(userId) ?? 0;
}

export function setLastScopedUserActivityAt(
  key: string,
  timestamp: number,
): void {
  awayStore.setState((state) => {
    const lastScopedUserActivityAt = new Map(state.lastScopedUserActivityAt);
    lastScopedUserActivityAt.set(key, timestamp);
    return { ...state, lastScopedUserActivityAt };
  });
}

export function getLastScopedUserActivityAt(key: string): number {
  return awayStore.state.lastScopedUserActivityAt.get(key) ?? 0;
}

export function setLastChannelActivityAt(
  channelId: string,
  timestamp: number,
): void {
  awayStore.setState((state) => {
    const lastChannelActivityAt = new Map(state.lastChannelActivityAt);
    lastChannelActivityAt.set(channelId, timestamp);
    return { ...state, lastChannelActivityAt };
  });
}

export function getLastChannelActivityAt(channelId: string): number {
  return awayStore.state.lastChannelActivityAt.get(channelId) ?? 0;
}
