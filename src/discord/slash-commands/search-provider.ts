import type { ChatInputCommandInteraction, StringSelectMenuInteraction } from 'discord.js';
import type { ConfigScope, SearchProvider } from '../../config';
import {
  ActionRowBuilder,

  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,

  StringSelectMenuOptionBuilder,
} from 'discord.js';
import {
  configManager,

  formatConfigScope,
  SEARCH_PROVIDERS,

  userConfigScope,
} from '../../config';
import { botLogger } from '../../logger';

const SEARCH_PROVIDER_SELECT_ID = 'search_provider_select';

const SEARCH_PROVIDER_LABELS: Record<SearchProvider, string> = {
  openai: 'OpenAI Web Search',
  tavily: 'Tavily',
};

const SEARCH_PROVIDER_DESCRIPTIONS: Record<SearchProvider, string> = {
  openai: 'Best default answer engine for current information.',
  tavily: 'Best retrieval engine for source-heavy research.',
};

export const searchProviderCommand = new SlashCommandBuilder()
  .setName('search-provider')
  .setDescription('Choose the primary web search provider');

function canManageScope(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  scope: ConfigScope,
): boolean {
  return (
    scope.kind === 'discord:dm'
    || (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      ?? false)
  );
}

function isSearchProvider(value: string): value is SearchProvider {
  return SEARCH_PROVIDERS.includes(value as SearchProvider);
}

function buildProviderOption(
  provider: SearchProvider,
  currentProvider: SearchProvider,
): StringSelectMenuOptionBuilder {
  return new StringSelectMenuOptionBuilder()
    .setLabel(SEARCH_PROVIDER_LABELS[provider])
    .setDescription(SEARCH_PROVIDER_DESCRIPTIONS[provider])
    .setValue(provider)
    .setDefault(provider === currentProvider);
}

function buildProviderRow(
  scope: ConfigScope,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const currentProvider = configManager.getSearchProvider(scope);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(SEARCH_PROVIDER_SELECT_ID)
      .setPlaceholder('Choose primary search provider')
      .addOptions(
        SEARCH_PROVIDERS.map(provider =>
          buildProviderOption(provider, currentProvider),
        ),
      ),
  );
}

function formatProvider(provider: SearchProvider): string {
  return SEARCH_PROVIDER_LABELS[provider];
}

export async function handleSearchProviderCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const scope = userConfigScope(interaction.guildId, interaction.user.id);
  if (!canManageScope(interaction, scope)) {
    await interaction.reply({
      content:
        'You need **Manage Server** to change this server\'s search provider.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const currentProvider = configManager.getSearchProvider(scope);
  await interaction.reply({
    content: `Current primary search provider for ${formatConfigScope(scope)}: **${formatProvider(currentProvider)}**`,
    components: [buildProviderRow(scope)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleSearchProviderSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (interaction.customId !== SEARCH_PROVIDER_SELECT_ID) { return; }
  const scope = userConfigScope(interaction.guildId, interaction.user.id);
  if (!canManageScope(interaction, scope)) {
    await interaction.update({
      content:
        'You need **Manage Server** to change this server\'s search provider.',
      components: [],
    });
    return;
  }

  const selectedValue = interaction.values[0];
  if (!selectedValue || !isSearchProvider(selectedValue)) {
    await interaction.update({
      content: 'Invalid search provider selected.',
      components: [],
    });
    return;
  }

  const oldProvider = configManager.getSearchProvider(scope);
  await configManager.setSearchProvider(scope, selectedValue);

  botLogger.info(
    {
      scope: scope.kind,
      scopeId: scope.id,
      oldProvider,
      newProvider: selectedValue,
      user: interaction.user.username,
    },
    'Search provider changed',
  );

  await interaction.update({
    content: `Primary search provider for ${formatConfigScope(scope)} changed from **${formatProvider(oldProvider)}** to **${formatProvider(selectedValue)}**.`,
    components: [buildProviderRow(scope)],
  });
}

export function isSearchProviderSelect(customId: string): boolean {
  return customId === SEARCH_PROVIDER_SELECT_ID;
}
