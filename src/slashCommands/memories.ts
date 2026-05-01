import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Memory } from "../db/models";
import { botLogger } from "../logger";
import { MEMORY_VALUE_MAX_LEN, USER_MEMORY_CAP } from "../constants";

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
          .setMaxLength(64),
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

function sanitizeKey(key: string): string {
  return key
    .toLowerCase()
    .trim()
    .replaceAll(/[^a-z0-9_]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 64);
}

async function handleRemember(
  interaction: ChatInputCommandInteraction,
  username: string,
): Promise<void> {
  const rawKey = interaction.options.getString("key", true);
  const value = interaction.options.getString("value", true);
  const pinned = interaction.options.getBoolean("pin") ?? false;

  const key = sanitizeKey(rawKey);
  if (!key) {
    await interaction.reply({
      content: "Key must contain at least one alphanumeric character.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const count = await Memory.countDocuments({ scope: "user", username });
  if (count >= USER_MEMORY_CAP) {
    const oldest = await Memory.findOne({
      scope: "user",
      username,
      pinned: false,
    }).sort({ updatedAt: 1 });
    if (oldest) await oldest.deleteOne();
  }

  await Memory.updateOne(
    { key, scope: "user", username },
    {
      key,
      value,
      scope: "user",
      username,
      createdBy: username,
      source: "user",
      pinned,
    },
    { upsert: true },
  );

  await interaction.reply({
    content: `${pinned ? "Pinned" : "Saved"}: \`${key}\` = ${value}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleForget(
  interaction: ChatInputCommandInteraction,
  username: string,
): Promise<void> {
  const key = sanitizeKey(interaction.options.getString("key", true));
  const result = await Memory.deleteOne({ key, scope: "user", username });
  await interaction.reply({
    content:
      result.deletedCount > 0
        ? `Forgot \`${key}\`.`
        : `No memory found for \`${key}\`.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  username: string,
): Promise<void> {
  const memories = await Memory.find({ scope: "user", username }).sort({
    pinned: -1,
    updatedAt: -1,
  });

  if (memories.length === 0) {
    await interaction.reply({
      content: "I don't remember anything about you yet.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = memories.map((m) => {
    const marker = m.pinned ? "[PINNED] " : "";
    const sourceTag = m.source === "auto" ? " _(auto)_" : "";
    return `• ${marker}\`${m.key}\`: ${m.value}${sourceTag}`;
  });

  let content = `**Memories about ${username}** (${memories.length}/${USER_MEMORY_CAP})\n${lines.join("\n")}`;
  if (content.length > 1900) {
    content = content.slice(0, 1900) + "\n... (truncated)";
  }

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handlePinToggle(
  interaction: ChatInputCommandInteraction,
  username: string,
  pinned: boolean,
): Promise<void> {
  const key = sanitizeKey(interaction.options.getString("key", true));
  const result = await Memory.updateOne(
    { key, scope: "user", username },
    { $set: { pinned } },
  );
  const verb = pinned ? "Pinned" : "Unpinned";
  const content =
    result.matchedCount > 0
      ? `${verb} \`${key}\`.`
      : `No memory found for \`${key}\`.`;
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleMemoriesCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const username = interaction.user.username;
  const sub = interaction.options.getSubcommand();

  botLogger.info({ user: username, sub }, "/memories invoked");

  try {
    switch (sub) {
      case "remember":
        await handleRemember(interaction, username);
        break;
      case "forget":
        await handleForget(interaction, username);
        break;
      case "list":
        await handleList(interaction, username);
        break;
      case "pin":
        await handlePinToggle(interaction, username, true);
        break;
      case "unpin":
        await handlePinToggle(interaction, username, false);
        break;
    }
  } catch (error) {
    botLogger.error(
      { error: (error as Error).message, sub, user: username },
      "/memories failed",
    );
    if (!interaction.replied) {
      await interaction.reply({
        content: "Something went wrong handling that.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}
