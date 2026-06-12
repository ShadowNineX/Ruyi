import {
  ActionRowBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  configManager,
  SEARCH_PROVIDERS,
  type SearchProvider,
} from "../config";
import { botLogger } from "../logger";

const SEARCH_PROVIDER_SELECT_ID = "search_provider_select";

const SEARCH_PROVIDER_LABELS: Record<SearchProvider, string> = {
  openai: "OpenAI Web Search",
  tavily: "Tavily",
};

const SEARCH_PROVIDER_DESCRIPTIONS: Record<SearchProvider, string> = {
  openai: "Best default answer engine for current information.",
  tavily: "Best retrieval engine for source-heavy research.",
};

export const searchProviderCommand = new SlashCommandBuilder()
  .setName("search-provider")
  .setDescription("Choose the primary web search provider")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

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

function buildProviderRow(): ActionRowBuilder<StringSelectMenuBuilder> {
  const currentProvider = configManager.getSearchProvider();
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(SEARCH_PROVIDER_SELECT_ID)
      .setPlaceholder("Choose primary search provider")
      .addOptions(
        SEARCH_PROVIDERS.map((provider) =>
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
  const currentProvider = configManager.getSearchProvider();
  await interaction.reply({
    content: `Current primary search provider: **${formatProvider(currentProvider)}**`,
    components: [buildProviderRow()],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleSearchProviderSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (interaction.customId !== SEARCH_PROVIDER_SELECT_ID) return;

  const selectedValue = interaction.values[0];
  if (!selectedValue || !isSearchProvider(selectedValue)) {
    await interaction.update({
      content: "Invalid search provider selected.",
      components: [],
    });
    return;
  }

  const oldProvider = configManager.getSearchProvider();
  await configManager.setSearchProvider(selectedValue);

  botLogger.info(
    {
      oldProvider,
      newProvider: selectedValue,
      user: interaction.user.username,
    },
    "Search provider changed",
  );

  await interaction.update({
    content: `Primary search provider changed from **${formatProvider(oldProvider)}** to **${formatProvider(selectedValue)}**.`,
    components: [buildProviderRow()],
  });
}

export function isSearchProviderSelect(customId: string): boolean {
  return customId === SEARCH_PROVIDER_SELECT_ID;
}
