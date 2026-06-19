import type { ChatInputCommandInteraction } from 'discord.js';
import { awayCommand, handleAwayCommand } from './away';
import { creditsCommand, handleCreditsCommand } from './credits';
import { handleInfoCommand, infoCommand } from './info';
import { handleMemoriesCommand, memoriesCommand } from './memories';
import { handleModelCommand, modelCommand } from './model';
import { handlePrefixCommand, prefixCommand } from './prefix';
import {
  cancelReminderCommand,
  handleCancelReminderCommand,
  handleRemindCommand,
  handleReminderAutocomplete,
  handleTimersCommand,
  remindCommand,
  timersCommand,
} from './reminders';
import {
  handleScrapeCreatorsCommand,
  scrapeCreatorsCommand,
} from './scrapecreators';
import {
  handleSearchProviderCommand,
  searchProviderCommand,
} from './search-provider';
import { handleSmitheryCommand, smitheryCommand } from './smithery';

export const slashCommands = [
  infoCommand,
  prefixCommand,
  modelCommand,
  searchProviderCommand,
  creditsCommand,
  scrapeCreatorsCommand,
  awayCommand,
  remindCommand,
  timersCommand,
  cancelReminderCommand,
  smitheryCommand,
  memoriesCommand,
];

export {
  handleMemoriesButton,
  handleMemoriesModal,
  isMemoriesButton,
  isMemoriesModal,
} from './memories';

export { handleModelSelect, isModelSelect } from './model';

export {
  handleSearchProviderSelect,
  isSearchProviderSelect,
} from './search-provider';

export {
  handleSmitheryCheckButton,
  handleSmitherySelect,
  handleSmitheryUnlinkSelect,
} from './smithery';

export { handleReminderAutocomplete };

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  switch (interaction.commandName) {
    case 'info':
      await handleInfoCommand(interaction);
      break;
    case 'prefix':
      await handlePrefixCommand(interaction);
      break;
    case 'search-provider':
      await handleSearchProviderCommand(interaction);
      break;
    case 'model':
      await handleModelCommand(interaction);
      break;
    case 'credits':
      await handleCreditsCommand(interaction);
      break;
    case 'scrapecreators':
      await handleScrapeCreatorsCommand(interaction);
      break;
    case 'away':
      await handleAwayCommand(interaction);
      break;
    case 'remind':
      await handleRemindCommand(interaction);
      break;
    case 'timers':
      await handleTimersCommand(interaction);
      break;
    case 'cancel-reminder':
      await handleCancelReminderCommand(interaction);
      break;
    case 'smithery':
      await handleSmitheryCommand(interaction);
      break;
    case 'memories':
      await handleMemoriesCommand(interaction);
      break;
  }
}
