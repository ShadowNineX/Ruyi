import {
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Memory } from "../db/models";
import { botLogger } from "../logger";
import { MEMORY_VALUE_MAX_LEN, USER_MEMORY_CAP } from "../constants";
import { type ConfigScope, formatConfigScope, userConfigScope } from "../config";
import { buildUserMemoryFilter } from "../utils/memory-scope";
import {
  MEMORY_KEY_MAX_LEN,
  sanitizeMemoryKey,
} from "../utils/memory-normalization";

const MEMORY_COLORS = {
  success: 0x2ecc71,
  neutral: 0x5865f2,
  warning: 0xffaa00,
  error: 0xcc3333,
} as const;

const INVALID_MEMORY_KEY_MESSAGE =
  "Key must contain at least one alphanumeric character.";

export const memoriesCommand = new SlashCommandBuilder()
  .setName("memories")
  .setDescription("Manage what Ruyi remembers about you")
  .addSubcommand((sub) =>
    sub
      .setName("remember")
      .setDescription("Save a fact about yourself")
      .addStringOption((opt) =>
        opt
          .setName("key")
          .setDescription("Short identifier (e.g. 'favorite_color')")
          .setRequired(true)
          .setMaxLength(MEMORY_KEY_MAX_LEN),
      )
      .addStringOption((opt) =>
        opt
          .setName("value")
          .setDescription("The fact to remember")
          .setRequired(true)
          .setMaxLength(MEMORY_VALUE_MAX_LEN),
      )
      .addBooleanOption((opt) =>
        opt
          .setName("pin")
          .setDescription("Pin so Ruyi always sees it (default: false)")
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("forget")
      .setDescription("Delete a stored memory")
      .addStringOption((opt) =>
        opt
          .setName("key")
          .setDescription("The memory key to forget")
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("list")
      .setDescription("List everything Ruyi remembers about you"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("pin")
      .setDescription("Pin an existing memory (always loaded into context)")
      .addStringOption((opt) =>
        opt
          .setName("key")
          .setDescription("The memory key to pin")
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("unpin")
      .setDescription("Unpin an existing memory")
      .addStringOption((opt) =>
        opt
          .setName("key")
          .setDescription("The memory key to unpin")
          .setRequired(true),
      ),
  );

function buildMemoryEmbed(
  title: string,
  description: string,
  color: number,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

async function replyWithMemoryEmbed(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string,
  color: number,
): Promise<void> {
  await interaction.reply({
    embeds: [buildMemoryEmbed(title, description, color)],
    flags: MessageFlags.Ephemeral,
  });
}

async function getMemoryKeyOrReply(
  interaction: ChatInputCommandInteraction,
  errorTitle: string,
): Promise<string | null> {
  const key = sanitizeMemoryKey(interaction.options.getString("key", true));
  if (key) return key;

  await replyWithMemoryEmbed(
    interaction,
    errorTitle,
    INVALID_MEMORY_KEY_MESSAGE,
    MEMORY_COLORS.error,
  );
  return null;
}

async function handleRemember(
  interaction: ChatInputCommandInteraction,
  userId: string,
  username: string,
  scope: ConfigScope,
): Promise<void> {
  const key = await getMemoryKeyOrReply(interaction, "Memory Not Saved");
  if (!key) return;

  const value = interaction.options.getString("value", true);
  const pinned = interaction.options.getBoolean("pin") ?? false;

  const userFilter = buildUserMemoryFilter(userId, scope);
  const count = await Memory.countDocuments(userFilter);
  if (count >= USER_MEMORY_CAP) {
    const oldest = await Memory.findOne({
      ...userFilter,
      pinned: false,
    }).sort({ updatedAt: 1 });
    if (oldest) await oldest.deleteOne();
  }

  await Memory.updateOne(
    { key, ...userFilter },
    {
      ...userFilter,
      key,
      value,
      username,
      createdBy: username,
      source: "user",
      pinned,
    },
    { upsert: true },
  );

  await replyWithMemoryEmbed(
    interaction,
    pinned ? "Memory Saved And Pinned" : "Memory Saved",
    `\`${key}\`\n${value}\n\nStored for you in ${formatConfigScope(scope)}.`,
    pinned ? MEMORY_COLORS.success : MEMORY_COLORS.neutral,
  );
}

async function handleForget(
  interaction: ChatInputCommandInteraction,
  userId: string,
  username: string,
  scope: ConfigScope,
): Promise<void> {
  const key = await getMemoryKeyOrReply(interaction, "Memory Not Found");
  if (!key) return;

  const result = await Memory.deleteOne({
    key,
    ...buildUserMemoryFilter(userId, scope),
  });
  await replyWithMemoryEmbed(
    interaction,
    result.deletedCount > 0 ? "Memory Forgotten" : "Memory Not Found",
    result.deletedCount > 0
      ? `Forgot \`${key}\`.`
      : `No memory found for \`${key}\`.`,
    result.deletedCount > 0 ? MEMORY_COLORS.success : MEMORY_COLORS.warning,
  );
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  userId: string,
  username: string,
  scope: ConfigScope,
): Promise<void> {
  const memories = await Memory.find(buildUserMemoryFilter(userId, scope)).sort({
    pinned: -1,
    updatedAt: -1,
  });

  if (memories.length === 0) {
    await replyWithMemoryEmbed(
      interaction,
      "No Memories Yet",
      `I don't remember anything about you in ${formatConfigScope(scope)} yet.`,
      MEMORY_COLORS.neutral,
    );
    return;
  }

  const lines = memories.map((m) => {
    const marker = m.pinned ? "[PINNED] " : "";
    const sourceTag = m.source === "auto" ? " _(auto)_" : "";
    return `• ${marker}\`${m.key}\`: ${m.value}${sourceTag}`;
  });

  let description = lines.join("\n");
  if (description.length > 3900) {
    description = description.slice(0, 3900) + "\n... (truncated)";
  }

  await interaction.reply({
    embeds: [
      buildMemoryEmbed(
        `Memories About ${username}`,
        description,
        MEMORY_COLORS.neutral,
      ).setFooter({ text: `${memories.length}/${USER_MEMORY_CAP} used` }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePinToggle(
  interaction: ChatInputCommandInteraction,
  userId: string,
  username: string,
  scope: ConfigScope,
  pinned: boolean,
): Promise<void> {
  const key = await getMemoryKeyOrReply(interaction, "Memory Not Found");
  if (!key) return;

  const result = await Memory.updateOne(
    { key, ...buildUserMemoryFilter(userId, scope) },
    { $set: { pinned } },
  );
  const verb = pinned ? "Pinned" : "Unpinned";
  await replyWithMemoryEmbed(
    interaction,
    result.matchedCount > 0 ? `Memory ${verb}` : "Memory Not Found",
    result.matchedCount > 0
      ? `${verb} \`${key}\`.`
      : `No memory found for \`${key}\`.`,
    result.matchedCount > 0 ? MEMORY_COLORS.success : MEMORY_COLORS.warning,
  );
}

export async function handleMemoriesCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const userId = interaction.user.id;
  const username = interaction.user.username;
  const scope = userConfigScope(interaction.guildId, userId);
  const sub = interaction.options.getSubcommand();

  botLogger.info({ user: username, sub }, "/memories invoked");

  try {
    switch (sub) {
      case "remember":
        await handleRemember(interaction, userId, username, scope);
        break;
      case "forget":
        await handleForget(interaction, userId, username, scope);
        break;
      case "list":
        await handleList(interaction, userId, username, scope);
        break;
      case "pin":
        await handlePinToggle(interaction, userId, username, scope, true);
        break;
      case "unpin":
        await handlePinToggle(interaction, userId, username, scope, false);
        break;
    }
  } catch (error) {
    botLogger.error(
      { error: (error as Error).message, sub, user: username },
      "/memories failed",
    );
    if (!interaction.replied) {
      await replyWithMemoryEmbed(
        interaction,
        "Memory Command Failed",
        "Something went wrong handling that.",
        MEMORY_COLORS.error,
      );
    }
  }
}
