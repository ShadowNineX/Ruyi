import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { ToolContext } from "../../src/utils/types";

mock.module("../../src/steam/client", () => ({
  steamCommunityClient: {
    getProfileComments: async () => [],
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

let runWithToolContext: typeof import("../../src/utils/types").runWithToolContext;
let steamProfileCommentTool: ApprovalCapableTool;
let getToolNamesForSurface: typeof import("../../src/tools").getToolNamesForSurface;

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
  ({ steamProfileCommentTool } = await import(
    "../../src/steam/tools/profile-comment"
  ) as unknown as { steamProfileCommentTool: ApprovalCapableTool });
  ({ getToolNamesForSurface } = await import("../../src/tools"));
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
    expect(steamTools.has("steam_profile_comments")).toBe(true);
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
    expect(discordTools.has("steam_profile_comment")).toBe(true);
  });
});
