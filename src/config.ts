import { getConfigValue, setConfigValue } from "./db/models";

const DEFAULT_PREFIX = "!";

export class ConfigManager {
  private cachedPrefix = DEFAULT_PREFIX;

  async load(): Promise<void> {
    this.cachedPrefix = await getConfigValue("prefix", DEFAULT_PREFIX);
  }

  getPrefix(): string {
    return this.cachedPrefix;
  }

  async setPrefix(prefix: string): Promise<void> {
    this.cachedPrefix = prefix;
    await setConfigValue("prefix", prefix);
  }
}

export const configManager = new ConfigManager();
