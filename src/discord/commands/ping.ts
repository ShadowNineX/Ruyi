import type { Message } from 'discord.js';
import { configManager, userConfigScope } from '../../config';
import { botLogger } from '../../logger';

export async function handlePing(message: Message): Promise<boolean> {
  const scope = userConfigScope(message.guild?.id ?? null, message.author.id);
  if (message.content !== `${configManager.getPrefix(scope)}ping`) { return false; }

  botLogger.debug({ user: message.author.username }, 'Ping command');
  await message.reply('Pong!');
  return true;
}
