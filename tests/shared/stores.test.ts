import type { CachedAgentSession } from '../../src/stores/agent-session-store';
import type { ScopedSettings } from '../../src/stores/config-store';
import { describe, expect, test } from 'bun:test';
import {

  clearCachedAgentSessions,
  deleteCachedAgentSession,
  getCachedAgentSession,
  getCachedAgentSessionCount,
  getCachedAgentSessions,
  setCachedAgentSession,
} from '../../src/stores/agent-session-store';
import {
  getAwayLastSentAtCache,
  getAwayUserEnabledCache,
  getScopedSettingsCache,
  resetConfigStore,

  setAwayLastSentAtCache,
  setAwayUserEnabledCache,
  updateScopedSettingsCache,
} from '../../src/stores/config-store';
import {
  getLastExtractionAt,
  getLastInteractionAt,
  incrementUserMessageCount,
  resetUserMessageCount,
  setLastExtractionAt,
  setLastInteractionAt,
} from '../../src/stores/conversation-store';
import {
  getReminderSchedulerNextDueAt,
  getReminderSchedulerTimeout,
  isReminderServiceRunning,
  setReminderSchedulerTimeout,
  setReminderServiceRunning,
} from '../../src/stores/reminder-store';

function testSession(): CachedAgentSession {
  return {
    matchesModel: model => model === 'gpt-test',
    markInvalidated: () => undefined,
  };
}

const defaultSettings: ScopedSettings = {
  prefix: '!',
  searchProvider: 'openai',
  modelPreset: 'balanced',
  awayScopeEnabled: true,
  awayDelayMinutes: 120,
  awayCooldownHours: 24,
};

describe('agent session store', () => {
  test('sets, reads, deletes, and clears cached sessions', () => {
    clearCachedAgentSessions();
    const session = testSession();

    setCachedAgentSession('discord:channel-1', session);
    expect(getCachedAgentSession('discord:channel-1')).toBe(session);
    expect(getCachedAgentSessionCount()).toBe(1);
    expect(getCachedAgentSessions()).toEqual([session]);

    deleteCachedAgentSession('discord:channel-1');
    expect(getCachedAgentSessionCount()).toBe(0);

    setCachedAgentSession('steam:profile-1', session);
    clearCachedAgentSessions();
    expect(getCachedAgentSessionCount()).toBe(0);
  });
});

describe('config store', () => {
  test('keeps scoped settings and away settings isolated by key', () => {
    resetConfigStore();

    const updated = updateScopedSettingsCache(
      'discord:guild:guild-1',
      defaultSettings,
      settings => ({ ...settings, prefix: '?' }),
    );

    expect(updated.prefix).toBe('?');
    expect(getScopedSettingsCache('discord:guild:guild-1')?.prefix).toBe('?');
    expect(getScopedSettingsCache('discord:guild:guild-2')).toBeUndefined();

    setAwayUserEnabledCache('discord:guild:guild-1:user-1', true);
    setAwayLastSentAtCache('discord:guild:guild-1:user-1', 123);
    expect(getAwayUserEnabledCache('discord:guild:guild-1:user-1')).toBe(true);
    expect(getAwayLastSentAtCache('discord:guild:guild-1:user-1')).toBe(123);
  });
});

describe('conversation store', () => {
  test('tracks last interaction and extraction counters by key', () => {
    setLastInteractionAt('discord:channel-1', 10);
    expect(getLastInteractionAt('discord:channel-1')).toBe(10);

    expect(incrementUserMessageCount('owner:steam')).toBe(1);
    expect(incrementUserMessageCount('owner:steam')).toBe(2);
    resetUserMessageCount('owner:steam');
    expect(incrementUserMessageCount('owner:steam')).toBe(1);

    expect(getLastExtractionAt('owner:steam')).toBe(0);
    setLastExtractionAt('owner:steam', 99);
    expect(getLastExtractionAt('owner:steam')).toBe(99);
  });
});

describe('reminder store', () => {
  test('tracks scheduler wake and running state', () => {
    const timeout = setTimeout(() => undefined, 10_000);
    const wakeAt = new Date('2026-06-16T10:00:00.000Z');

    try {
      setReminderSchedulerTimeout(timeout, wakeAt);
      expect(getReminderSchedulerTimeout()).toBe(timeout);
      expect(getReminderSchedulerNextDueAt()).toBe(wakeAt);

      setReminderServiceRunning(true);
      expect(isReminderServiceRunning()).toBe(true);
      setReminderServiceRunning(false);
      expect(isReminderServiceRunning()).toBe(false);
    } finally {
      clearTimeout(timeout);
      setReminderSchedulerTimeout(null, null);
      setReminderServiceRunning(false);
    }
  });
});
