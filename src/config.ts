import {
  getDefaultModelSettings,
  type ModelSettings,
} from "@openai/agents";
import {
  getConfigValue,
  getConfigValuesByPrefix,
  setConfigValue,
} from "./db/models";
import {
  AWAY_MESSAGE_DEFAULT_COOLDOWN_HOURS,
  AWAY_MESSAGE_DEFAULT_DELAY_MINUTES,
  AWAY_MESSAGE_MAX_COOLDOWN_HOURS,
  AWAY_MESSAGE_MAX_DELAY_MINUTES,
  AWAY_MESSAGE_MIN_COOLDOWN_HOURS,
  AWAY_MESSAGE_MIN_DELAY_MINUTES,
} from "./constants";

const DEFAULT_PREFIX = "!";
const DEFAULT_SEARCH_PROVIDER = "openai";
const DEFAULT_AI_MODEL_PRESET = "balanced";
const DEFAULT_AWAY_SCOPE_ENABLED = true;

const GUILD_CONFIG_PREFIX = "guild:";
const DM_CONFIG_PREFIX = "dm:";
const USER_SEGMENT = "user";
const PREFIX_SETTING = "prefix";
const SEARCH_PROVIDER_SETTING = "search:primary_provider";
const AI_MODEL_PRESET_SETTING = "ai:model_preset";
const AWAY_SCOPE_ENABLED_SETTING = "away:enabled";
const AWAY_DELAY_MINUTES_SETTING = "away:delay_minutes";
const AWAY_COOLDOWN_HOURS_SETTING = "away:cooldown_hours";
const AWAY_USER_ENABLED_SETTING = "away:enabled";
const AWAY_USER_LAST_SENT_SETTING = "away:last_sent_at";

