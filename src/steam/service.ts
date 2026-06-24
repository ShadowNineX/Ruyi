import type { ChatMessage } from '../ai';
import type { SteamAccountConfig } from './accounts';
import type { SteamProfileComment } from './client';
import type { SteamCommentWindow } from './comment-sync';
import {

  chatService,
  conversationContext,
  sessionManager,
} from '../ai';
import { steamProfileConfigScope } from '../config';
import {
  SteamAgentSession,
  SteamCommentState,
  SteamConversation,
} from '../db/models';
import { botLogger } from '../logger';
import {
  hasPendingSteamProfileCommentCheck,
  isSteamProfileCommentCheckProcessing,
  isSteamProfileCommentServiceRunning,
  setPendingSteamProfileCommentCheck,
  setSteamProfileCommentCheckProcessing,
  setSteamProfileCommentServiceRunning,
} from '../stores/steam-service-store';
import { runWithToolContext } from '../utils/types';
import {
  buildSteamUserIdentity,
} from '../utils/user-identity';
import {
  getSteamAccountDisplayName,
  getSteamAccounts,
  steamIntegrationEnabled,
} from './accounts';
import {
  steamCommunityClient,

} from './client';
import { normalizeSteamProfileComment } from './comment-format';
import {
  findDeletedSteamCommentIds,

} from './comment-sync';
import { HeadlessChatSession } from './headless-session';

const STEAM_COMMENT_CHECK_OVERLAP_MS = 2 * 60_000;
const STEAM_COMMENT_FETCH_COUNT = 100;
const STEAM_CHAT_HISTORY_LIMIT = 25;
const SEEN_COMMENT_CAP = 500;

