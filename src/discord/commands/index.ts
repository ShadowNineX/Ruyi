import type { Message } from "discord.js";
import { handlePing } from "./ping";

type MessageCommandHandler = (message: Message) => Promise<boolean>;

const messageCommands: MessageCommandHandler[] = [handlePing];

export async function handleCommands(message: Message): Promise<boolean> {
  for (const handler of messageCommands) {
    if (await handler(message)) return true;
  }
  return false;
}
