import { STEAM_PROFILE_COMMENT_MAX_LENGTH } from "../constants";

export interface SteamCommentFormatResult {
  comment: string;
  truncated: boolean;
}

function truncateSteamComment(comment: string): SteamCommentFormatResult {
  if (comment.length <= STEAM_PROFILE_COMMENT_MAX_LENGTH) {
    return { comment, truncated: false };
  }

  const suffix = "...";
  const truncated = comment
    .slice(0, STEAM_PROFILE_COMMENT_MAX_LENGTH - suffix.length)
    .trimEnd();
  return { comment: `${truncated}${suffix}`, truncated: true };
}

export function normalizeSteamProfileComment(
  message: string,
): SteamCommentFormatResult {
  return truncateSteamComment(message.trim());
}
