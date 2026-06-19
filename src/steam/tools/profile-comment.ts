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
import {
  formatSteamCommentForTool,
  searchSteamProfileComments,
} from "../comment-search";
import {
  normalizeSteamProfileComment,
  STEAM_PROFILE_COMMENT_SAFE_BBCODE_GUIDE,
} from "../comment-format";

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
        `The exact Steam profile comment to post. Use safe Steam BBCode when it improves readability: ${STEAM_PROFILE_COMMENT_SAFE_BBCODE_GUIDE}. Never use Discord Markdown or unsupported Steam tags.`,
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

    const {
      comment,
      truncated,
      removedUnsupportedFormatting,
      convertedAlignmentSpaces,
    } = normalizeSteamProfileComment(message);
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
          removedUnsupportedFormatting,
          convertedAlignmentSpaces,
        },
        "Posted Steam profile comment",
      );
      return {
        success: true,
        target,
        commentId,
        commentLength: comment.length,
        truncated,
        formattingAdjusted:
          removedUnsupportedFormatting || convertedAlignmentSpaces,
        removedUnsupportedFormatting,
        convertedAlignmentSpaces,
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
    "Discord-only bridge for reading or fuzzy-searching recent Steam Community profile comments from a whitelisted profile. Use search_conversation for the active Discord or Steam conversation itself. The target is code-whitelisted to either Ruyi's bot profile or the configured owner profile; never accepts arbitrary Steam IDs.",
  parameters: z.object({
    target: z
      .enum(["bot", "owner"])
      .describe("Which whitelisted Steam profile to inspect."),
    query: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .default(null)
      .describe(
        "Optional exact or fuzzy query for Steam profile comments. Omit to read newest comments.",
      ),
    author: z
      .string()
      .min(1)
      .max(100)
      .nullable()
      .default(null)
      .describe(
        "Optional author name or SteamID filter for searched Steam profile comments.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe("Maximum number of recent comments or search matches to return."),
  }),
  execute: async ({ target, query, author, limit }) => {
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
      if (query) {
        const search = await searchSteamProfileComments(
          targetProfileId,
          query,
          author,
          limit,
        );
        toolLogger.info(
          {
            target,
            profileId: targetProfileId,
            queryLength: query.length,
            hasAuthorFilter: Boolean(author),
            searchedCommentCount: search.searchedCommentCount,
            matchCount: search.matches.length,
          },
          "Searched whitelisted Steam profile comments from Discord",
        );

        return {
          success: true,
          target,
          profileId: targetProfileId,
          query,
          author,
          comments: search.matches,
          search_summary: {
            exact_phrase_found: search.summary.exactPhraseFound,
            best_match_type: search.summary.bestMatchType,
            fuzzy_match_count: search.summary.fuzzyMatchCount,
            partial_match_count: search.summary.partialMatchCount,
            searched_comment_count: search.searchedCommentCount,
            result_limit: limit,
            source: "steam",
            scope: `whitelisted ${target} Steam profile`,
            limitation:
              "Discord-side Steam profile comment search only covers recent comments fetched from the whitelisted Steam profile. Deleted, private, or older comments may be unavailable.",
          },
        };
      }

      const comments = await steamCommunityClient.getProfileComments(
        targetProfileId,
        limit,
      );
      return {
        success: true,
        target,
        profileId: targetProfileId,
        comments: comments.map(formatSteamCommentForTool),
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
