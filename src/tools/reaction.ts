import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import type { Message, MessageReaction } from "discord.js";
import { toolLogger } from "../logger";
import { toolContextManager, formatError } from "../utils/types";

// Find a reaction by emoji (handles unicode and custom emojis)
function findReaction(
  message: Message,
  emoji: string,
): MessageReaction | undefined {
  return message.reactions.cache.find((r) => {
    const emojiStr = r.emoji.toString();
    const emojiName = r.emoji.name;
    const emojiId = r.emoji.id;
    return (
      emojiStr === emoji ||
      emojiName === emoji ||
      (emojiId && emoji.includes(emojiId))
    );
  });
}

export const reactionTool = defineTool("manage_reaction", {
  description:
    "Add or remove emoji reactions on messages. Can target the current message, the message the user replied to, or any message by ID.",
  parameters: z.object({
    action: z
      .enum(["add", "remove"])
      .describe("Whether to add or remove the reaction."),
    emoji: z
      .string()
      .describe(
        "The emoji to react with. Can be a unicode emoji (👍, ❤️, 🔥, 😊, 🎉, etc.) or a custom emoji in the format <:name:id> or <a:name:id> for animated.",
      ),
    message_id: z
      .string()
      .nullable()
      .describe(
        'The target message. Use "replied" to react to the message the user replied to. Use null to react to the user\'s current message. Use a message ID to react to any other message (use search_messages to find IDs).',
      ),
  }),
  handler: async ({ action, emoji, message_id }) => {
    const result = await toolContextManager.resolveTargetMessage(
      message_id,
      "reaction",
    );
    if (!result.success) {
      return { error: result.error };
    }

    const targetMessage = result.message;
    const ctx = toolContextManager.get();

    try {
      if (action === "add") {
        await targetMessage.react(emoji);
        toolLogger.info(
          { emoji, messageId: targetMessage.id, action },
          "Added reaction",
        );
        return {
          success: true,
          action: "added",
          emoji,
          messageId: targetMessage.id,
          messageUrl: targetMessage.url,
        };
      }

      // Remove the bot's own reaction
      const botUserId = ctx.message?.client.user?.id;
      if (!botUserId) {
        return { error: "Could not determine bot user ID" };
      }

      // Fetch fresh message to ensure we have latest reactions
      const channel = ctx.channel!;
      const freshMessage = await channel.messages.fetch(targetMessage.id);
      const reaction = findReaction(freshMessage, emoji);

      if (!reaction) {
        const availableReactions = freshMessage.reactions.cache
          .map((r) => r.emoji.toString())
          .join(", ");
        return {
          error: "Reaction not found on this message",
          emoji,
          availableReactions: availableReactions || "none",
          messageId: targetMessage.id,
        };
      }

      await reaction.users.remove(botUserId);
      toolLogger.info(
        { emoji, messageId: targetMessage.id, action },
        "Removed reaction",
      );
      return {
        success: true,
        action: "removed",
        emoji,
        messageId: targetMessage.id,
        messageUrl: targetMessage.url,
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { error: errorMessage, emoji, action, message_id },
        "Failed to manage reaction",
      );
      return { error: "Failed to manage reaction", details: errorMessage };
    }
  },
});
