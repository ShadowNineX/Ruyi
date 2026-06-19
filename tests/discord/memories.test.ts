import { describe, expect, test } from "bun:test";
import {
  MessageFlags,
  type ButtonInteraction,
  type InteractionReplyOptions,
} from "discord.js";
import {
  handleMemoriesButton,
  isMemoriesButton,
  isMemoriesModal,
  memoriesCommand,
} from "../../src/discord/slash-commands/memories";

interface SlashCommandOptionData {
  name: string;
  options?: SlashCommandOptionData[];
  min_value?: number;
}

interface SlashCommandData {
  name: string;
  options?: SlashCommandOptionData[];
}

function commandJson(): SlashCommandData {
  return memoriesCommand.toJSON() as SlashCommandData;
}

function findSubcommand(name: string): SlashCommandOptionData | undefined {
  return commandJson().options?.find((option) => option.name === name);
}

function memoryButtonInteraction(
  customId: string,
  userId: string,
): { interaction: ButtonInteraction; replies: InteractionReplyOptions[] } {
  const replies: InteractionReplyOptions[] = [];
  const interaction = {
    customId,
    user: { id: userId, username: "tester" },
    replied: false,
    deferred: false,
    reply: async (options: InteractionReplyOptions) => {
      replies.push(options);
    },
  } as unknown as ButtonInteraction;

  return { interaction, replies };
}

describe("Discord memories command", () => {
  test("adds an optional page argument to the list subcommand", () => {
    const list = findSubcommand("list");
    const page = list?.options?.find((option) => option.name === "page");

    expect(page).toBeDefined();
    expect(page?.min_value).toBe(1);
  });
});

describe("Discord memories component routing", () => {
  test("recognizes memory buttons and modals only for memory custom ids", () => {
    expect(isMemoriesButton("memories:v1:page:123:0")).toBe(true);
    expect(isMemoriesButton("memories:v1:delete:123:0:507f1f77bcf86cd799439011")).toBe(
      true,
    );
    expect(isMemoriesButton("smithery_check:youtube")).toBe(false);

    expect(isMemoriesModal("memories:v1:submit:123:0")).toBe(true);
    expect(isMemoriesModal("memories:v1:page:123:0")).toBe(false);
  });

  test("rejects another user's memory panel without exposing its contents", async () => {
    const { interaction, replies } = memoryButtonInteraction(
      "memories:v1:delete:owner-user:0:507f1f77bcf86cd799439011",
      "different-user",
    );

    await handleMemoriesButton(interaction);

    expect(replies).toHaveLength(1);
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(replies[0]?.embeds).toHaveLength(1);
    expect(JSON.stringify(replies[0])).toContain("Private Memory Panel");
  });
});
