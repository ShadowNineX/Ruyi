import {
  getDefaultModelSettings,
  type ModelSettings,
} from "@openai/agents";
import { getConfigValue, setConfigValue } from "./db/models";
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
const DEFAULT_AWAY_GLOBAL_ENABLED = true;
const PREFIX_CONFIG_KEY = "prefix";
const SEARCH_PROVIDER_CONFIG_KEY = "search:primary_provider";
export const AI_MODEL_PRESET_CONFIG_KEY = "ai:model_preset";
export const AWAY_GLOBAL_ENABLED_CONFIG_KEY = "away:global_enabled";
export const AWAY_DELAY_MINUTES_CONFIG_KEY = "away:delay_minutes";
export const AWAY_COOLDOWN_HOURS_CONFIG_KEY = "away:cooldown_hours";

export const SEARCH_PROVIDERS = ["openai", "tavily"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

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

export interface AwayMessageSettings {
  globalEnabled: boolean;
  delayMinutes: number;
  cooldownHours: number;
  delayMs: number;
  cooldownMs: number;
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

export function isAiModelPresetId(value: string): value is AiModelPresetId {
  return AI_MODEL_PRESETS.some((preset) => preset.id === value);
}

function parseAiModelPreset(value: string): AiModelPresetId {
  return isAiModelPresetId(value) ? value : DEFAULT_AI_MODEL_PRESET;
}

export function getAiModelPresetById(id: AiModelPresetId): AiModelPreset {
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

export class ConfigManager {
  private cachedPrefix = DEFAULT_PREFIX;
  private cachedSearchProvider: SearchProvider = DEFAULT_SEARCH_PROVIDER;
  private cachedModelPreset: AiModelPresetId = DEFAULT_AI_MODEL_PRESET;
  private cachedAwayGlobalEnabled = DEFAULT_AWAY_GLOBAL_ENABLED;
  private cachedAwayDelayMinutes = AWAY_MESSAGE_DEFAULT_DELAY_MINUTES;
  private cachedAwayCooldownHours = AWAY_MESSAGE_DEFAULT_COOLDOWN_HOURS;

  async load(): Promise<void> {
    const [
      prefix,
      searchProvider,
      modelPreset,
      awayGlobalEnabled,
      awayDelayMinutes,
      awayCooldownHours,
    ] = await Promise.all([
      getConfigValue(PREFIX_CONFIG_KEY, DEFAULT_PREFIX),
      getConfigValue(SEARCH_PROVIDER_CONFIG_KEY, DEFAULT_SEARCH_PROVIDER),
      getConfigValue(AI_MODEL_PRESET_CONFIG_KEY, DEFAULT_AI_MODEL_PRESET),
      getConfigValue(
        AWAY_GLOBAL_ENABLED_CONFIG_KEY,
        String(DEFAULT_AWAY_GLOBAL_ENABLED),
      ),
      getConfigValue(
        AWAY_DELAY_MINUTES_CONFIG_KEY,
        String(AWAY_MESSAGE_DEFAULT_DELAY_MINUTES),
      ),
      getConfigValue(
        AWAY_COOLDOWN_HOURS_CONFIG_KEY,
        String(AWAY_MESSAGE_DEFAULT_COOLDOWN_HOURS),
      ),
    ]);

    this.cachedPrefix = prefix;
    this.cachedSearchProvider = parseSearchProvider(searchProvider);
    this.cachedModelPreset = parseAiModelPreset(modelPreset);
    this.cachedAwayGlobalEnabled = parseBoolean(
      awayGlobalEnabled,
      DEFAULT_AWAY_GLOBAL_ENABLED,
    );
    this.cachedAwayDelayMinutes = parseIntegerSetting(
      awayDelayMinutes,
      AWAY_MESSAGE_DEFAULT_DELAY_MINUTES,
      AWAY_MESSAGE_MIN_DELAY_MINUTES,
      AWAY_MESSAGE_MAX_DELAY_MINUTES,
    );
    this.cachedAwayCooldownHours = parseIntegerSetting(
      awayCooldownHours,
      AWAY_MESSAGE_DEFAULT_COOLDOWN_HOURS,
      AWAY_MESSAGE_MIN_COOLDOWN_HOURS,
      AWAY_MESSAGE_MAX_COOLDOWN_HOURS,
    );
  }

  getPrefix(): string {
    return this.cachedPrefix;
  }

  async setPrefix(prefix: string): Promise<void> {
    this.cachedPrefix = prefix;
    await setConfigValue(PREFIX_CONFIG_KEY, prefix);
  }

  getSearchProvider(): SearchProvider {
    return this.cachedSearchProvider;
  }

  async setSearchProvider(provider: SearchProvider): Promise<void> {
    this.cachedSearchProvider = provider;
    await setConfigValue(SEARCH_PROVIDER_CONFIG_KEY, provider);
  }

  getModelPreset(): AiModelPresetId {
    return this.cachedModelPreset;
  }

  getModelConfig(): AiModelPreset {
    return getAiModelPresetById(this.cachedModelPreset);
  }

  getChatModel(): string {
    return this.getModelConfig().model;
  }

  getVisionModel(): string {
    return this.getModelConfig().visionModel;
  }

  getModelSettings(): ModelSettings {
    return buildModelSettings(this.getModelConfig());
  }

  async setModelPreset(preset: AiModelPresetId): Promise<void> {
    this.cachedModelPreset = preset;
    await setConfigValue(AI_MODEL_PRESET_CONFIG_KEY, preset);
  }

  getAwaySettings(): AwayMessageSettings {
    return {
      globalEnabled: this.cachedAwayGlobalEnabled,
      delayMinutes: this.cachedAwayDelayMinutes,
      cooldownHours: this.cachedAwayCooldownHours,
      delayMs: this.cachedAwayDelayMinutes * 60 * 1000,
      cooldownMs: this.cachedAwayCooldownHours * 60 * 60 * 1000,
    };
  }

  async setAwayGlobalEnabled(enabled: boolean): Promise<void> {
    this.cachedAwayGlobalEnabled = enabled;
    await setConfigValue(AWAY_GLOBAL_ENABLED_CONFIG_KEY, String(enabled));
  }

  async setAwayTiming(
    delayMinutes: number,
    cooldownHours: number,
  ): Promise<void> {
    this.cachedAwayDelayMinutes = clampNumber(
      delayMinutes,
      AWAY_MESSAGE_MIN_DELAY_MINUTES,
      AWAY_MESSAGE_MAX_DELAY_MINUTES,
    );
    this.cachedAwayCooldownHours = clampNumber(
      cooldownHours,
      AWAY_MESSAGE_MIN_COOLDOWN_HOURS,
      AWAY_MESSAGE_MAX_COOLDOWN_HOURS,
    );
    await Promise.all([
      setConfigValue(
        AWAY_DELAY_MINUTES_CONFIG_KEY,
        String(this.cachedAwayDelayMinutes),
      ),
      setConfigValue(
        AWAY_COOLDOWN_HOURS_CONFIG_KEY,
        String(this.cachedAwayCooldownHours),
      ),
    ]);
  }

  private awayUserEnabledKey(userId: string): string {
    return `away:user:${userId}:enabled`;
  }

  private awayUserLastSentKey(userId: string): string {
    return `away:user:${userId}:last_sent_at`;
  }

  async isAwayEnabledForUser(userId: string): Promise<boolean> {
    const value = await getConfigValue(this.awayUserEnabledKey(userId), "false");
    return parseBoolean(value, false);
  }

  async setAwayUserEnabled(userId: string, enabled: boolean): Promise<void> {
    await setConfigValue(this.awayUserEnabledKey(userId), String(enabled));
  }

  async getAwayLastSentAt(userId: string): Promise<number | null> {
    const value = await getConfigValue(this.awayUserLastSentKey(userId), "");
    const timestamp = Number.parseInt(value, 10);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  }

  async setAwayLastSentAt(userId: string, timestamp: number): Promise<void> {
    await setConfigValue(this.awayUserLastSentKey(userId), String(timestamp));
  }
}

export const configManager = new ConfigManager();
