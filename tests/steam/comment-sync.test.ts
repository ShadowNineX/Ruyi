import { describe, expect, test } from "bun:test";
import { findDeletedSteamCommentIds } from "../../src/steam/comment-sync";

describe("Steam comment deletion sync", () => {
  test("removes archived comments missing from a fully fetched profile", () => {
    const now = new Date("2026-06-17T10:00:00.000Z");

    expect(
      findDeletedSteamCommentIds(
        [
          { commentId: "kept", timestamp: now },
          { commentId: "deleted", timestamp: now },
        ],
        {
          totalCount: 1,
          comments: [{ id: "kept", date: now }],
        },
      ),
    ).toEqual(["deleted"]);
  });

  test("does not remove older comments outside a partial fetched window", () => {
    expect(
      findDeletedSteamCommentIds(
        [
          {
            commentId: "older-archived",
            timestamp: new Date("2026-06-16T10:00:00.000Z"),
          },
          {
            commentId: "missing-recent",
            timestamp: new Date("2026-06-17T10:00:00.000Z"),
          },
        ],
        {
          totalCount: 50,
          comments: [
            {
              id: "newest",
              date: new Date("2026-06-17T11:00:00.000Z"),
            },
            {
              id: "oldest-visible",
              date: new Date("2026-06-17T09:00:00.000Z"),
            },
          ],
        },
      ),
    ).toEqual(["missing-recent"]);
  });

  test("keeps synthetic bot reply IDs", () => {
    expect(
      findDeletedSteamCommentIds(
        [
          {
            commentId: "ruyi:source-comment:1781690400",
            timestamp: new Date("2026-06-17T10:00:00.000Z"),
          },
        ],
        { totalCount: 0, comments: [] },
      ),
    ).toEqual([]);
  });

  test("ignores invalid dates in partial fetched windows", () => {
    expect(
      findDeletedSteamCommentIds(
        [
          {
            commentId: "archived-invalid-date",
            timestamp: new Date("invalid"),
          },
        ],
        {
          totalCount: 50,
          comments: [
            {
              id: "visible-invalid-date",
              date: new Date("invalid"),
            },
          ],
        },
      ),
    ).toEqual([]);
  });
});
