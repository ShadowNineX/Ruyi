import type { AiModelPresetId, SearchProvider } from '../config';
import { createStore } from '@tanstack/store';

export interface ScopedSettings {
  prefix: string;
  searchProvider: SearchProvider;
  modelPreset: AiModelPresetId;
  awayScopeEnabled: boolean;
  awayDelayMinutes: number;
  awayCooldownHours: number;
}

interface ConfigStoreState {
  scopedSettings: Map<string, ScopedSettings>;
  awayUserEnabled: Map<string, boolean>;
  awayLastSentAt: Map<string, number>;
}

const configStore = createStore<ConfigStoreState>({
  scopedSettings: new Map(),
  awayUserEnabled: new Map(),
  awayLastSentAt: new Map(),
});

export function resetConfigStore(): void {
  configStore.setState(() => ({
    scopedSettings: new Map(),
    awayUserEnabled: new Map(),
    awayLastSentAt: new Map(),
  }));
}

export function getScopedSettingsCache(
  key: string,
): ScopedSettings | undefined {
  return configStore.state.scopedSettings.get(key);
}

export function updateScopedSettingsCache(
  key: string,
  defaults: ScopedSettings,
  updater: (settings: ScopedSettings) => ScopedSettings,
): ScopedSettings {
  let nextSettings = defaults;
  configStore.setState((state) => {
    const scopedSettings = new Map(state.scopedSettings);
    const current = scopedSettings.get(key) ?? defaults;
    nextSettings = updater({ ...current });
    scopedSettings.set(key, nextSettings);
    return { ...state, scopedSettings };
  });
  return nextSettings;
}

export function getAwayUserEnabledCache(key: string): boolean | undefined {
  return configStore.state.awayUserEnabled.get(key);
}

export function setAwayUserEnabledCache(key: string, enabled: boolean): void {
  configStore.setState((state) => {
    const awayUserEnabled = new Map(state.awayUserEnabled);
    awayUserEnabled.set(key, enabled);
    return { ...state, awayUserEnabled };
  });
}

export function getAwayLastSentAtCache(key: string): number | undefined {
  return configStore.state.awayLastSentAt.get(key);
}

export function setAwayLastSentAtCache(key: string, timestamp: number): void {
  configStore.setState((state) => {
    const awayLastSentAt = new Map(state.awayLastSentAt);
    awayLastSentAt.set(key, timestamp);
    return { ...state, awayLastSentAt };
  });
}
