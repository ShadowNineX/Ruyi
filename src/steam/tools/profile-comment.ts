import { tool } from '@openai/agents';
import { z } from 'zod';
import { STEAM_PROFILE_COMMENT_MAX_LENGTH } from '../../constants';
import { env } from '../../env';
import { toolLogger } from '../../logger';
import { toolContextManager } from '../../utils/types';
import {
  resolveSteamProfileTarget,
  steamIntegrationEnabled,
} from '../../utils/user-identity';
import { steamCommunityClient } from '../client';
import {
  normalizeSteamProfileComment,
  STEAM_PROFILE_COMMENT_SAFE_BBCODE_GUIDE,
} from '../comment-format';
import {
  formatSteamCommentForTool,
  searchSteamProfileComments,
} from '../comment-search';

const OWNER_DELETE_COMMENT_LOOKUP_LIMIT = 50;

type SteamProfileCommentTarget = 'bot' | 'owner';

async function steamProfileCommentNeedsApproval(): Promise<boolean> {
  return toolContextManager.get().surface === 'discord';
}

function resolveDeleteCommentId(
  target: SteamProfileCommentTarget,
  requestedCommentId: string | null,
): string | null {
  if (requestedCommentId) { return requestedCommentId; }

  const context = toolContextManager.get();
  if (target !== 'bot' || context.surface !== 'steam') { return null; }
  return context.steam?.sourceCommentId ?? null;
}

async function canDeleteCommentFromTarget(
  target: SteamProfileCommentTarget,
  targetProfileId: string,
  commentId: string,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (target === 'bot') { return { allowed: true }; }

  const comments = await steamCommunityClient.getProfileComments(
    targetProfileId,
    OWNER_DELETE_COMMENT_LOOKUP_LIMIT,
  );
  const comment = comments.find(candidate => candidate.id === commentId);
  if (!comment) {
    return {
      allowed: false,
      reason:
        'That comment was not found in the recent owner-profile comments I can inspect.',
    };
  }

  if (comment.authorSteamId !== env.STEAM_BOT_STEAM_ID64) {
    return {
      allowed: false,
      reason:
        'I can only delete my own Steam comments from the owner profile.',
    };
  }

  return { allowed: true };
}

async function handleSteamProfileCommentDelete(
  target: SteamProfileCommentTarget,
  targetProfileId: string,
  commentId: string | null,
) {
  const resolvedCommentId = resolveDeleteCommentId(target, commentId);
  if (!resolvedCommentId) {
    return {
      error:
        'comment_id is required when deleting a Steam profile comment.',
    };
  }

  const deletionAccess = await canDeleteCommentFromTarget(
    target,
    targetProfileId,
    resolvedCommentId,
  );
  if (!deletionAccess.allowed) {
    return {
      error: 'Steam profile comment deletion is not allowed.',
      details: deletionAccess.reason,
    };
  }

  await steamCommunityClient.deleteProfileComment(
    targetProfileId,
    resolvedCommentId,
  );
  toolLogger.info(
    { target, profileId: targetProfileId, commentId: resolvedCommentId },
    'Deleted Steam profile comment',
  );
  return {
    success: true,
    action: 'delete',
    target,
    commentId: resolvedCommentId,
    final_answer_required: true,
    final_answer_guidance:
      'Confirm briefly that the Steam profile comment was deleted. Do not restate deleted comment text unless the user explicitly asks.',
  };
}

async function handleSteamProfileCommentPost(
  target: SteamProfileCommentTarget,
  targetProfileId: string,
  message: string | null,
) {
  if (!message) {
    return {
      error:
        'message is required when posting a Steam profile comment.',
    };
  }

  const {
    comment,
    truncated,
    removedUnsupportedFormatting,
    convertedAlignmentSpaces,
  } = normalizeSteamProfileComment(message);
  if (!comment) { return { error: 'Steam profile comment cannot be empty.' }; }

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
    'Posted Steam profile comment',
  );
  return {
    success: true,
    action: 'post',
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
      'Confirm that the Steam profile comment was posted. Do not quote, restate, or summarize the comment text unless the user explicitly asks for a copy.',
  };
}

