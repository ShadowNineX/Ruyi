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
  clearExternalDataCache,
  getExternalDataCacheSize,
  getOrCreateCachedExternalData,
} from '../../src/stores/data-cache-store';
import {
  getReminderSchedulerNextDueAt,
  getReminderSchedulerTimeout,
  isReminderServiceRunning,
  setReminderSchedulerTimeout,
  setReminderServiceRunning,
} from '../../src/stores/reminder-store';
import {
  areSteamCommunityLifecycleListenersAttached,
  getSteamCommunityStartPromise,
  isSteamCommunityReady,
  setSteamCommunityLifecycleListenersAttached,
  setSteamCommunityReady,
  setSteamCommunityStartPromise,
} from '../../src/stores/steam-client-store';
import {
  clearSteamProfileDataCache,
  getOrCreateCachedSteamProfileData,
  getSteamProfileDataCacheSize,
} from '../../src/stores/steam-profile-store';
import {
  hasPendingSteamProfileCommentCheck,
  isSteamProfileCommentCheckProcessing,
  isSteamProfileCommentServiceRunning,
  setPendingSteamProfileCommentCheck,
  setSteamProfileCommentCheckProcessing,
  setSteamProfileCommentServiceRunning,
} from '../../src/stores/steam-service-store';

function testSession(): CachedAgentSession {
  return {
    matchesConfiguration: model => model === 'gpt-test',
    markInvalidated: () => undefined,
  };
}

const TEST_STEAM_ACCOUNT_ID = 'ruyi';
const TEST_TAILS_STEAM_ACCOUNT_ID = 'tails';

const defaultSettings: ScopedSettings = {
  prefix: '!',
  searchProvider: 'openai',
  modelPreset: 'balanced',
  awayScopeEnabled: true,
  awayDelayMinutes: 120,
  awayCooldownHours: 24,
};

async function expectPromiseToRejectWithMessage(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toContain(message);
    }
    return;
  }

  throw new Error(`Expected promise to reject with "${message}".`);
}

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

describe('external data cache store', () => {
  test('deduplicates reads inside a namespace and keeps namespaces isolated', async () => {
    clearExternalDataCache();
    let readCount = 0;

    const first = getOrCreateCachedExternalData({
      key: 'same-key',
      maxEntries: 10,
      namespace: 'pinterest',
      read: async () => {
        readCount += 1;
        return { board: 'quotes' };
      },
      ttlMs: 10_000,
    });
    const second = getOrCreateCachedExternalData({
      key: 'same-key',
      maxEntries: 10,
      namespace: 'pinterest',
      read: async () => {
        readCount += 1;
        return { board: 'other' };
      },
      ttlMs: 10_000,
    });

    expect(await first).toEqual({ board: 'quotes' });
    expect(await second).toEqual({ board: 'quotes' });
    expect(readCount).toBe(1);
    expect(getExternalDataCacheSize('pinterest')).toBe(1);
    expect(getExternalDataCacheSize('steam-profile')).toBe(0);
  });

  test('drops failed reads so the next attempt can retry', async () => {
    clearExternalDataCache();

    await expectPromiseToRejectWithMessage(
      getOrCreateCachedExternalData({
        key: 'private-board',
        maxEntries: 10,
        namespace: 'pinterest',
        read: async () => {
          throw new Error('private');
        },
        ttlMs: 10_000,
      }),
      'private',
    );

    expect(getExternalDataCacheSize('pinterest')).toBe(0);
  });

  test('refreshes cached data after its ttl expires', async () => {
    clearExternalDataCache();
    let readCount = 0;

    const first = await getOrCreateCachedExternalData({
      key: 'board:quotes',
      maxEntries: 10,
      namespace: 'pinterest',
      now: 1_000,
      read: async () => {
        readCount += 1;
        return { version: readCount };
      },
      ttlMs: 100,
    });
    const cached = await getOrCreateCachedExternalData({
      key: 'board:quotes',
      maxEntries: 10,
      namespace: 'pinterest',
      now: 1_050,
      read: async () => {
        readCount += 1;
        return { version: readCount };
      },
      ttlMs: 100,
    });
    const refreshed = await getOrCreateCachedExternalData({
      key: 'board:quotes',
      maxEntries: 10,
      namespace: 'pinterest',
      now: 1_101,
      read: async () => {
        readCount += 1;
        return { version: readCount };
      },
      ttlMs: 100,
    });

    expect(first).toEqual({ version: 1 });
    expect(cached).toEqual({ version: 1 });
    expect(refreshed).toEqual({ version: 2 });
    expect(readCount).toBe(2);
  });

  test('force refresh bypasses a live cache entry and replaces it', async () => {
    clearExternalDataCache();
    let readCount = 0;

    await getOrCreateCachedExternalData({
      key: 'profile:owner',
      maxEntries: 10,
      namespace: 'steam-profile',
      read: async () => {
        readCount += 1;
        return { version: readCount };
      },
      ttlMs: 10_000,
    });
    const refreshed = await getOrCreateCachedExternalData({
      forceRefresh: true,
      key: 'profile:owner',
      maxEntries: 10,
      namespace: 'steam-profile',
      read: async () => {
        readCount += 1;
        return { version: readCount };
      },
      ttlMs: 10_000,
    });
    const cachedRefresh = await getOrCreateCachedExternalData({
      key: 'profile:owner',
      maxEntries: 10,
      namespace: 'steam-profile',
      read: async () => {
        readCount += 1;
        return { version: readCount };
      },
      ttlMs: 10_000,
    });

    expect(refreshed).toEqual({ version: 2 });
    expect(cachedRefresh).toEqual({ version: 2 });
    expect(readCount).toBe(2);
  });
});

