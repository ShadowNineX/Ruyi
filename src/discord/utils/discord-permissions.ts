import type {
  Guild,
  GuildMember,
  PermissionResolvable,
  TextBasedChannel,
} from 'discord.js';
import { toolLogger } from '../../logger';
import { toolContextManager } from '../../utils/types';

async function fetchRequesterGuildMember(guild: Guild): Promise<GuildMember | null> {
  const requesterId = toolContextManager.get().message?.author.id;
  if (!requesterId) { return null; }

  const member = await guild.members.fetch(requesterId).catch((error: unknown) => {
    toolLogger.debug(
      {
        requesterId,
        error: error instanceof Error ? error.message : String(error),
      },
      'Could not fetch requester member for permission check',
    );
    return null;
  });

  return member;
}

export async function requesterHasGuildPermission(
  guild: Guild,
  permission: PermissionResolvable,
): Promise<boolean> {
  const member = await fetchRequesterGuildMember(guild);
  return member?.permissions.has(permission) ?? false;
}

export function requesterHasChannelPermission(
  channel: TextBasedChannel | null,
  permission: PermissionResolvable,
): boolean {
  const { guild, message } = toolContextManager.get();
  if (!guild) { return true; }
  if (!message || !channel || !('permissionsFor' in channel)) { return false; }

  return channel.permissionsFor(message.author)?.has(permission) ?? false;
}
