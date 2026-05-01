import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { botLogger } from "../logger";
import { env } from "../env";

interface KeyInfoResponse {
  data?: {
    label?: string;
    limit?: number | null;
    limit_remaining?: number | null;
    limit_reset?: string | null;
    usage?: number;
    usage_daily?: number;
    usage_weekly?: number;
    usage_monthly?: number;
    is_free_tier?: boolean;
  };
  error?: { message?: string };
}

interface CreditsResponse {
  data?: {
    total_credits?: number;
    total_usage?: number;
  };
  error?: { message?: string };
}

export const creditsCommand = new SlashCommandBuilder()
  .setName("credits")
  .setDescription("View OpenRouter API credits and usage");

export async function handleCreditsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  botLogger.debug({ user: interaction.user.username }, "Credits command");

  try {
    const keyHeaders = { Authorization: `Bearer ${env.MODEL_TOKEN}` };
    const creditsHeaders = {
      Authorization: `Bearer ${env.PROVISIONING_KEY ?? env.MODEL_TOKEN}`,
    };

    // Fetch both endpoints in parallel
    const [keyResponse, creditsResponse] = await Promise.all([
      fetch("https://openrouter.ai/api/v1/key", { headers: keyHeaders }),
      fetch("https://openrouter.ai/api/v1/credits", {
        headers: creditsHeaders,
      }),
    ]);

    if (!keyResponse.ok) {
      await interaction.reply({
        content: `Failed to fetch credits: HTTP ${keyResponse.status}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const keyData = (await keyResponse.json()) as KeyInfoResponse;
    const creditsData = creditsResponse.ok
      ? ((await creditsResponse.json()) as CreditsResponse)
      : null;

    if (keyData.error) {
      await interaction.reply({
        content: `Error: ${keyData.error.message ?? "Unknown error"}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const info = keyData.data;
    if (!info) {
      await interaction.reply({
        content: "No credit information available.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const usageDaily = info.usage_daily ?? 0;
    const usageWeekly = info.usage_weekly ?? 0;
    const usageMonthly = info.usage_monthly ?? 0;

    // Get balance from credits endpoint
    const totalCredits = creditsData?.data?.total_credits ?? 0;
    const totalUsage = creditsData?.data?.total_usage ?? 0;
    const balance = totalCredits - totalUsage;

    const BAR_LENGTH = 16;

    let description: string;
    if (totalCredits > 0) {
      const percentRemaining = (balance / totalCredits) * 100;
      const filledBars = Math.round((balance / totalCredits) * BAR_LENGTH);
      const bar = "█".repeat(filledBars) + "░".repeat(BAR_LENGTH - filledBars);
      description = [
        `## 💰 $${balance.toFixed(2)} remaining`,
        `\`[${bar}]\` ${percentRemaining.toFixed(1)}% left of **$${totalCredits.toFixed(2)}** total`,
        `> $${totalUsage.toFixed(2)} spent so far`,
      ].join("\n");
    } else {
      description = `## 💰 $${balance.toFixed(2)} remaining`;
    }

    let embedColor: number;
    if (balance < 2) {
      embedColor = 0xe74c3c; // red — nearly empty
    } else if (balance < 5) {
      embedColor = 0xe67e22; // orange — getting low
    } else {
      embedColor = 0x2ecc71; // green — healthy
    }

    const embed = new EmbedBuilder()
      .setTitle("OpenRouter Credits")
      .setURL("https://openrouter.ai/settings/credits")
      .setColor(embedColor)
      .setDescription(description)
      .setTimestamp();

    embed.addFields(
      {
        name: "Spent Today",
        value: `$${usageDaily.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Spent This Week",
        value: `$${usageWeekly.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Spent This Month",
        value: `$${usageMonthly.toFixed(2)}`,
        inline: true,
      },
    );

    if (info.is_free_tier) {
      embed.setFooter({ text: "Free tier" });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    botLogger.error({ error: errorMessage }, "Failed to fetch credits");
    await interaction.reply({
      content: `Failed to fetch credits: ${errorMessage}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
