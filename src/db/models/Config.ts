import mongoose, { Schema, type Document } from "mongoose";

export interface IConfig extends Document {
  key: string;
  value: string;
}

const ConfigSchema = new Schema<IConfig>({
  key: { type: String, required: true, unique: true },
  value: { type: String, required: true },
});

export const Config = mongoose.model<IConfig>("Config", ConfigSchema);

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
