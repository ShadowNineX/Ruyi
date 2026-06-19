import { chatService, conversationContext, sessionManager } from "../ai";
import { steamProfileConfigScope } from "../config";
import {
  SteamAgentSession,
  SteamCommentState,
  SteamConversation,
} from "../db/models";
import { botLogger } from "../logger";
import { runWithToolContext } from "../utils/types";
import {
  buildSteamUserIdentity,
  steamIntegrationEnabled,
} from "../utils/user-identity";
import { env } from "../env";
import {
  steamCommunityClient,
  type SteamProfileComment,
} from "./client";
import { normalizeSteamProfileComment } from "./comment-format";
import {
  findDeletedSteamCommentIds,
  type SteamCommentWindow,
} from "./comment-sync";
import { HeadlessChatSession } from "./headless-session";

const STEAM_COMMENT_CHECK_OVERLAP_MS = 2 * 60_000;
const STEAM_COMMENT_FETCH_COUNT = 100;
const SEEN_COMMENT_CAP = 500;

type CommentCheckReason = "startup" | "notification" | "queued";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortCommentsOldestFirst(
  comments: SteamProfileComment[],
): SteamProfileComment[] {
  return [...comments].sort(
    (left, right) => left.date.getTime() - right.date.getTime(),
  );
}

function toSteamCommentWindow(
  comments: SteamProfileComment[],
  totalCount: number,
): SteamCommentWindow {
  return {
    totalCount,
    comments: comments.map((comment) => ({
      id: comment.id,
      date: comment.date,
    })),
  };
}

function mergeSeenCommentIds(
  currentIds: string[],
  nextIds: string[],
): string[] {
  const merged = new Set([...currentIds, ...nextIds]);
  return [...merged].slice(-SEEN_COMMENT_CAP);
}

function buildSteamCommentPrompt(comment: SteamProfileComment): string {
  return `Steam profile comment from ${comment.authorName}:\n${comment.text}`;
}

function commentWasAlreadyHandled(
  comment: SteamProfileComment,
  seenIds: Set<string>,
  lastCheckedAt: Date,
): boolean {
  const cutoff =
    seenIds.size > 0
      ? lastCheckedAt.getTime() - STEAM_COMMENT_CHECK_OVERLAP_MS
      : lastCheckedAt.getTime();
  return (
    seenIds.has(comment.id) ||
    comment.date.getTime() <= cutoff
  );
}

class SteamProfileCommentService {
  private unsubscribeCommentNotifications: (() => void) | null = null;
  private running = false;
  private processing = false;
  private pendingCheck = false;

  async start(): Promise<void> {
    if (!steamIntegrationEnabled()) {
      botLogger.info("Steam profile comment chat disabled");
      return;
    }
    if (this.running) return;
    this.running = true;

    try {
      await steamCommunityClient.start();
      this.subscribeToCommentNotifications();
      await this.checkComments("startup");
    } catch (error) {
      botLogger.error(
        { error: getErrorMessage(error) },
        "Steam profile comment service failed during startup",
      );
    }
  }

  stop(): void {
    this.running = false;
    this.unsubscribeCommentNotifications?.();
    this.unsubscribeCommentNotifications = null;
    this.pendingCheck = false;
    steamCommunityClient.stop();
  }

  private subscribeToCommentNotifications(): void {
    if (this.unsubscribeCommentNotifications) return;

    this.unsubscribeCommentNotifications =
      steamCommunityClient.onCommentNotification((count, myItems, discussions) => {
        botLogger.debug(
          { count, myItems, discussions },
          "Steam comment notification received",
        );
        if (myItems <= 0) return;
        void this.checkComments("notification");
      });
  }

  private async checkComments(reason: CommentCheckReason): Promise<void> {
    if (this.processing) {
      this.pendingCheck = true;
      return;
    }
    this.processing = true;

    try {
      const profileId = env.STEAM_BOT_STEAM_ID64;
      if (!profileId) {
        throw new TypeError("Steam bot profile ID is not configured");
      }
      await this.processProfileComments(profileId, reason);
    } catch (error) {
      botLogger.error(
        { reason, error: getErrorMessage(error) },
        "Steam profile comment check failed",
      );
    } finally {
      this.processing = false;
      if (this.pendingCheck && this.running) {
        this.pendingCheck = false;
        void this.checkComments("queued");
      }
    }
  }

