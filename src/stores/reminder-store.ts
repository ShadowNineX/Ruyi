import { createStore } from "@tanstack/store";

interface ReminderStoreState {
  interval: ReturnType<typeof setInterval> | null;
  running: boolean;
}

const reminderStore = createStore<ReminderStoreState>({
  interval: null,
  running: false,
});

export function getReminderInterval(): ReturnType<typeof setInterval> | null {
  return reminderStore.state.interval;
}

export function setReminderInterval(
  interval: ReturnType<typeof setInterval> | null,
): void {
  reminderStore.setState((state) => ({ ...state, interval }));
}

export function isReminderServiceRunning(): boolean {
  return reminderStore.state.running;
}

export function setReminderServiceRunning(running: boolean): void {
  reminderStore.setState((state) => ({ ...state, running }));
}
