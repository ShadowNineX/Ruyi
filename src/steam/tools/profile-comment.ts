import { tool } from "@openai/agents";
import { z } from "zod";
import { toolLogger } from "../../logger";
import { steamCommunityClient } from "../client";
import {
  resolveSteamProfileTarget,
  steamIntegrationEnabled,
} from "../../utils/user-identity";
import { STEAM_PROFILE_COMMENT_MAX_LENGTH } from "../../constants";
import { toolContextManager } from "../../utils/types";
import { normalizeSteamProfileComment } from "../comment-format";

async function steamProfileCommentNeedsApproval(): Promise<boolean> {
  return toolContextManager.get().surface === "discord";
}

export const steamProfileCommentTool = tool({
  name: "steam_profile_comment",
  description:
    "Post a Steam Community profile comment from Ruyi. The target is code-whitelisted to either Ruyi's bot profile or the configured owner profile; never accepts arbitrary Steam IDs.",
  parameters: z.object({
    target: z
      .enum(["bot", "owner"])
      .describe("Where to post the Steam profile comment."),
    message: z
      .string()
      .min(1)
      .max(STEAM_PROFILE_COMMENT_MAX_LENGTH)
      .describe(
        "The exact Steam BBCode/plain-text comment to post on Steam. Use Steam tags like [b]bold[/b], not Discord Markdown.",
      ),
  }),
  needsApproval: steamProfileCommentNeedsApproval,
  execute: async ({ target, message }) => {
    if (!steamIntegrationEnabled()) {
      return {
        error:
          "Steam integration is not configured. Set the Steam env vars before posting Steam profile comments.",
      };
    }

    const targetProfileId = resolveSteamProfileTarget(target);
    if (!targetProfileId) {
      return {
        error:
          "Steam profile target is not configured or is not whitelisted for profile comments.",
      };
    }

    const { comment, truncated } = normalizeSteamProfileComment(message);
    if (!comment) return { error: "Steam profile comment cannot be empty." };

    try {
      const commentId = await steamCommunityClient.postProfileComment(
        targetProfileId,
        comment,
      );
      toolLogger.info(
        {
          target,
          profileId: targetProfileId,
          commentId,
          length: comment.length,
          truncated,
        },
        "Posted Steam profile comment",
      );
      return {
        success: true,
        target,
        commentId,
        commentLength: comment.length,
        truncated,
        final_answer_required: true,
        final_answer_guidance:
          "Confirm that the Steam profile comment was posted. Do not quote, restate, or summarize the comment text unless the user explicitly asks for a copy.",
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toolLogger.error(
        {
          target,
          profileId: targetProfileId,
          error: errorMessage,
        },
        "Failed to post Steam profile comment",
      );
      return {
        error: "Failed to post Steam profile comment.",
        details: errorMessage,
      };
    }
  },
});

export const steamProfileCommentsTool = tool({
  name: "steam_profile_comments",
  description:
    "Read recent Steam Community profile comments from a whitelisted profile. The target is code-whitelisted to either Ruyi's bot profile or the configured owner profile; never accepts arbitrary Steam IDs.",
  parameters: z.object({
    target: z
      .enum(["bot", "owner"])
      .describe("Which whitelisted Steam profile to inspect."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe("Maximum number of recent comments to return."),
  }),
  execute: async ({ target, limit }) => {
    if (!steamIntegrationEnabled()) {
      return {
        error:
          "Steam integration is not configured. Set the Steam env vars before reading Steam profile comments.",
      };
    }

    const targetProfileId = resolveSteamProfileTarget(target);
    if (!targetProfileId) {
      return {
        error:
          "Steam profile target is not configured or is not whitelisted for profile comments.",
      };
    }

    try {
      const comments = await steamCommunityClient.getProfileComments(
        targetProfileId,
        limit,
      );
      return {
        success: true,
        target,
        profileId: targetProfileId,
        comments: comments.map((comment) => ({
          id: comment.id,
          authorName: comment.authorName,
          authorSteamId: comment.authorSteamId,
          date: comment.date.toISOString(),
          text: comment.text,
        })),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toolLogger.error(
        { target, profileId: targetProfileId, error: errorMessage },
        "Failed to read Steam profile comments",
      );
      return {
        error: "Failed to read Steam profile comments.",
        details: errorMessage,
      };
    }
  },
});