describe('Steam profile store', () => {
  test('deduplicates cached Steam profile data reads', async () => {
    clearSteamProfileDataCache(TEST_STEAM_ACCOUNT_ID);
    let readCount = 0;

    const first = getOrCreateCachedSteamProfileData(TEST_STEAM_ACCOUNT_ID, 'profile:owner', async () => {
      readCount += 1;
      return { name: 'Shadow' };
    });
    const second = getOrCreateCachedSteamProfileData(TEST_STEAM_ACCOUNT_ID, 'profile:owner', async () => {
      readCount += 1;
      return { name: 'Other' };
    });

    expect(await first).toEqual({ name: 'Shadow' });
    expect(await second).toEqual({ name: 'Shadow' });
    expect(readCount).toBe(1);
    expect(getSteamProfileDataCacheSize(TEST_STEAM_ACCOUNT_ID)).toBe(1);
  });

  test('removes failed Steam profile data reads from cache', async () => {
    clearSteamProfileDataCache(TEST_STEAM_ACCOUNT_ID);

    await expectPromiseToRejectWithMessage(
      getOrCreateCachedSteamProfileData(TEST_STEAM_ACCOUNT_ID, 'profile:error', async () => {
        throw new Error('private');
      }),
      'private',
    );

    expect(getSteamProfileDataCacheSize(TEST_STEAM_ACCOUNT_ID)).toBe(0);
  });

  test('can force refresh Steam profile data through the wrapper', async () => {
    clearSteamProfileDataCache(TEST_STEAM_ACCOUNT_ID);
    let readCount = 0;

    await getOrCreateCachedSteamProfileData(TEST_STEAM_ACCOUNT_ID, 'profile:owner', async () => {
      readCount += 1;
      return { version: readCount };
    });
    const refreshed = await getOrCreateCachedSteamProfileData(
      TEST_STEAM_ACCOUNT_ID,
      'profile:owner',
      async () => {
        readCount += 1;
        return { version: readCount };
      },
      { forceRefresh: true },
    );

    expect(refreshed).toEqual({ version: 2 });
    expect(readCount).toBe(2);
  });

  test('keeps cached Steam profile data isolated per account', async () => {
    clearSteamProfileDataCache(TEST_STEAM_ACCOUNT_ID);
    clearSteamProfileDataCache(TEST_TAILS_STEAM_ACCOUNT_ID);

    await getOrCreateCachedSteamProfileData(TEST_STEAM_ACCOUNT_ID, 'profile:owner', async () => ({
      name: 'Ruyi view',
    }));
    const tailsView = await getOrCreateCachedSteamProfileData(
      TEST_TAILS_STEAM_ACCOUNT_ID,
      'profile:owner',
      async () => ({ name: 'Tails view' }),
    );

    expect(tailsView).toEqual({ name: 'Tails view' });
    expect(getSteamProfileDataCacheSize(TEST_STEAM_ACCOUNT_ID)).toBe(1);
    expect(getSteamProfileDataCacheSize(TEST_TAILS_STEAM_ACCOUNT_ID)).toBe(1);
  });
});

