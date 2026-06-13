import {
  guildConfigScope,
  userConfigScope,
  type ConfigScope,
} from "../config";
import { toolContextManager } from "./types";

export function getCurrentToolConfigScope(): ConfigScope | null {
  const { message, guild } = toolContextManager.get();

  if (message) {
    return userConfigScope(message.guild?.id ?? null, message.author.id);
  }

  if (guild) {
    return guildConfigScope(guild.id);
  }

  return null;
}
