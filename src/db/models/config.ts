import mongoose, { Schema, type Document } from "mongoose";

interface IConfig extends Document {
  key: string;
  value: string;
}

interface ConfigEntry {
  key: string;
  value: string;
}

const ConfigSchema = new Schema<IConfig>({
  key: { type: String, required: true, unique: true },
  value: { type: String, required: true },
});

const Config = mongoose.model<IConfig>("Config", ConfigSchema);

export async function getConfigValue(
  key: string,
  defaultValue: string,
): Promise<string> {
  const config = await Config.findOne({ key });
  return config?.value ?? defaultValue;
}

export async function setConfigValue(key: string, value: string): Promise<void> {
  await Config.updateOne({ key }, { key, value }, { upsert: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

export async function getConfigValuesByPrefix(
  prefix: string,
): Promise<ConfigEntry[]> {
  const configs = await Config.find(
    { key: { $regex: `^${escapeRegExp(prefix)}` } },
    { key: 1, value: 1, _id: 0 },
  ).lean();

  return configs.map((config) => ({
    key: config.key,
    value: config.value,
  }));
}
