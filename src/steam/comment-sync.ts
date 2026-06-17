import { dateToTime } from "../utils/date";

export interface VisibleSteamComment {
  id: string;
  date: Date;
}

export interface ArchivedSteamComment {
  commentId: string;
  timestamp: Date;
}

export interface SteamCommentWindow {
  comments: VisibleSteamComment[];
  totalCount: number;
}

function isSyntheticCommentId(commentId: string): boolean {
  return commentId.startsWith("ruyi:");
}

function oldestVisibleCommentTime(comments: VisibleSteamComment[]): number | null {
  const times = comments.flatMap((comment) => {
    const time = dateToTime(comment.date);
    return time === null ? [] : [time];
  });
  if (times.length === 0) return null;
  return Math.min(...times);
}

export function findDeletedSteamCommentIds(
  archivedComments: ArchivedSteamComment[],
  visibleWindow: SteamCommentWindow,
): string[] {
  const visibleIds = new Set(
    visibleWindow.comments.map((comment) => comment.id),
  );
  const fetchedWholeProfile =
    visibleWindow.totalCount <= visibleWindow.comments.length;
  const oldestVisibleTime = oldestVisibleCommentTime(visibleWindow.comments);

  return archivedComments
    .filter((comment) => {
      if (isSyntheticCommentId(comment.commentId)) return false;
      if (visibleIds.has(comment.commentId)) return false;
      if (fetchedWholeProfile) return true;
      if (oldestVisibleTime === null) return false;
      const archivedTime = dateToTime(comment.timestamp);
      return archivedTime === null ? false : archivedTime >= oldestVisibleTime;
    })
    .map((comment) => comment.commentId);
}