describe('Steam client store', () => {
  test('tracks Steam Community readiness and startup promise', () => {
    const startPromise = Promise.resolve();

    setSteamCommunityReady(TEST_STEAM_ACCOUNT_ID, false);
    setSteamCommunityStartPromise(TEST_STEAM_ACCOUNT_ID, null);
    setSteamCommunityLifecycleListenersAttached(TEST_STEAM_ACCOUNT_ID, false);

    setSteamCommunityReady(TEST_STEAM_ACCOUNT_ID, true);
    setSteamCommunityStartPromise(TEST_STEAM_ACCOUNT_ID, startPromise);
    setSteamCommunityLifecycleListenersAttached(TEST_STEAM_ACCOUNT_ID, true);

    expect(isSteamCommunityReady(TEST_STEAM_ACCOUNT_ID)).toBe(true);
    expect(getSteamCommunityStartPromise(TEST_STEAM_ACCOUNT_ID)).toBe(startPromise);
    expect(areSteamCommunityLifecycleListenersAttached(TEST_STEAM_ACCOUNT_ID)).toBe(true);

    setSteamCommunityReady(TEST_STEAM_ACCOUNT_ID, false);
    setSteamCommunityStartPromise(TEST_STEAM_ACCOUNT_ID, null);
    setSteamCommunityLifecycleListenersAttached(TEST_STEAM_ACCOUNT_ID, false);
  });
});

describe('Steam service store', () => {
  test('tracks Steam comment service lifecycle state', () => {
    setSteamProfileCommentServiceRunning(false);
    setSteamProfileCommentCheckProcessing(TEST_STEAM_ACCOUNT_ID, false);
    setPendingSteamProfileCommentCheck(TEST_STEAM_ACCOUNT_ID, false);

    setSteamProfileCommentServiceRunning(true);
    setSteamProfileCommentCheckProcessing(TEST_STEAM_ACCOUNT_ID, true);
    setPendingSteamProfileCommentCheck(TEST_STEAM_ACCOUNT_ID, true);

    expect(isSteamProfileCommentServiceRunning()).toBe(true);
    expect(isSteamProfileCommentCheckProcessing(TEST_STEAM_ACCOUNT_ID)).toBe(true);
    expect(hasPendingSteamProfileCommentCheck(TEST_STEAM_ACCOUNT_ID)).toBe(true);

    setSteamProfileCommentServiceRunning(false);
    setSteamProfileCommentCheckProcessing(TEST_STEAM_ACCOUNT_ID, false);
    setPendingSteamProfileCommentCheck(TEST_STEAM_ACCOUNT_ID, false);

    expect(isSteamProfileCommentServiceRunning()).toBe(false);
    expect(isSteamProfileCommentCheckProcessing(TEST_STEAM_ACCOUNT_ID)).toBe(false);
    expect(hasPendingSteamProfileCommentCheck(TEST_STEAM_ACCOUNT_ID)).toBe(false);
  });
});
