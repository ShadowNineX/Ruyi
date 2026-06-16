import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { botLogger } from "../../logger";
import {
  fetchScrapeCreatorsApiUsage,
  fetchScrapeCreatorsCreditBalance,
  fetchScrapeCreatorsDailyUsage,
  hasScrapeCreatorsAccountKey,
  SCRAPECREATORS_DASHBOARD_URL,
  ScrapeCreatorsApiError,
  type ScrapeCreatorsApiUsageEntry,
  type ScrapeCreatorsDailyUsageEntry,
} from "../../services/scrapecreators-account";

const SCRAPECREATORS_COLORS = {
  neutral: 0x5865f2,
  warning: 0xffaa00,
  error: 0xcc3333,
} as const;

const DEFAULT_ENDPOINT_FILTER = "/v1/pinterest";
const RECENT_USAGE_LIMIT = 6;
const DAILY_USAGE_LIMIT = 7;

export const scrapeCreatorsCommand = new SlashCommandBuilder()
  .setName("scrapecreators")
  .setDescription("View ScrapeCreators credits and API usage")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("balance")
      .setDescription("Show ScrapeCreators credit balance"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("usage")
      .setDescription("Show recent ScrapeCreators requests")
      .addStringOption((option) =>
        option
          .setName("endpoint")
          .setDescription("Endpoint filter. Defaults to /v1/pinterest")
          .setMaxLength(120),
      )
      .addIntegerOption((option) =>
        option
          .setName("status_code")
          .setDescription("HTTP status code filter, such as 200 or 500")
          .setMinValue(100)
          .setMaxValue(599),
      )
      .addIntegerOption((option) =>
        option
          .setName("page")
          .setDescription("Request history page, max 100")
          .setMinValue(1)
          .setMaxValue(100),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("daily")
      .setDescription("Show daily ScrapeCreators credit and request counts"),
  );

function buildDashboardButton(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Open ScrapeCreators")
      .setStyle(ButtonStyle.Link)
      .setURL(SCRAPECREATORS_DASHBOARD_URL),
  );
}

