import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import mongoose from "mongoose";
import { agentsRuntimeManager } from "../../ai";
import { getBuildInfo, type BuildInfo } from "../../build-info";
import { countConnectedSmitheryConnections } from "../../db/models";
import { botLogger } from "../../logger";
import { steamCommunityClient } from "../../steam/client";
import { steamIntegrationEnabled } from "../../utils/user-identity";

const INFO_COLORS = {
  healthy: 0x57f287,
  warning: 0xffaa00,
  error: 0xcc3333,
} as const;

type HealthState = "OK" | "Warning" | "Error" | "Disabled";

interface HealthItem {
  label: string;
  state: HealthState;
  detail: string;
}

export const infoCommand = new SlashCommandBuilder()
  .setName("info")
  .setDescription("Show Ruyi health status and running Git commit");

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;

  const parts = [
    days > 0 ? `${days}d` : null,
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    remainingSeconds > 0 || seconds === 0 ? `${remainingSeconds}s` : null,
  ].filter((part): part is string => part !== null);

  return parts.slice(0, 3).join(" ");
}

function formatDiscordTimestamp(date: Date | null): string {
  if (!date) return "Not ready";
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function formatBuildTime(value: string | null): string {
  if (!value) return "Not bundled";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Invalid build time";
  return `<t:${Math.floor(time / 1000)}:R>`;
}

function formatCommit(buildInfo: BuildInfo): string {
  const commit = buildInfo.commit;
  const shortCommit = buildInfo.shortCommit;
  if (/^[0-9a-f]{7,40}$/i.test(commit)) {
    return `[\`${shortCommit}\`](https://github.com/ShadowNineX/Ruyi/commit/${commit})`;
  }
  return `\`${shortCommit}\``;
}

function formatHealthLine(item: HealthItem): string {
  return `**${item.label}:** ${item.state} - ${item.detail}`;
}

function getDiscordHealth(
  interaction: ChatInputCommandInteraction,
): HealthItem {
  const ready = Boolean(interaction.client.readyAt);
  const ping = interaction.client.ws.ping;
  return {
    label: "Discord",
    state: ready ? "OK" : "Warning",
    detail: ready
      ? `Gateway ready, ${Math.round(ping)} ms ping`
      : "Gateway is not ready",
  };
}

function getMongoHealth(): HealthItem {
  const state = mongoose.connection.readyState;
  const labels = ["Disconnected", "Connected", "Connecting", "Disconnecting"];
  const detail = labels[state] ?? `Unknown state ${state}`;

  if (state === 1) {
    return { label: "MongoDB", state: "OK", detail };
  }
  if (state === 0) {
    return { label: "MongoDB", state: "Error", detail };
  }
  return { label: "MongoDB", state: "Warning", detail };
}

function getOpenAIHealth(): HealthItem {
  return {
    label: "OpenAI Agents",
    state: agentsRuntimeManager.isConnected() ? "OK" : "Warning",
    detail: agentsRuntimeManager.isConnected()
      ? "Runtime initialized"
      : "Runtime not initialized",
  };
}

function getSteamHealth(): HealthItem {
  if (!steamIntegrationEnabled()) {
    return {
      label: "Steam",
      state: "Disabled",
      detail: "Steam env is not configured",
    };
  }

  return {
    label: "Steam",
    state: steamCommunityClient.isReady() ? "OK" : "Warning",
    detail: steamCommunityClient.isReady()
      ? "Community session ready"
      : "Configured but not ready",
  };
}

async function getSmitheryHealth(): Promise<HealthItem> {
  const connected = await countConnectedSmitheryConnections();
  return {
    label: "Smithery",
    state: "OK",
    detail: `${connected} connected service${connected === 1 ? "" : "s"}`,
  };
}

function chooseHealthColor(items: HealthItem[]): number {
  if (items.some((item) => item.state === "Error")) return INFO_COLORS.error;
  if (items.some((item) => item.state === "Warning")) {
    return INFO_COLORS.warning;
  }
  return INFO_COLORS.healthy;
}

async function buildInfoEmbed(
  interaction: ChatInputCommandInteraction,
): Promise<EmbedBuilder> {
  const buildInfo = getBuildInfo();
  const healthItems = [
    getDiscordHealth(interaction),
    getMongoHealth(),
    getOpenAIHealth(),
    getSteamHealth(),
    await getSmitheryHealth(),
  ];

  return new EmbedBuilder()
    .setTitle("Ruyi Info")
    .setDescription("Runtime health and build details.")
    .setColor(chooseHealthColor(healthItems))
    .addFields(
      {
        name: "Build",
        value: [
          `Commit: ${formatCommit(buildInfo)}`,
          `Build time: ${formatBuildTime(buildInfo.buildTime)}`,
          `Bundled: ${buildInfo.bundled ? "Yes" : "No"}`,
        ].join("\n"),
      },
      {
        name: "Runtime",
        value: [
          `Uptime: ${formatDuration(process.uptime())}`,
          `Discord ready: ${formatDiscordTimestamp(interaction.client.readyAt)}`,
          `Bun: ${Bun.version}`,
        ].join("\n"),
      },
      {
        name: "Health",
        value: healthItems.map(formatHealthLine).join("\n"),
      },
    )
    .setTimestamp();
}

function buildErrorEmbed(error: unknown): EmbedBuilder {
  const message = error instanceof Error ? error.message : "Unknown error";
  return new EmbedBuilder()
    .setTitle("Ruyi Info Unavailable")
    .setDescription(message)
    .setColor(INFO_COLORS.error)
    .setTimestamp();
}

export async function handleInfoCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  botLogger.info({ user: interaction.user.username }, "/info invoked");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await interaction.editReply({ embeds: [await buildInfoEmbed(interaction)] });
  } catch (error) {
    botLogger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        user: interaction.user.username,
      },
      "/info failed",
    );
    await interaction.editReply({ embeds: [buildErrorEmbed(error)] });
  }
}
