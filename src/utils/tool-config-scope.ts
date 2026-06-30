import type { ConfigScope } from '../config';
import {

  guildConfigScope,
  userConfigScope,
} from '../config';
import { toolContextManager } from './types';

export function getCurrentToolConfigScope(): ConfigScope | null {
  const ctx = toolContextManager.get();

  if (ctx.message) {
    return userConfigScope(ctx.message.guild?.id ?? null, ctx.message.author.id);
  }

  if (ctx.guild) {
    return guildConfigScope(ctx.guild.id);
  }

  return null;
}
