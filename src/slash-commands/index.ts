import type { ChatInputCommandInteraction } from "discord.js";
import { prefixCommand, handlePrefixCommand } from "./prefix";
import { smitheryCommand, handleSmitheryCommand } from "./smithery";
import { memoriesCommand, handleMemoriesCommand } from "./memories";
import { creditsCommand, handleCreditsCommand } from "./credits";

export const slashCommands = [
  prefixCommand,
  creditsCommand,
  smitheryCommand,
  memoriesCommand,
];

export {
  handleSmitherySelect,
  handleSmitheryUnlinkSelect,
  handleSmitheryCheckButton,
} from "./smithery";

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  switch (interaction.commandName) {
    case "prefix":
      await handlePrefixCommand(interaction);
      break;
    case "credits":
      await handleCreditsCommand(interaction);
      break;
    case "smithery":
      await handleSmitheryCommand(interaction);
      break;
    case "memories":
      await handleMemoriesCommand(interaction);
      break;
  }
}
