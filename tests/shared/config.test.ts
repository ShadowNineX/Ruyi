import { describe, expect, test } from "bun:test";
import {
  configScopeKey,
  formatConfigScope,
  guildConfigScope,
  isAiModelPresetId,
  steamProfileConfigScope,
  userConfigScope,
} from "../../src/config";

describe("config scopes", () => {
  test("formats Discord guild and DM scope keys", () => {
    expect(configScopeKey(guildConfigScope("guild-1"))).toBe(
      "discord:guild:guild-1",
    );
    expect(configScopeKey(userConfigScope(null, "user-1"))).toBe(
      "discord:dm:user-1",
    );
  });

  test("prefers guild scope when a guild id is present", () => {
    expect(userConfigScope("guild-1", "user-1")).toEqual({
      kind: "discord:guild",
      id: "guild-1",
    });
  });

  test("supports Steam profile-scoped settings", () => {
    const scope = steamProfileConfigScope("76561198000000002");

    expect(configScopeKey(scope)).toBe("steam:profile:76561198000000002");
    expect(formatConfigScope(scope)).toBe("this Steam profile");
  });
});

describe("AI model preset validation", () => {
  test("accepts known preset ids and rejects unknown ids", () => {
    expect(isAiModelPresetId("balanced")).toBe(true);
    expect(isAiModelPresetId("deep")).toBe(true);
    expect(isAiModelPresetId("gpt-5.5")).toBe(false);
  });
});