export const SEARCH_PROVIDERS = ["openai", "tavily"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
type ConfigScopeKind = "guild" | "dm";

export interface ConfigScope {
  kind: ConfigScopeKind;
  id: string;
}

type ReasoningEffort = NonNullable<ModelSettings["reasoning"]>["effort"];
type TextVerbosity = NonNullable<ModelSettings["text"]>["verbosity"];

interface AiModelPresetDefinition {
  id: string;
  label: string;
  description: string;
  model: string;
  visionModel: string;
  reasoningEffort: ReasoningEffort;
  textVerbosity: TextVerbosity;
}

interface ScopedSettings {
  prefix: string;
  searchProvider: SearchProvider;
  modelPreset: AiModelPresetId;
  awayScopeEnabled: boolean;
  awayDelayMinutes: number;
  awayCooldownHours: number;
}

interface ParsedScopeConfigKey {
  scope: ConfigScope;
  setting: string;
}

interface ParsedScopeUserConfigKey {
  scope: ConfigScope;
  userId: string;
  setting: string;
}

export const AI_MODEL_PRESETS = [
  {
    id: "fast",
    label: "Instant",
    description: "Fastest replies with GPT-5.4 Mini.",
    model: "gpt-5.4-mini",
    visionModel: "gpt-5.4-mini",
    reasoningEffort: "low",
    textVerbosity: "low",
  },
  {
    id: "medium",
    label: "Medium",
    description: "Efficient GPT-5.5 for everyday chat.",
    model: "gpt-5.5",
    visionModel: "gpt-5.5",
    reasoningEffort: "low",
    textVerbosity: "medium",
  },
  {
    id: "balanced",
    label: "High",
    description: "Recommended GPT-5.5 default for Ruyi.",
    model: "gpt-5.5",
    visionModel: "gpt-5.5",
    reasoningEffort: "medium",
    textVerbosity: "medium",
  },
  {
    id: "smart",
    label: "Extra High",
    description: "Deeper GPT-5.5 reasoning for complex tasks.",
    model: "gpt-5.5",
    visionModel: "gpt-5.5",
    reasoningEffort: "high",
    textVerbosity: "medium",
  },
  {
    id: "deep",
    label: "Pro",
    description: "Highest-intelligence GPT-5.5 Pro reasoning.",
    model: "gpt-5.5-pro",
    visionModel: "gpt-5.5",
    reasoningEffort: "xhigh",
    textVerbosity: "high",
  },
] as const satisfies readonly AiModelPresetDefinition[];

export type AiModelPresetId = (typeof AI_MODEL_PRESETS)[number]["id"];
export type AiModelPreset = (typeof AI_MODEL_PRESETS)[number];

interface AwayMessageSettings {
  scopeEnabled: boolean;
  delayMinutes: number;
  cooldownHours: number;
  delayMs: number;
  cooldownMs: number;
}

export function guildConfigScope(guildId: string): ConfigScope {
  return { kind: "guild", id: guildId };
}

function dmConfigScope(userId: string): ConfigScope {
  return { kind: "dm", id: userId };
}

export function userConfigScope(
  guildId: string | null | undefined,
  userId: string,
): ConfigScope {
  return guildId ? guildConfigScope(guildId) : dmConfigScope(userId);
}

export function configScopeKey(scope: ConfigScope): string {
  return `${scope.kind}:${scope.id}`;
}

export function formatConfigScope(scope: ConfigScope): string {
  return scope.kind === "guild" ? "this server" : "this private chat";
}

function defaultScopedSettings(): ScopedSettings {
  return {
    prefix: DEFAULT_PREFIX,
    searchProvider: DEFAULT_SEARCH_PROVIDER,
    modelPreset: DEFAULT_AI_MODEL_PRESET,
    awayScopeEnabled: DEFAULT_AWAY_SCOPE_ENABLED,
    awayDelayMinutes: AWAY_MESSAGE_DEFAULT_DELAY_MINUTES,
    awayCooldownHours: AWAY_MESSAGE_DEFAULT_COOLDOWN_HOURS,
  };
}

function parseSearchProvider(value: string): SearchProvider {
  return SEARCH_PROVIDERS.includes(value as SearchProvider)
    ? (value as SearchProvider)
    : DEFAULT_SEARCH_PROVIDER;
}

function parseBoolean(value: string, defaultValue: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return defaultValue;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseIntegerSetting(
  value: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? clampNumber(parsed, min, max)
    : defaultValue;
}

function scopedSettingKey(scope: ConfigScope, setting: string): string {
  return `${configScopeKey(scope)}:${setting}`;
}

function scopedUserSettingKey(
  scope: ConfigScope,
  userId: string,
  setting: string,
): string {
  return `${configScopeKey(scope)}:${USER_SEGMENT}:${userId}:${setting}`;
}

function scopedUserCacheKey(scope: ConfigScope, userId: string): string {
  return `${configScopeKey(scope)}:${userId}`;
}

function parseScopeConfigKey(key: string): ParsedScopeConfigKey | null {
  const scope = parseScopePrefix(key);
  if (!scope) return null;

  const parts = key.slice(`${scope.kind}:${scope.id}:`.length).split(":");
  if (parts[0] === USER_SEGMENT) return null;
  return {
    scope,
    setting: parts.join(":"),
  };
}

function parseScopeUserConfigKey(key: string): ParsedScopeUserConfigKey | null {
  const scope = parseScopePrefix(key);
  if (!scope) return null;

  const parts = key.slice(`${scope.kind}:${scope.id}:`.length).split(":");
  const userId = parts[1];
  if (parts[0] !== USER_SEGMENT || !userId) return null;

  return {
    scope,
    userId,
    setting: parts.slice(2).join(":"),
  };
}

function parseScopePrefix(key: string): ConfigScope | null {
  for (const kind of ["guild", "dm"] as const) {
    const prefix = kind === "guild" ? GUILD_CONFIG_PREFIX : DM_CONFIG_PREFIX;
    if (!key.startsWith(prefix)) continue;

    const id = key.slice(prefix.length).split(":")[0];
    return id ? { kind, id } : null;
  }

  return null;
}

export function isAiModelPresetId(value: string): value is AiModelPresetId {
  return AI_MODEL_PRESETS.some((preset) => preset.id === value);
}

function parseAiModelPreset(value: string): AiModelPresetId {
  return isAiModelPresetId(value) ? value : DEFAULT_AI_MODEL_PRESET;
}

function getAiModelPresetById(id: AiModelPresetId): AiModelPreset {
  const preset = AI_MODEL_PRESETS.find((option) => option.id === id);
  const defaultPreset = AI_MODEL_PRESETS.find(
    (option) => option.id === DEFAULT_AI_MODEL_PRESET,
  );
  return preset ?? defaultPreset ?? AI_MODEL_PRESETS[0];
}

function buildModelSettings(preset: AiModelPreset): ModelSettings {
  const defaults = getDefaultModelSettings(preset.model);

  return {
    ...defaults,
    reasoning: {
      ...defaults.reasoning,
      effort: preset.reasoningEffort,
    },
    text: {
      ...defaults.text,
      verbosity: preset.textVerbosity,
    },
  };
}

class ConfigManager {
  private readonly scopedSettings = new Map<string, ScopedSettings>();
  private readonly awayUserEnabled = new Map<string, boolean>();
  private readonly awayLastSentAt = new Map<string, number>();

  async load(): Promise<void> {
    this.scopedSettings.clear();
    this.awayUserEnabled.clear();
    this.awayLastSentAt.clear();

    const entries = (
      await Promise.all([
        getConfigValuesByPrefix(GUILD_CONFIG_PREFIX),
        getConfigValuesByPrefix(DM_CONFIG_PREFIX),
      ])
    ).flat();

    for (const entry of entries) {
      this.loadScopedConfigEntry(entry.key, entry.value);
      this.loadScopedUserConfigEntry(entry.key, entry.value);
    }
  }

  private getScopedSettings(
    scope: ConfigScope | null | undefined,
  ): ScopedSettings {
    if (!scope) return defaultScopedSettings();

    const key = configScopeKey(scope);
    const existing = this.scopedSettings.get(key);
    if (existing) return existing;

    const settings = defaultScopedSettings();
    this.scopedSettings.set(key, settings);
    return settings;
  }

  private loadScopedConfigEntry(key: string, value: string): void {
    const parsed = parseScopeConfigKey(key);
    if (!parsed) return;

    const settings = this.getScopedSettings(parsed.scope);
    switch (parsed.setting) {
      case PREFIX_SETTING:
        settings.prefix = value || DEFAULT_PREFIX;
        break;
      case SEARCH_PROVIDER_SETTING:
        settings.searchProvider = parseSearchProvider(value);
        break;
      case AI_MODEL_PRESET_SETTING:
        settings.modelPreset = parseAiModelPreset(value);
        break;
      case AWAY_SCOPE_ENABLED_SETTING:
        settings.awayScopeEnabled = parseBoolean(
          value,
          DEFAULT_AWAY_SCOPE_ENABLED,
        );
        break;
      case AWAY_DELAY_MINUTES_SETTING:
        settings.awayDelayMinutes = parseIntegerSetting(
          value,
          AWAY_MESSAGE_DEFAULT_DELAY_MINUTES,
          AWAY_MESSAGE_MIN_DELAY_MINUTES,
          AWAY_MESSAGE_MAX_DELAY_MINUTES,
        );
        break;
      case AWAY_COOLDOWN_HOURS_SETTING:
        settings.awayCooldownHours = parseIntegerSetting(
          value,
          AWAY_MESSAGE_DEFAULT_COOLDOWN_HOURS,
          AWAY_MESSAGE_MIN_COOLDOWN_HOURS,
          AWAY_MESSAGE_MAX_COOLDOWN_HOURS,
        );
        break;
    }
  }

  private loadScopedUserConfigEntry(key: string, value: string): void {
    const parsed = parseScopeUserConfigKey(key);
    if (!parsed) return;

    const cacheKey = scopedUserCacheKey(parsed.scope, parsed.userId);
    switch (parsed.setting) {
      case AWAY_USER_ENABLED_SETTING:
        this.awayUserEnabled.set(cacheKey, parseBoolean(value, false));
        break;
      case AWAY_USER_LAST_SENT_SETTING: {
        const timestamp = Number.parseInt(value, 10);
        if (Number.isFinite(timestamp) && timestamp > 0) {
          this.awayLastSentAt.set(cacheKey, timestamp);
        }
        break;
      }
    }
  }

  getPrefix(scope: ConfigScope | null | undefined): string {
    return this.getScopedSettings(scope).prefix;
  }

  async setPrefix(scope: ConfigScope, prefix: string): Promise<void> {
    this.getScopedSettings(scope).prefix = prefix;
    await setConfigValue(scopedSettingKey(scope, PREFIX_SETTING), prefix);
  }

  getSearchProvider(scope: ConfigScope | null | undefined): SearchProvider {
    return this.getScopedSettings(scope).searchProvider;
  }

  async setSearchProvider(
    scope: ConfigScope,
    provider: SearchProvider,
  ): Promise<void> {
    this.getScopedSettings(scope).searchProvider = provider;
    await setConfigValue(scopedSettingKey(scope, SEARCH_PROVIDER_SETTING), provider);
  }

  getModelPreset(scope: ConfigScope | null | undefined): AiModelPresetId {
    return this.getScopedSettings(scope).modelPreset;
  }

  getModelConfig(scope: ConfigScope | null | undefined): AiModelPreset {
    return getAiModelPresetById(this.getModelPreset(scope));
  }

  getChatModel(scope: ConfigScope | null | undefined): string {
    return this.getModelConfig(scope).model;
  }

  getVisionModel(scope: ConfigScope | null | undefined): string {
    return this.getModelConfig(scope).visionModel;
  }

  getModelSettings(scope: ConfigScope | null | undefined): ModelSettings {
    return buildModelSettings(this.getModelConfig(scope));
  }

  async setModelPreset(
    scope: ConfigScope,
    preset: AiModelPresetId,
  ): Promise<void> {
    this.getScopedSettings(scope).modelPreset = preset;
    await setConfigValue(scopedSettingKey(scope, AI_MODEL_PRESET_SETTING), preset);
  }

  getAwaySettings(scope: ConfigScope | null | undefined): AwayMessageSettings {
    const settings = this.getScopedSettings(scope);
    return {
      scopeEnabled: settings.awayScopeEnabled,
      delayMinutes: settings.awayDelayMinutes,
      cooldownHours: settings.awayCooldownHours,
      delayMs: settings.awayDelayMinutes * 60 * 1000,
      cooldownMs: settings.awayCooldownHours * 60 * 60 * 1000,
    };
  }

  async setAwayScopeEnabled(
    scope: ConfigScope,
    enabled: boolean,
  ): Promise<void> {
    this.getScopedSettings(scope).awayScopeEnabled = enabled;
    await setConfigValue(
      scopedSettingKey(scope, AWAY_SCOPE_ENABLED_SETTING),
      String(enabled),
    );
  }

  async setAwayTiming(
    scope: ConfigScope,
    delayMinutes: number,
    cooldownHours: number,
  ): Promise<void> {
    const settings = this.getScopedSettings(scope);
    settings.awayDelayMinutes = clampNumber(
      delayMinutes,
      AWAY_MESSAGE_MIN_DELAY_MINUTES,
      AWAY_MESSAGE_MAX_DELAY_MINUTES,
    );
    settings.awayCooldownHours = clampNumber(
      cooldownHours,
      AWAY_MESSAGE_MIN_COOLDOWN_HOURS,
      AWAY_MESSAGE_MAX_COOLDOWN_HOURS,
    );
    await Promise.all([
      setConfigValue(
        scopedSettingKey(scope, AWAY_DELAY_MINUTES_SETTING),
        String(settings.awayDelayMinutes),
      ),
      setConfigValue(
        scopedSettingKey(scope, AWAY_COOLDOWN_HOURS_SETTING),
        String(settings.awayCooldownHours),
      ),
    ]);
  }

  async isAwayEnabledForUser(
    scope: ConfigScope,
    userId: string,
  ): Promise<boolean> {
    const cacheKey = scopedUserCacheKey(scope, userId);
    const cached = this.awayUserEnabled.get(cacheKey);
    if (cached !== undefined) return cached;

    const value = await getConfigValue(
      scopedUserSettingKey(scope, userId, AWAY_USER_ENABLED_SETTING),
      "false",
    );
    const enabled = parseBoolean(value, false);
    this.awayUserEnabled.set(cacheKey, enabled);
    return enabled;
  }

  async setAwayUserEnabled(
    scope: ConfigScope,
    userId: string,
    enabled: boolean,
  ): Promise<void> {
    this.awayUserEnabled.set(scopedUserCacheKey(scope, userId), enabled);
    await setConfigValue(
      scopedUserSettingKey(scope, userId, AWAY_USER_ENABLED_SETTING),
      String(enabled),
    );
  }

  async getAwayLastSentAt(
    scope: ConfigScope,
    userId: string,
  ): Promise<number | null> {
    const cacheKey = scopedUserCacheKey(scope, userId);
    const cached = this.awayLastSentAt.get(cacheKey);
    if (cached !== undefined) return cached;

    const value = await getConfigValue(
      scopedUserSettingKey(scope, userId, AWAY_USER_LAST_SENT_SETTING),
      "",
    );
    const timestamp = Number.parseInt(value, 10);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      this.awayLastSentAt.set(cacheKey, timestamp);
      return timestamp;
    }

    return null;
  }

  async setAwayLastSentAt(
    scope: ConfigScope,
    userId: string,
    timestamp: number,
  ): Promise<void> {
    this.awayLastSentAt.set(scopedUserCacheKey(scope, userId), timestamp);
    await setConfigValue(
      scopedUserSettingKey(scope, userId, AWAY_USER_LAST_SENT_SETTING),
      String(timestamp),
    );
  }
}

export const configManager = new ConfigManager();