function buildBaseEmbed(title: string, color: number): EmbedBuilder {
  return new EmbedBuilder().setTitle(title).setColor(color).setTimestamp();
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDuration(entry: ScrapeCreatorsApiUsageEntry): string {
  if (typeof entry.duration_ms === "number") {
    return `${formatNumber(entry.duration_ms)} ms`;
  }
  if (typeof entry.duration_secs === "number") {
    return `${formatNumber(entry.duration_secs)} sec`;
  }
  return "unknown";
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "unknown";

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;

  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

function truncateFieldValue(value: string, maxLength = 1024): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function formatEndpoint(endpoint: string): string {
  return endpoint.length > 90 ? `${endpoint.slice(0, 87)}...` : endpoint;
}

function formatStatus(entry: ScrapeCreatorsApiUsageEntry): string {
  const status = entry.status_code ? String(entry.status_code) : "unknown";
  if (entry.success === true) return `${status} success`;
  if (entry.success === false) return `${status} failed`;
  return status;
}

function formatUsageLine(entry: ScrapeCreatorsApiUsageEntry): string {
  const method = entry.http_method ?? "GET";
  const credits =
    typeof entry.credits === "number" ? `${formatNumber(entry.credits)} cr` : "? cr";

  return [
    `\`${method} ${formatEndpoint(entry.endpoint)}\``,
    `${formatStatus(entry)} • ${credits} • ${formatDuration(entry)}`,
    formatDateTime(entry.request_time ?? entry.created_at),
  ].join("\n");
}

function buildSetupEmbed(): EmbedBuilder {
  return buildBaseEmbed("ScrapeCreators Unavailable", SCRAPECREATORS_COLORS.warning)
    .setDescription(
      "`SCRAPECREATORS_API_KEY` is not configured, so Ruyi cannot read account usage.",
    )
    .addFields({
      name: "Needed",
      value: "Add your ScrapeCreators API key as `SCRAPECREATORS_API_KEY`.",
    });
}

function buildBalanceEmbed(creditCount: number): EmbedBuilder {
  return buildBaseEmbed("ScrapeCreators Credits", SCRAPECREATORS_COLORS.neutral)
    .setDescription("Current ScrapeCreators account credit balance.")
    .addFields({
      name: "Credits remaining",
      value: formatNumber(creditCount),
      inline: true,
    });
}

function buildUsageEmbed(
  entries: ScrapeCreatorsApiUsageEntry[],
  endpoint: string,
  page: number,
): EmbedBuilder {
  const visibleEntries = entries.slice(0, RECENT_USAGE_LIMIT);
  const value =
    visibleEntries.length > 0
      ? truncateFieldValue(visibleEntries.map(formatUsageLine).join("\n\n"))
      : "No matching requests returned.";

  return buildBaseEmbed("ScrapeCreators Request History", SCRAPECREATORS_COLORS.neutral)
    .setDescription("Recent API requests from ScrapeCreators.")
    .addFields(
      {
        name: "Filter",
        value: `Endpoint: \`${endpoint}\`\nPage: ${page}`,
      },
      {
        name: "Recent requests",
        value,
      },
    );
}

function sumDailyUsage(entries: ScrapeCreatorsDailyUsageEntry[]): {
  credits: number;
  requests: number;
} {
  return entries.reduce(
    (total, entry) => ({
      credits: total.credits + entry.total_credits,
      requests: total.requests + entry.request_count,
    }),
    { credits: 0, requests: 0 },
  );
}

function formatDailyLine(entry: ScrapeCreatorsDailyUsageEntry): string {
  return [
    `${formatDateTime(entry.usage_date)}:`,
    `${formatNumber(entry.total_credits)} credits`,
    `${formatNumber(entry.request_count)} requests`,
  ].join(" ");
}

function buildDailyEmbed(entries: ScrapeCreatorsDailyUsageEntry[]): EmbedBuilder {
  const visibleEntries = entries.slice(0, DAILY_USAGE_LIMIT);
  const totals = sumDailyUsage(visibleEntries);
  const dailyValue =
    visibleEntries.length > 0
      ? visibleEntries.map(formatDailyLine).join("\n")
      : "No daily usage returned.";

  return buildBaseEmbed("ScrapeCreators Daily Usage", SCRAPECREATORS_COLORS.neutral)
    .setDescription("Daily ScrapeCreators credit and request counts.")
    .addFields(
      {
        name: `Last ${visibleEntries.length || 0} reported day(s)`,
        value: [
          `${formatNumber(totals.credits)} credits`,
          `${formatNumber(totals.requests)} requests`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Daily breakdown",
        value: truncateFieldValue(dailyValue),
      },
    );
}

function buildErrorEmbed(error: unknown): EmbedBuilder {
  const status =
    error instanceof ScrapeCreatorsApiError && error.status
      ? ` (${error.status})`
      : "";
  const message =
    error instanceof Error ? error.message : "Unknown ScrapeCreators error";

  return buildBaseEmbed("ScrapeCreators Unavailable", SCRAPECREATORS_COLORS.error)
    .setDescription(`${message}${status}`);
}

async function handleBalance(interaction: ChatInputCommandInteraction): Promise<void> {
  const balance = await fetchScrapeCreatorsCreditBalance();
  await interaction.editReply({
    embeds: [buildBalanceEmbed(balance.creditCount)],
    components: [buildDashboardButton()],
  });
}

async function handleUsage(interaction: ChatInputCommandInteraction): Promise<void> {
  const endpoint =
    interaction.options.getString("endpoint")?.trim() || DEFAULT_ENDPOINT_FILTER;
  const page = interaction.options.getInteger("page") ?? 1;
  const statusCode = interaction.options.getInteger("status_code") ?? undefined;

  const usage = await fetchScrapeCreatorsApiUsage({
    endpoint,
    page,
    statusCode,
  });
  await interaction.editReply({
    embeds: [buildUsageEmbed(usage, endpoint, page)],
    components: [buildDashboardButton()],
  });
}

async function handleDaily(interaction: ChatInputCommandInteraction): Promise<void> {
  const dailyUsage = await fetchScrapeCreatorsDailyUsage();
  await interaction.editReply({
    embeds: [buildDailyEmbed(dailyUsage)],
    components: [buildDashboardButton()],
  });
}

export async function handleScrapeCreatorsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  botLogger.info({
    user: interaction.user.username,
    subcommand: interaction.options.getSubcommand(),
  }, "/scrapecreators invoked");

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!hasScrapeCreatorsAccountKey()) {
    await interaction.editReply({
      embeds: [buildSetupEmbed()],
      components: [buildDashboardButton()],
    });
    return;
  }

  try {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "balance") {
      await handleBalance(interaction);
      return;
    }
    if (subcommand === "usage") {
      await handleUsage(interaction);
      return;
    }
    await handleDaily(interaction);
  } catch (error) {
    const err = error as Error;
    botLogger.error(
      {
        error: err.message,
        stack: err.stack,
        name: err.name,
        status:
          error instanceof ScrapeCreatorsApiError
            ? error.status
            : undefined,
        user: interaction.user.username,
      },
      "/scrapecreators failed",
    );
    await interaction.editReply({
      embeds: [buildErrorEmbed(error)],
      components: [buildDashboardButton()],
    });
  }
}
