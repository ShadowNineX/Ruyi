import type { ChatInputCommandInteraction } from "discord.js";
import { prefixCommand, handlePrefixCommand } from "./prefix";
import { smitheryCommand, handleSmitheryCommand } from "./smithery";
import { memoriesCommand, handleMemoriesCommand } from "./memories";
import { creditsCommand, handleCreditsCommand } from "./credits";
import { awayCommand, handleAwayCommand } from "./away";
import {
  modelCommand,
  handleModelCommand,
  handleModelSelect,
  isModelSelect,
} from "./model";
import {
  searchProviderCommand,
  handleSearchProviderCommand,
  handleSearchProviderSelect,
  isSearchProviderSelect,
} from "./search-provider";

export const slashCommands = [
  prefixCommand,
  modelCommand,
  searchProviderCommand,
  creditsCommand,
  awayCommand,
  smitheryCommand,
  memoriesCommand,
];

export {
  handleSmitherySelect,
  handleSmitheryUnlinkSelect,
  handleSmitheryCheckButton,
} from "./smithery";

export {
  handleSearchProviderSelect,
  isSearchProviderSelect,
} from "./search-provider";

export { handleModelSelect, isModelSelect } from "./model";

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  switch (interaction.commandName) {
    case "prefix":
      await handlePrefixCommand(interaction);
      break;
    case "search-provider":
      await handleSearchProviderCommand(interaction);
      break;
    case "model":
      await handleModelCommand(interaction);
      break;
    case "credits":
      await handleCreditsCommand(interaction);
      break;
    case "away":
      await handleAwayCommand(interaction);
      break;
    case "smithery":
      await handleSmitheryCommand(interaction);
      break;
    case "memories":
      await handleMemoriesCommand(interaction);
      break;
  }
}