type CommentCheckReason = 'startup' | 'notification' | 'queued' | 'reconnect';

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
    comments: comments.map(comment => ({
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

function steamCommentToChatMessage(
  profileId: string,
  botDisplayName: string,
  comment: SteamProfileComment,
): ChatMessage {
  const isBot = comment.authorSteamId === profileId;
  return {
    author: isBot ? botDisplayName : comment.authorName,
    content: comment.text,
    isBot,
  };
}

export function buildSteamChatHistory(
  profileId: string,
  botDisplayName: string,
  comments: SteamProfileComment[],
  currentCommentId: string,
): ChatMessage[] {
  const sortedComments = sortCommentsOldestFirst(comments);
  const currentIndex = sortedComments.findIndex(
    comment => comment.id === currentCommentId,
  );
  const previousComments
    = currentIndex >= 0
      ? sortedComments.slice(0, currentIndex)
      : sortedComments.filter(comment => comment.id !== currentCommentId);

  return previousComments
    .slice(-STEAM_CHAT_HISTORY_LIMIT)
    .map(comment => steamCommentToChatMessage(profileId, botDisplayName, comment));
}

function commentWasAlreadyHandled(
  comment: SteamProfileComment,
  seenIds: Set<string>,
  lastCheckedAt: Date,
): boolean {
  const cutoff
    = seenIds.size > 0
      ? lastCheckedAt.getTime() - STEAM_COMMENT_CHECK_OVERLAP_MS
      : lastCheckedAt.getTime();
  return (
    seenIds.has(comment.id)
    || comment.date.getTime() <= cutoff
  );
}

class SteamProfileCommentService {
  private unsubscribeCommentNotifications: Array<() => void> = [];
  private unsubscribeReadyNotifications: Array<() => void> = [];

  async start(): Promise<void> {
    if (!steamIntegrationEnabled()) {
      botLogger.info('Steam profile comment chat disabled');
      return;
    }
    if (isSteamProfileCommentServiceRunning()) { return; }
    setSteamProfileCommentServiceRunning(true);

    this.subscribeToReadyNotifications();
    this.subscribeToCommentNotifications();

    try {
      await steamCommunityClient.startAll();
      await this.checkAllAccounts('startup');
    } catch (error) {
      botLogger.error(
        { error: getErrorMessage(error) },
        'Steam profile comment service failed during startup; reconnect will keep retrying',
      );
    }
  }

  stop(): void {
    setSteamProfileCommentServiceRunning(false);
    for (const unsubscribe of this.unsubscribeCommentNotifications) {
      unsubscribe();
    }
    for (const unsubscribe of this.unsubscribeReadyNotifications) {
      unsubscribe();
    }
    this.unsubscribeCommentNotifications = [];
    this.unsubscribeReadyNotifications = [];
    for (const account of getSteamAccounts()) {
      setPendingSteamProfileCommentCheck(account.id, false);
    }
    steamCommunityClient.stop();
  }

  private subscribeToReadyNotifications(): void {
    if (this.unsubscribeReadyNotifications.length > 0) { return; }

    this.unsubscribeReadyNotifications = getSteamAccounts().map(account =>
      steamCommunityClient.onReady(account.id, () => {
        if (!isSteamProfileCommentServiceRunning()) { return; }

        botLogger.info(
          { accountId: account.id },
          'Steam profile comment service recovered web session',
        );
        void this.checkComments(account, 'reconnect');
      }),
    );
  }

  private subscribeToCommentNotifications(): void {
    if (this.unsubscribeCommentNotifications.length > 0) { return; }

    this.unsubscribeCommentNotifications = getSteamAccounts().map(account =>
      steamCommunityClient.onCommentNotification(
        account.id,
        (count, myItems, discussions) => {
          botLogger.debug(
            { accountId: account.id, count, myItems, discussions },
            'Steam comment notification received',
          );
          if (myItems <= 0) { return; }
          void this.checkComments(account, 'notification');
        },
      ),
    );
  }

  private async checkAllAccounts(reason: CommentCheckReason): Promise<void> {
    await Promise.all(
      getSteamAccounts().map(account => this.checkComments(account, reason)),
    );
  }

  private async checkComments(
    account: SteamAccountConfig,
    reason: CommentCheckReason,
  ): Promise<void> {
    if (!steamCommunityClient.isReady(account.id)) {
      botLogger.debug(
        { accountId: account.id, reason },
        'Skipping Steam profile comment check until account is ready',
      );
      return;
    }

    if (isSteamProfileCommentCheckProcessing(account.id)) {
      setPendingSteamProfileCommentCheck(account.id, true);
      return;
    }
    setSteamProfileCommentCheckProcessing(account.id, true);

    try {
      await this.processProfileComments(account, reason);
    } catch (error) {
      botLogger.error(
        { accountId: account.id, reason, error: getErrorMessage(error) },
        'Steam profile comment check failed',
      );
    } finally {
      setSteamProfileCommentCheckProcessing(account.id, false);
      if (
        hasPendingSteamProfileCommentCheck(account.id)
        && isSteamProfileCommentServiceRunning()
      ) {
        setPendingSteamProfileCommentCheck(account.id, false);
        void this.checkComments(account, 'queued');
      }
    }
  }

  private async processProfileComments(
    account: SteamAccountConfig,
    reason: CommentCheckReason,
  ): Promise<void> {
    const profileId = account.botSteamId64;
    const page = await steamCommunityClient.getProfileCommentPage(
      profileId,
      STEAM_COMMENT_FETCH_COUNT,
      account.id,
    );
    const { comments, totalCount } = page;
    const commentIds = comments.map(comment => comment.id);
    const deletedIds = await this.syncDeletedProfileComments(
      account.id,
      profileId,
      toSteamCommentWindow(comments, totalCount),
    );

    const state = await SteamCommentState.findOne({
      accountId: account.id,
      profileId,
    });
    if (!state) {
      await SteamCommentState.create({
        accountId: account.id,
        profileId,
        seenCommentIds: [],
        lastCheckedAt: new Date(),
      });
      botLogger.info(
        { accountId: account.id, personality: account.personality, profileId, reason },
        'Initialized Steam profile comment state',
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
        await this.replyToComment(account, comment, commentId, comments);
      } finally {
        processedIds.push(commentId);
      }
    }

    const seenCommentIds = mergeSeenCommentIds(state.seenCommentIds, [
      ...commentIds,
      ...processedIds,
    ]);
    await SteamCommentState.updateOne(
      { accountId: account.id, profileId },
      {
        $set: {
          seenCommentIds,
          lastCheckedAt: new Date(),
        },
      },
    );
    botLogger.debug(
      {
        accountId: account.id,
        personality: account.personality,
        profileId,
        reason,
        checked: comments.length,
        totalCount,
        replied: processedIds.length,
        deleted: deletedIds.length,
      },
      'Steam profile comments checked',
    );
  }

  private async syncDeletedProfileComments(
    accountId: string,
    profileId: string,
    visibleWindow: SteamCommentWindow,
  ): Promise<string[]> {
    const conversation = await SteamConversation.findOne(
      { accountId, profileId },
      { messages: 1 },
    );
    if (!conversation || conversation.messages.length === 0) { return []; }

    const deletedIds = findDeletedSteamCommentIds(
      conversation.messages.map(message => ({
        commentId: message.commentId,
        timestamp: message.timestamp,
      })),
      visibleWindow,
    );
    if (deletedIds.length === 0) { return []; }

    const activeSessionMatchesDeletedComment = await SteamAgentSession.exists({
      accountId,
      profileId,
      isActive: true,
      provider: 'openai-agents',
      processedCommentIds: { $in: deletedIds },
    });

    await Promise.all([
      SteamConversation.updateOne(
        { accountId, profileId },
        {
          $pull: { messages: { commentId: { $in: deletedIds } } },
          $set: { lastInteraction: new Date() },
        },
      ),
      SteamCommentState.updateOne(
        { accountId, profileId },
        { $pull: { seenCommentIds: { $in: deletedIds } } },
      ),
      SteamAgentSession.updateOne(
        { accountId, profileId },
        { $pull: { processedCommentIds: { $in: deletedIds } } },
      ),
    ]);

    if (activeSessionMatchesDeletedComment) {
      await sessionManager.invalidate(profileId, 'steam', accountId);
    }

    botLogger.info(
      {
        accountId,
        profileId,
        deletedCommentIds: deletedIds,
        invalidatedSession: Boolean(activeSessionMatchesDeletedComment),
      },
      'Removed deleted Steam comments from local context',
    );

    return deletedIds;
  }

  private async replyToComment(
    account: SteamAccountConfig,
    comment: SteamProfileComment,
    commentId: string,
    visibleComments: SteamProfileComment[],
  ): Promise<void> {
    const profileId = account.botSteamId64;
    const { authorSteamId, authorName } = comment;
    const identity = buildSteamUserIdentity(authorSteamId, authorName);
    const session = new HeadlessChatSession();
    const userMessage = buildSteamCommentPrompt(comment);

    const reply = await runWithToolContext(
      {
        surface: 'steam',
        identity,
        message: null,
        channel: null,
        guild: null,
        referencedMessage: null,
        steam: { accountId: account.id, profileId, sourceCommentId: commentId },
      },
      () =>
        chatService.chat({
          surface: 'steam',
          surfaceLabel: `Steam profile comments on ${getSteamAccountDisplayName(account)}'s bot profile`,
          personality: account.personality,
          sessionLabel: account.id,
          identity,
          userMessage,
          username: authorName,
          channelId: profileId,
          configScope: steamProfileConfigScope(profileId),
          userId: authorSteamId,
          session,
          messageId: commentId,
          messageTimestamp: comment.date,
          chatHistory: buildSteamChatHistory(
            profileId,
            getSteamAccountDisplayName(account),
            visibleComments,
            commentId,
          ),
          persistUserMessage: true,
        }),
    );

    if (!reply) {
      botLogger.warn(
        { profileId, commentId, authorSteamId },
        'Steam profile comment produced no reply',
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
        'Steam profile comment reply was empty after normalization',
      );
      return;
    }

    const replyCommentId = await steamCommunityClient.postProfileComment(
      profileId,
      steamReply,
      account.id,
    );
    await conversationContext.rememberSteamMessage({
      accountId: account.id,
      profileId,
      authorSteamId: profileId,
      authorName: getSteamAccountDisplayName(account),
      content: steamReply,
      isBot: true,
      commentId:
        replyCommentId
        ?? `steam:${account.id}:${commentId}:${Math.floor(Date.now() / 1000)}`,
    });
    botLogger.info(
      {
        accountId: account.id,
        personality: account.personality,
        profileId,
        commentId,
        replyCommentId,
        authorSteamId,
        truncated,
        removedUnsupportedFormatting,
        convertedAlignmentSpaces,
      },
      'Replied to Steam profile comment',
    );
  }
}

export const steamProfileCommentService = new SteamProfileCommentService();
