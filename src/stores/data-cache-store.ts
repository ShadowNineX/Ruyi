import { createStore } from '@tanstack/store';

interface ExternalDataCacheEntry {
  expiresAt: number;
  promise: Promise<unknown>;
}

interface ExternalDataCacheStoreState {
  cachesByNamespace: Map<string, Map<string, ExternalDataCacheEntry>>;
}

interface CachedExternalDataOptions<T> {
  forceRefresh?: boolean;
  key: string;
  maxEntries: number;
  namespace: string;
  now?: number;
  read: () => Promise<T> | T;
  ttlMs: number;
}

const externalDataCacheStore = createStore<ExternalDataCacheStoreState>({
  cachesByNamespace: new Map(),
});

function getNamespaceCache(
  namespace: string,
): Map<string, ExternalDataCacheEntry> {
  return externalDataCacheStore.state.cachesByNamespace.get(namespace) ?? new Map();
}

function updateNamespaceCache(
  namespace: string,
  update: (
    cache: Map<string, ExternalDataCacheEntry>,
  ) => Map<string, ExternalDataCacheEntry>,
): void {
  externalDataCacheStore.setState((state) => {
    const cachesByNamespace = new Map(state.cachesByNamespace);
    const currentCache = cachesByNamespace.get(namespace) ?? new Map();
    const nextCache = update(new Map(currentCache));

    if (nextCache.size === 0) {
      cachesByNamespace.delete(namespace);
    } else {
      cachesByNamespace.set(namespace, nextCache);
    }

    return { ...state, cachesByNamespace };
  });
}

function pruneCache(
  cache: Map<string, ExternalDataCacheEntry>,
  now: number,
  maxEntries: number,
): Map<string, ExternalDataCacheEntry> {
  const pruned = new Map(
    [...cache].filter(([, entry]) => entry.expiresAt > now),
  );

  while (pruned.size >= maxEntries && pruned.size > 0) {
    const oldestKey = pruned.keys().next().value;
    if (typeof oldestKey !== 'string') { break; }
    pruned.delete(oldestKey);
  }

  return pruned;
}

export function getExternalDataCacheSize(namespace?: string): number {
  const now = Date.now();
  if (namespace) {
    return [...getNamespaceCache(namespace).values()].filter(
      entry => entry.expiresAt > now,
    ).length;
  }

  return [...externalDataCacheStore.state.cachesByNamespace.values()].reduce(
    (total, cache) =>
      total + [...cache.values()].filter(entry => entry.expiresAt > now).length,
    0,
  );
}

export function clearExternalDataCacheNamespace(namespace: string): void {
  externalDataCacheStore.setState((state) => {
    const cachesByNamespace = new Map(state.cachesByNamespace);
    cachesByNamespace.delete(namespace);
    return { ...state, cachesByNamespace };
  });
}

export function clearExternalDataCache(): void {
  externalDataCacheStore.setState(state => ({
    ...state,
    cachesByNamespace: new Map(),
  }));
}

export function deleteCachedExternalData(
  namespace: string,
  key: string,
): void {
  updateNamespaceCache(namespace, (cache) => {
    cache.delete(key);
    return cache;
  });
}

export function getOrCreateCachedExternalData<T>({
  forceRefresh = false,
  key,
  maxEntries,
  namespace,
  now = Date.now(),
  read,
  ttlMs,
}: CachedExternalDataOptions<T>): Promise<T> {
  const entry = getNamespaceCache(namespace).get(key);
  if (!forceRefresh && entry && entry.expiresAt > now) {
    return entry.promise as Promise<T>;
  }

  const guarded = Promise.resolve()
    .then(read)
    .catch((error: unknown) => {
      const current = getNamespaceCache(namespace).get(key);
      if (current?.promise === guarded) {
        deleteCachedExternalData(namespace, key);
      }
      throw error;
    });

  updateNamespaceCache(namespace, (cache) => {
    const nextCache = pruneCache(cache, now, maxEntries);
    nextCache.set(key, {
      expiresAt: now + ttlMs,
      promise: guarded,
    });
    return nextCache;
  });

  return guarded;
}
