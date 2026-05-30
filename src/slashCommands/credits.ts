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
import { botLogger } from "../logger";
import {
  fetchOpenAIMonthToDateCosts,
  hasOpenAIBillingKey,
  OPENAI_BILLING_OVERVIEW_URL,
  OpenAIBillingError,
  type OpenAICostSummary,
} from "../services/openaiBilling";

const CREDITS_COLORS = {
  neutral: 0x5865f2,
  warning: 0xffaa00,
  error: 0xcc3333,
} as const;

export const creditsCommand = new SlashCommandBuilder()
  .setName("credits")
  .setDescription("View OpenAI billing spend and dashboard link")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

function formatDate(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(unixSeconds * 1000));
}

function formatCost(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value);
}

function formatTotals(summary: OpenAICostSummary): string {
  if (summary.totals.length === 0) return "$0.00";

  return summary.totals
    .map((total) => formatCost(total.value, total.currency))
    .join(", ");
}

function buildBillingButton(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Open Billing Overview")
      .setStyle(ButtonStyle.Link)
      .setURL(OPENAI_BILLING_OVERVIEW_URL),
  );
}

function buildCreditsEmbed(summary: OpenAICostSummary): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("OpenAI Credits")
    .setDescription(
      "OpenAI exposes organization spend through the API. The dashboard link has the billing overview and remaining balance.",
    )
    .setColor(CREDITS_COLORS.neutral)
    .addFields(
      {
        name: "Month-to-date spend",
        value: formatTotals(summary),
        inline: true,
      },
      {
        name: "Window",
        value: `${formatDate(summary.startTime)} - ${formatDate(summary.endTime)} UTC`,
        inline: true,
      },
      {
        name: "Balance",
        value: "OpenAI does not expose the billing overview balance through the public API.",
      },
    )
    .setTimestamp();
}

function buildSetupEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("OpenAI Credits")
    .setDescription(
      "`OPENAI_ADMIN_KEY` is not configured, so Ruyi cannot read organization costs yet.",
    )
    .setColor(CREDITS_COLORS.warning)
    .addFields({
      name: "Needed",
      value:
        "Create an OpenAI organization admin key and add it as `OPENAI_ADMIN_KEY`.",
    })
    .setTimestamp();
}

function buildErrorEmbed(error: unknown): EmbedBuilder {
  const status =
    error instanceof OpenAIBillingError && error.status
      ? ` (${error.status})`
      : "";
  const message =
    error instanceof Error ? error.message : "Unknown billing error";

  return new EmbedBuilder()
    .setTitle("OpenAI Credits Unavailable")
    .setDescription(`${message}${status}`)
    .setColor(CREDITS_COLORS.error)
    .setTimestamp();
}

export async function handleCreditsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  botLogger.info({ user: interaction.user.username }, "/credits invoked");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!hasOpenAIBillingKey()) {
    await interaction.editReply({
      embeds: [buildSetupEmbed()],
      components: [buildBillingButton()],
    });
    return;
  }

  try {
    const summary = await fetchOpenAIMonthToDateCosts();
    await interaction.editReply({
      embeds: [buildCreditsEmbed(summary)],
      components: [buildBillingButton()],
    });
  } catch (error) {
    botLogger.error(
      {
        error: (error as Error).message,
        status:
          error instanceof OpenAIBillingError ? error.status : undefined,
        user: interaction.user.username,
      },
      "/credits failed",
    );
    await interaction.editReply({
      embeds: [buildErrorEmbed(error)],
      components: [buildBillingButton()],
    });
  }
}
