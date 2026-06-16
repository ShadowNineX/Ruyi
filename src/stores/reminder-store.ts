import { createStore } from "@tanstack/store";

interface ReminderStoreState {
  timeout: ReturnType<typeof setTimeout> | null;
  nextDueAt: Date | null;
  running: boolean;
}

const reminderStore = createStore<ReminderStoreState>({
  timeout: null,
  nextDueAt: null,
  running: false,
});

export function getReminderSchedulerTimeout(): ReturnType<
  typeof setTimeout
> | null {
  return reminderStore.state.timeout;
}

export function getReminderSchedulerNextDueAt(): Date | null {
  return reminderStore.state.nextDueAt;
}

export function setReminderSchedulerTimeout(
  timeout: ReturnType<typeof setTimeout> | null,
  nextDueAt: Date | null,
): void {
  reminderStore.setState((state) => ({ ...state, timeout, nextDueAt }));
}

export function isReminderServiceRunning(): boolean {
  return reminderStore.state.running;
}

export function setReminderServiceRunning(running: boolean): void {
  reminderStore.setState((state) => ({ ...state, running }));
}
