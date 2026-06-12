import { getConfigValue, setConfigValue } from "./db/models";

const DEFAULT_PREFIX = "!";
const DEFAULT_SEARCH_PROVIDER = "openai";
const PREFIX_CONFIG_KEY = "prefix";
const SEARCH_PROVIDER_CONFIG_KEY = "search:primary_provider";

export const SEARCH_PROVIDERS = ["openai", "tavily"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

function parseSearchProvider(value: string): SearchProvider {
  return SEARCH_PROVIDERS.includes(value as SearchProvider)
    ? (value as SearchProvider)
    : DEFAULT_SEARCH_PROVIDER;
}

export class ConfigManager {
  private cachedPrefix = DEFAULT_PREFIX;
  private cachedSearchProvider: SearchProvider = DEFAULT_SEARCH_PROVIDER;

  async load(): Promise<void> {
    const [prefix, searchProvider] = await Promise.all([
      getConfigValue(PREFIX_CONFIG_KEY, DEFAULT_PREFIX),
      getConfigValue(SEARCH_PROVIDER_CONFIG_KEY, DEFAULT_SEARCH_PROVIDER),
    ]);

    this.cachedPrefix = prefix;
    this.cachedSearchProvider = parseSearchProvider(searchProvider);
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
}

export const configManager = new ConfigManager();
