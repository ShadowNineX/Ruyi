import type SteamCommunity from "steamcommunity";
import { chatService, conversationContext } from "../ai";
import { steamProfileConfigScope } from "../config";
import { SteamCommentState } from "../db/models";
import { botLogger } from "../logger";
import { runWithToolContext } from "../utils/types";
import {
  buildSteamUserIdentity,
  steamIntegrationEnabled,
} from "../utils/user-identity";
import { env } from "../env";
import { steamCommunityClient } from "./client";
import { normalizeSteamProfileComment } from "./comment-format";
import { HeadlessChatSession } from "./headless-session";

const STEAM_COMMENT_RECONCILE_INTERVAL_MS = 15 * 60_000;
const STEAM_COMMENT_CHECK_OVERLAP_MS = 2 * 60_000;
const STEAM_COMMENT_FETCH_COUNT = 20;
const SEEN_COMMENT_CAP = 500;

type SteamUserComment = SteamCommunity.UserComment;
type CommentCheckReason = "startup" | "notification" | "fallback" | "queued";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getCommentId(comment: SteamUserComment): string | null {
  const id = comment.id;
  if (typeof id === "string" || typeof id === "number") {
    const normalized = String(id).trim();
    return normalized || null;
  }
  return null;
}

function getCommentText(comment: SteamUserComment): string {
  return typeof comment.text === "string" ? comment.text.trim() : "";
}

function getCommentAuthorName(comment: SteamUserComment): string {
  return typeof comment.author.name === "string"
    ? comment.author.name
    : "Steam user";
}

function getCommentAuthorSteamId(comment: SteamUserComment): string {
  return comment.author.steamID.getSteamID64();
}

function sortCommentsOldestFirst(
  comments: SteamUserComment[],
): SteamUserComment[] {
  return [...comments].sort(
    (left, right) => left.date.getTime() - right.date.getTime(),
  );
}

function mergeSeenCommentIds(
  currentIds: string[],
  nextIds: string[],
): string[] {
  const merged = new Set([...currentIds, ...nextIds]);
  return [...merged].slice(-SEEN_COMMENT_CAP);
}

function buildSteamCommentPrompt(comment: SteamUserComment): string {
  const authorName = getCommentAuthorName(comment);
  const text = getCommentText(comment);
  return `Steam profile comment from ${authorName}:\n${text}`;
}

function commentWasAlreadyHandled(
  comment: SteamUserComment,
  seenIds: Set<string>,
  lastCheckedAt: Date,
): boolean {
  const commentId = getCommentId(comment);
  const cutoff =
    seenIds.size > 0
      ? lastCheckedAt.getTime() - STEAM_COMMENT_CHECK_OVERLAP_MS
      : lastCheckedAt.getTime();
  return (
    !commentId ||
    seenIds.has(commentId) ||
    comment.date.getTime() <= cutoff
  );
}

class SteamProfileCommentService {
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
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
    } finally {
      this.scheduleFallbackCheck();
    }
  }

  stop(): void {
    this.running = false;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
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

  private scheduleFallbackCheck(): void {
    if (!this.running) return;
    this.reconcileTimer = setTimeout(
      () => void this.fallbackCheckAndReschedule(),
      STEAM_COMMENT_RECONCILE_INTERVAL_MS,
    );
  }

  private async fallbackCheckAndReschedule(): Promise<void> {
    try {
      await this.checkComments("fallback");
    } finally {
      this.scheduleFallbackCheck();
    }
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
    const comments = await steamCommunityClient.getProfileComments(
      profileId,
      STEAM_COMMENT_FETCH_COUNT,
    );
    const commentIds = comments.flatMap((comment) => {
      const commentId = getCommentId(comment);
      return commentId ? [commentId] : [];
    });

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
      return getCommentAuthorSteamId(comment) !== profileId;
    });

    const processedIds: string[] = [];
    for (const comment of newComments) {
      const commentId = getCommentId(comment);
      if (!commentId) continue;
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
        replied: processedIds.length,
      },
      "Steam profile comments checked",
    );
  }

  private async replyToComment(
    profileId: string,
    comment: SteamUserComment,
    commentId: string,
  ): Promise<void> {
    const authorSteamId = getCommentAuthorSteamId(comment);
    const authorName = getCommentAuthorName(comment);
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

    const { comment: steamReply, truncated } =
      normalizeSteamProfileComment(reply);
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
      { profileId, commentId, replyCommentId, authorSteamId, truncated },
      "Replied to Steam profile comment",
    );
  }
}

export const steamProfileCommentService = new SteamProfileCommentService();