  private async processProfileComments(
    profileId: string,
    reason: CommentCheckReason,
  ): Promise<void> {
    const page = await steamCommunityClient.getProfileCommentPage(
      profileId,
      STEAM_COMMENT_FETCH_COUNT,
    );
    const { comments, totalCount } = page;
    const commentIds = comments.map((comment) => comment.id);
    const deletedIds = await this.syncDeletedProfileComments(
      profileId,
      toSteamCommentWindow(comments, totalCount),
    );

    const state = await SteamCommentState.findOne({ profileId });
    if (!state) {
      await SteamCommentState.create({
        profileId,
        seenCommentIds: [],
        lastCheckedAt: new Date(),
      });
      botLogger.info(
        { profileId, reason },
        "Initialized Steam profile comment state",
      );
      return;
    }

    const seenIds = new Set(state.seenCommentIds);
    const newComments = sortCommentsOldestFirst(comments).filter((comment) => {
      if (commentWasAlreadyHandled(comment, seenIds, state.lastCheckedAt)) {
        return false;
      }
      return comment.authorSteamId !== profileId;
    });

    const processedIds: string[] = [];
    for (const comment of newComments) {
      const commentId = comment.id;
      try {
        await this.replyToComment(profileId, comment, commentId);
      } finally {
        processedIds.push(commentId);
      }
    }

    const seenCommentIds = mergeSeenCommentIds(state.seenCommentIds, [
      ...commentIds,
      ...processedIds,
    ]);
    await SteamCommentState.updateOne(
      { profileId },
      {
        $set: {
          seenCommentIds,
          lastCheckedAt: new Date(),
        },
      },
    );
    botLogger.debug(
      {
        profileId,
        reason,
        checked: comments.length,
        totalCount,
        replied: processedIds.length,
        deleted: deletedIds.length,
      },
      "Steam profile comments checked",
    );
  }

  private async syncDeletedProfileComments(
    profileId: string,
    visibleWindow: SteamCommentWindow,
  ): Promise<string[]> {
    const conversation = await SteamConversation.findOne(
      { profileId },
      { messages: 1 },
    );
    if (!conversation || conversation.messages.length === 0) return [];

    const deletedIds = findDeletedSteamCommentIds(
      conversation.messages.map((message) => ({
        commentId: message.commentId,
        timestamp: message.timestamp,
      })),
      visibleWindow,
    );
    if (deletedIds.length === 0) return [];

    const activeSessionMatchesDeletedComment = await SteamAgentSession.exists({
      profileId,
      isActive: true,
      provider: "openai-agents",
      processedCommentIds: { $in: deletedIds },
    });

    await Promise.all([
      SteamConversation.updateOne(
        { profileId },
        {
          $pull: { messages: { commentId: { $in: deletedIds } } },
          $set: { lastInteraction: new Date() },
        },
      ),
      SteamCommentState.updateOne(
        { profileId },
        { $pull: { seenCommentIds: { $in: deletedIds } } },
      ),
      SteamAgentSession.updateOne(
        { profileId },
        { $pull: { processedCommentIds: { $in: deletedIds } } },
      ),
    ]);

    if (activeSessionMatchesDeletedComment) {
      await sessionManager.invalidate(profileId, "steam");
    }

    botLogger.info(
      {
        profileId,
        deletedCommentIds: deletedIds,
        invalidatedSession: Boolean(activeSessionMatchesDeletedComment),
      },
      "Removed deleted Steam comments from local context",
    );

    return deletedIds;
  }

  private async replyToComment(
    profileId: string,
    comment: SteamProfileComment,
    commentId: string,
  ): Promise<void> {
    const { authorSteamId, authorName } = comment;
    const identity = buildSteamUserIdentity(authorSteamId, authorName);
    const session = new HeadlessChatSession();
    const userMessage = buildSteamCommentPrompt(comment);

    const reply = await runWithToolContext(
      {
        surface: "steam",
        identity,
        message: null,
        channel: null,
        guild: null,
        referencedMessage: null,
        steam: { profileId, sourceCommentId: commentId },
      },
      () =>
        chatService.chat({
          surface: "steam",
          surfaceLabel: "Steam profile comments on Ruyi's bot profile",
          identity,
          userMessage,
          username: authorName,
          channelId: profileId,
          configScope: steamProfileConfigScope(profileId),
          userId: authorSteamId,
          session,
          messageId: commentId,
          messageTimestamp: comment.date,
          chatHistory: [],
          persistUserMessage: true,
        }),
    );

    if (!reply) {
      botLogger.warn(
        { profileId, commentId, authorSteamId },
        "Steam profile comment produced no reply",
      );
      return;
    }

    const {
      comment: steamReply,
      truncated,
      removedUnsupportedFormatting,
      convertedAlignmentSpaces,
    } = normalizeSteamProfileComment(reply);
    if (!steamReply) {
      botLogger.warn(
        { profileId, commentId, authorSteamId },
        "Steam profile comment reply was empty after normalization",
      );
      return;
    }

    const replyCommentId = await steamCommunityClient.postProfileComment(
      profileId,
      steamReply,
    );
    await conversationContext.rememberSteamMessage({
      profileId,
      authorSteamId: profileId,
      authorName: "Ruyi",
      content: steamReply,
      isBot: true,
      commentId:
        replyCommentId ?? `ruyi:${commentId}:${Math.floor(Date.now() / 1000)}`,
    });
    botLogger.info(
      {
        profileId,
        commentId,
        replyCommentId,
        authorSteamId,
        truncated,
        removedUnsupportedFormatting,
        convertedAlignmentSpaces,
      },
      "Replied to Steam profile comment",
    );
  }
}

export const steamProfileCommentService = new SteamProfileCommentService();
