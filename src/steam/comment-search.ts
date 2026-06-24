import type { MessageMatchType, RankedMessageMatch, SearchableMessage } from '../utils/message-search';
import type { SteamProfileComment } from './client';
import {

  rankMessageMatches,

  summarizeMessageSearchMatches,
} from '../utils/message-search';
import { steamCommunityClient } from './client';

const STEAM_COMMENT_SEARCH_FETCH_LIMIT = 50;

export interface SteamCommentContextItem {
  id: string;
  author: string;
  authorSteamId: string;
  content: string;
  timestamp: Date;
}

export interface SteamCommentSearchMatch extends SteamCommentContextItem {
  profileId: string;
  matchType: MessageMatchType;
  matchScore: number;
  fuseScore: number | null;
  matchedTerms: string[];
  missingTerms: string[];
  contextBefore: SteamCommentContextItem[];
  contextAfter: SteamCommentContextItem[];
}

interface SteamCommentSearchDocument extends SearchableMessage {
  comment: SteamProfileComment;
  profileId: string;
  index: number;
}

export interface SteamCommentSearchResult {
  matches: SteamCommentSearchMatch[];
  summary: ReturnType<typeof summarizeMessageSearchMatches>;
  searchedCommentCount: number;
}

function truncateContent(content: string, maxLen = 200): string {
  return content.length > maxLen
    ? `${content.slice(0, maxLen - 3)}...`
    : content;
}

export function formatSteamCommentForTool(comment: SteamProfileComment) {
  return {
    id: comment.id,
    authorName: comment.authorName,
    authorSteamId: comment.authorSteamId,
    date: comment.date.toISOString(),
    text: comment.text,
  };
}

function buildContextItem(
  comment: SteamProfileComment,
): SteamCommentContextItem {
  return {
    id: comment.id,
    author: comment.authorName,
    authorSteamId: comment.authorSteamId,
    content: truncateContent(comment.text),
    timestamp: comment.date,
  };
}

function buildSearchDocuments(
  profileId: string,
  comments: SteamProfileComment[],
  authorFilter: string | null,
): SteamCommentSearchDocument[] {
  const normalizedAuthorFilter = authorFilter?.trim().toLowerCase() ?? '';
  return comments.flatMap((comment, index) => {
    const authorMatches
      = !normalizedAuthorFilter
        || comment.authorName.toLowerCase().includes(normalizedAuthorFilter)
        || comment.authorSteamId.includes(normalizedAuthorFilter);
    if (!authorMatches) { return []; }

    return {
      id: comment.id,
      author: comment.authorName,
      content: comment.text,
      timestamp: comment.date,
      comment,
      profileId,
      index,
    };
  });
}

function buildContextWindow(
  documents: SteamCommentSearchDocument[],
  index: number,
): Pick<SteamCommentSearchMatch, 'contextBefore' | 'contextAfter'> {
  return {
    contextBefore: documents
      .slice(Math.max(0, index - 2), index)
      .map(document => buildContextItem(document.comment)),
    contextAfter: documents
      .slice(index + 1, index + 3)
      .map(document => buildContextItem(document.comment)),
  };
}

function buildSearchMatch(
  documents: SteamCommentSearchDocument[],
  match: RankedMessageMatch<SteamCommentSearchDocument>,
): SteamCommentSearchMatch {
  const { comment, profileId, index } = match.item;
  return {
    ...buildContextItem(comment),
    profileId,
    matchType: match.matchType,
    matchScore: Number(match.score.toFixed(3)),
    fuseScore:
      match.fuseScore === null ? null : Number(match.fuseScore.toFixed(3)),
    matchedTerms: match.matchedTerms,
    missingTerms: match.missingTerms,
    ...buildContextWindow(documents, index),
  };
}

export async function searchSteamProfileComments(
  profileId: string,
  query: string,
  authorFilter: string | null,
  limit: number,
  accountId?: string | null,
): Promise<SteamCommentSearchResult> {
  const comments = await steamCommunityClient.getProfileComments(
    profileId,
    Math.max(limit, STEAM_COMMENT_SEARCH_FETCH_LIMIT),
    accountId,
  );
  const documents = buildSearchDocuments(profileId, comments, authorFilter);
  const matches = rankMessageMatches(documents, query, limit);

  return {
    matches: matches.map(match => buildSearchMatch(documents, match)),
    summary: summarizeMessageSearchMatches(matches),
    searchedCommentCount: comments.length,
  };
}
