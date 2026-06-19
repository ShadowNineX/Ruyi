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

export function getSteamProfileDataCacheSize(): number {
  return getExternalDataCacheSize(STEAM_PROFILE_CACHE_NAMESPACE);
}

export function clearSteamProfileDataCache(): void {
  clearExternalDataCacheNamespace(STEAM_PROFILE_CACHE_NAMESPACE);
}

export function getOrCreateCachedSteamProfileData<T>(
  key: string,
  read: () => Promise<T>,
  options: SteamProfileCacheOptions = {},
): Promise<T> {
  return getOrCreateCachedExternalData({
    forceRefresh: options.forceRefresh,
    key,
    maxEntries: STEAM_PROFILE_DATA_CACHE_MAX_ENTRIES,
    namespace: STEAM_PROFILE_CACHE_NAMESPACE,
    now: options.now,
    read,
    ttlMs: STEAM_PROFILE_DATA_CACHE_TTL_MS,
  });
}