export const steamProfileCommentTool = tool({
  name: 'steam_profile_comment',
  description:
    'Post or delete a Steam Community profile comment from Ruyi. The target is code-whitelisted to either Ruyi\'s bot profile or the configured owner profile; never accepts arbitrary Steam IDs. Deletion is unrestricted on Ruyi\'s own bot profile, but owner-profile deletion is code-limited to comments authored by Ruyi.',
  parameters: z.object({
    action: z
      .enum(['post', 'delete'])
      .default('post')
      .describe(
        'Use post to add a profile comment. Use delete to remove a profile comment by comment_id.',
      ),
    target: z
      .enum(['bot', 'owner'])
      .describe('Which whitelisted Steam profile to manage.'),
    message: z
      .string()
      .min(1)
      .max(STEAM_PROFILE_COMMENT_MAX_LENGTH)
      .nullable()
      .default(null)
      .describe(
        `Required when action=post. The exact Steam profile comment to post. Use safe Steam BBCode when it improves readability: ${STEAM_PROFILE_COMMENT_SAFE_BBCODE_GUIDE}. Never use Discord Markdown or unsupported Steam tags.`,
      ),
    comment_id: z
      .string()
      .min(1)
      .max(100)
      .nullable()
      .default(null)
      .describe(
        'Required when action=delete unless deleting the current Steam comment from Ruyi\'s bot profile. The exact Steam profile comment ID returned by steam_profile_comments, search_conversation, or Steam comment context.',
      ),
  }),
  needsApproval: steamProfileCommentNeedsApproval,
  execute: async ({ action, target, message, comment_id }) => {
    if (!steamIntegrationEnabled()) {
      return {
        error:
          'Steam integration is not configured. Set the Steam env vars before managing Steam profile comments.',
      };
    }

    const targetProfileId = resolveSteamProfileTarget(target);
    if (!targetProfileId) {
      return {
        error:
          'Steam profile target is not configured or is not whitelisted for profile comments.',
      };
    }

    try {
      if (action === 'delete') {
        return await handleSteamProfileCommentDelete(
          target,
          targetProfileId,
          comment_id,
        );
      }

      return await handleSteamProfileCommentPost(
        target,
        targetProfileId,
        message,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toolLogger.error(
        {
          action,
          target,
          profileId: targetProfileId,
          commentId: comment_id,
          error: errorMessage,
        },
        'Failed to manage Steam profile comment',
      );
      return {
        error: 'Failed to manage Steam profile comment.',
        details: errorMessage,
      };
    }
  },
});

export const steamProfileCommentsTool = tool({
  name: 'steam_profile_comments',
  description:
    'Discord-only bridge for reading or fuzzy-searching recent Steam Community profile comments from a whitelisted profile. Use search_conversation for the active Discord or Steam conversation itself. The target is code-whitelisted to either Ruyi\'s bot profile or the configured owner profile; never accepts arbitrary Steam IDs.',
  parameters: z.object({
    target: z
      .enum(['bot', 'owner'])
      .describe('Which whitelisted Steam profile to inspect.'),
    query: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .default(null)
      .describe(
        'Optional exact or fuzzy query for Steam profile comments. Omit to read newest comments.',
      ),
    author: z
      .string()
      .min(1)
      .max(100)
      .nullable()
      .default(null)
      .describe(
        'Optional author name or SteamID filter for searched Steam profile comments.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe('Maximum number of recent comments or search matches to return.'),
  }),
  execute: async ({ target, query, author, limit }) => {
    if (!steamIntegrationEnabled()) {
      return {
        error:
          'Steam integration is not configured. Set the Steam env vars before reading Steam profile comments.',
      };
    }

    const targetProfileId = resolveSteamProfileTarget(target);
    if (!targetProfileId) {
      return {
        error:
          'Steam profile target is not configured or is not whitelisted for profile comments.',
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
          'Searched whitelisted Steam profile comments from Discord',
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
            source: 'steam',
            scope: `whitelisted ${target} Steam profile`,
            limitation:
              'Discord-side Steam profile comment search only covers recent comments fetched from the whitelisted Steam profile. Deleted, private, or older comments may be unavailable.',
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
        'Failed to read Steam profile comments',
      );
      return {
        error: 'Failed to read Steam profile comments.',
        details: errorMessage,
      };
    }
  },
});
