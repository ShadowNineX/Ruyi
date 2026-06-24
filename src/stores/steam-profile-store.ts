import {
  STEAM_PROFILE_DATA_CACHE_MAX_ENTRIES,
  STEAM_PROFILE_DATA_CACHE_TTL_MS,
} from '../constants';
import {
  clearExternalDataCacheNamespace,
  getExternalDataCacheSize,
  getOrCreateCachedExternalData,
} from './data-cache-store';

const STEAM_PROFILE_CACHE_NAMESPACE = 'steam-profile';

interface SteamProfileCacheOptions {
  forceRefresh?: boolean;
  now?: number;
}

function steamProfileCacheNamespace(accountId?: string): string {
  return accountId
    ? `${STEAM_PROFILE_CACHE_NAMESPACE}:${accountId}`
    : STEAM_PROFILE_CACHE_NAMESPACE;
}

export function getSteamProfileDataCacheSize(accountId?: string): number {
  return getExternalDataCacheSize(steamProfileCacheNamespace(accountId));
}

export function clearSteamProfileDataCache(accountId?: string): void {
  clearExternalDataCacheNamespace(steamProfileCacheNamespace(accountId));
}

export function getOrCreateCachedSteamProfileData<T>(
  accountId: string,
  key: string,
  read: () => Promise<T>,
  options: SteamProfileCacheOptions = {},
): Promise<T> {
  return getOrCreateCachedExternalData({
    forceRefresh: options.forceRefresh,
    key,
    maxEntries: STEAM_PROFILE_DATA_CACHE_MAX_ENTRIES,
    namespace: steamProfileCacheNamespace(accountId),
    now: options.now,
    read,
    ttlMs: STEAM_PROFILE_DATA_CACHE_TTL_MS,
  });
}
