import { describe, expect, test } from "bun:test";
import {
  buildDiscordUserIdentity,
  buildSteamUserIdentity,
  resolveSteamProfileTarget,
  steamIntegrationEnabled,
} from "../../src/utils/user-identity";

describe("cross-surface user identity", () => {
  test("maps configured Discord and Steam owner ids to the same owner person", () => {
    expect(buildDiscordUserIdentity("discord-owner", "Shadow")).toMatchObject({
      surface: "discord",
      surfaceUserId: "discord-owner",
      username: "Shadow",
      personId: "owner",
      canWriteMemory: true,
    });

    expect(
      buildSteamUserIdentity("76561198000000001", "Shadow"),
    ).toMatchObject({
      surface: "steam",
      surfaceUserId: "76561198000000001",
      username: "Shadow",
      personId: "owner",
      canWriteMemory: true,
    });
  });

  test("keeps non-owner users isolated by surface", () => {
    expect(buildDiscordUserIdentity("123", "Guest")).toMatchObject({
      personId: "discord:123",
      canWriteMemory: true,
    });

    expect(buildSteamUserIdentity("76561198000009999", "Guest")).toMatchObject({
      personId: "steam:76561198000009999",
      canWriteMemory: false,
    });
  });

  test("resolves only whitelisted Steam profile targets", () => {
    expect(steamIntegrationEnabled()).toBe(true);
    expect(resolveSteamProfileTarget("owner")).toBe("76561198000000001");
    expect(resolveSteamProfileTarget("bot")).toBe("76561198000000002");
  });
});
