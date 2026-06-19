import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { ToolContext } from "../../src/utils/types";
import type { SteamProfileComment } from "../../src/steam/client";

let mockProfileComments: SteamProfileComment[] = [];

mock.module("../../src/steam/client", () => ({
  steamCommunityClient: {
    getProfileComments: async (_profileId: string, limit: number) =>
      mockProfileComments.slice(0, limit),
    onCommentNotification: () => () => undefined,
    postProfileComment: async () => "mock-comment-id",
    start: async () => undefined,
    stop: () => undefined,
  },
}));

interface ApprovalCapableTool {
  name: string;
  needsApproval(
    runContext: unknown,
    input: unknown,
    callId?: string,
  ): Promise<boolean>;
}

interface InvokableTool {
  name: string;
  invoke(runContext: unknown, input: string): Promise<unknown>;
}

let runWithToolContext: typeof import("../../src/utils/types").runWithToolContext;
let steamProfileCommentTool: ApprovalCapableTool;
let steamProfileCommentsTool: InvokableTool;
let getToolNamesForSurface: typeof import("../../src/tools").getToolNamesForSurface;
let searchSteamProfileComments: typeof import("../../src/steam/comment-search").searchSteamProfileComments;

function baseContext(surface: ToolContext["surface"]): ToolContext {
  return {
    surface,
    identity: null,
    message: null,
    channel: null,
    guild: null,
    referencedMessage: null,
    steam:
      surface === "steam"
        ? { profileId: "76561198000000002", sourceCommentId: "comment-1" }
        : undefined,
  };
}

beforeAll(async () => {
  ({ runWithToolContext } = await import("../../src/utils/types"));
  ({ steamProfileCommentTool, steamProfileCommentsTool } = await import(
    "../../src/steam/tools/profile-comment"
  ) as unknown as {
    steamProfileCommentTool: ApprovalCapableTool;
    steamProfileCommentsTool: InvokableTool;
  });
  ({ getToolNamesForSurface } = await import("../../src/tools"));
  ({ searchSteamProfileComments } = await import(
    "../../src/steam/comment-search"
  ));
}, 30_000);

describe("steam_profile_comment approval", () => {
  test("requires approval in Discord-origin turns", async () => {
    const needsApproval = await runWithToolContext(
      baseContext("discord"),
      () =>
        steamProfileCommentTool.needsApproval(
          null,
          { target: "bot", message: "hello" },
          "call-1",
        ),
    );

    expect(needsApproval).toBe(true);
  });

  test("auto-approves in Steam-origin turns", async () => {
    const needsApproval = await runWithToolContext(
      baseContext("steam"),
      () =>
        steamProfileCommentTool.needsApproval(
          null,
          { target: "bot", message: "hello" },
          "call-2",
        ),
    );

    expect(needsApproval).toBe(false);
  });
});

describe("surface-aware Steam tools", () => {
  test("Steam turns get Steam-safe shared tools but not Discord-only tools", () => {
    const steamTools = getToolNamesForSurface("steam");

    expect(steamTools.has("steam_profile_comment")).toBe(true);
    expect(steamTools.has("search_conversation")).toBe(true);
    expect(steamTools.has("steam_profile_comments")).toBe(false);
    expect(steamTools.has("memory_recall")).toBe(true);
    expect(steamTools.has("web_search")).toBe(true);
    expect(steamTools.has("get_user_info")).toBe(false);
    expect(steamTools.has("manage_role")).toBe(false);
    expect(steamTools.has("send_embed")).toBe(false);
  });

  test("Discord turns keep Discord tools and can still explicitly post Steam comments", () => {
    const discordTools = getToolNamesForSurface("discord");

    expect(discordTools.has("get_user_info")).toBe(true);
    expect(discordTools.has("manage_role")).toBe(true);
    expect(discordTools.has("search_conversation")).toBe(true);
    expect(discordTools.has("steam_profile_comment")).toBe(true);
    expect(discordTools.has("steam_profile_comments")).toBe(true);
  });
});

describe("Steam comment fuzzy search", () => {
  test("finds exact and fuzzy comment matches with context", async () => {
    mockProfileComments = [
      {
        id: "comment-1",
        authorSteamId: "76561198000000001",
        authorName: "Alex",
        date: new Date("2026-06-19T10:00:00Z"),
        text: "Hey Ruyi, remember the blue fox quote for later.",
        html: "",
      },
      {
        id: "comment-2",
        authorSteamId: "76561198000000002",
        authorName: "Ruyi",
        date: new Date("2026-06-19T10:01:00Z"),
        text: "Of course, your humble servant will keep it close.",
        html: "",
      },
      {
        id: "comment-3",
        authorSteamId: "76561198000000001",
        authorName: "Alex",
        date: new Date("2026-06-19T10:02:00Z"),
        text: "Also I meant the bright fox quotation, not the old one.",
        html: "",
      },
    ];

    const result = await searchSteamProfileComments(
      "76561198000000003",
      "blue fox quote",
      null,
      5,
    );

    expect(result.matches[0]?.id).toBe("comment-1");
    expect(result.matches[0]?.matchType).toBe("exact_phrase");
    expect(result.matches[0]?.contextAfter[0]?.id).toBe("comment-2");
    expect(result.summary.bestMatchType).toBe("exact_phrase");
    expect(result.searchedCommentCount).toBe(3);
  });

  test("keeps author filtering inside Steam comment search", async () => {
    mockProfileComments = [
      {
        id: "comment-1",
        authorSteamId: "76561198000000001",
        authorName: "Alex",
        date: new Date("2026-06-19T10:00:00Z"),
        text: "Tails quote",
        html: "",
      },
      {
        id: "comment-2",
        authorSteamId: "76561198000000002",
        authorName: "Ruyi",
        date: new Date("2026-06-19T10:01:00Z"),
        text: "Tails quote",
        html: "",
      },
    ];

    const result = await searchSteamProfileComments(
      "76561198000000003",
      "Tails quote",
      "Ruyi",
      5,
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.author).toBe("Ruyi");
  });

  test("returns snake_case search summary from the Discord Steam bridge", async () => {
    mockProfileComments = [
      {
        id: "comment-1",
        authorSteamId: "76561198000000001",
        authorName: "Alex",
        date: new Date("2026-06-19T10:00:00Z"),
        text: "Remember the Tails quote.",
        html: "",
      },
    ];

    const result = (await steamProfileCommentsTool.invoke(
      null,
      JSON.stringify({
        target: "bot",
        query: "Tails quote",
        author: null,
        limit: 5,
      }),
    )) as { search_summary?: Record<string, unknown> };

    expect(result.search_summary?.exact_phrase_found).toBe(true);
    expect(result.search_summary?.best_match_type).toBe("exact_phrase");
    expect(result.search_summary?.exactPhraseFound).toBeUndefined();
  });
});
