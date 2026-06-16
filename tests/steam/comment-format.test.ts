import { describe, expect, test } from "bun:test";
import { STEAM_PROFILE_COMMENT_MAX_LENGTH } from "../../src/constants";
import { normalizeSteamProfileComment } from "../../src/steam/comment-format";

describe("Steam profile comment formatting", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizeSteamProfileComment("  hello from Ruyi  ")).toEqual({
      comment: "hello from Ruyi",
      truncated: false,
    });
  });

  test("keeps Steam BBCode text intact", () => {
    expect(normalizeSteamProfileComment("[b]hello[/b] [url=https://example.com]link[/url]")).toEqual({
      comment: "[b]hello[/b] [url=https://example.com]link[/url]",
      truncated: false,
    });
  });

  test("truncates overlong comments to Steam's configured limit", () => {
    const result = normalizeSteamProfileComment(
      "x".repeat(STEAM_PROFILE_COMMENT_MAX_LENGTH + 50),
    );

    expect(result.truncated).toBe(true);
    expect(result.comment).toHaveLength(STEAM_PROFILE_COMMENT_MAX_LENGTH);
    expect(result.comment.endsWith("...")).toBe(true);
  });
});
