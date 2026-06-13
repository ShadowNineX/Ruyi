import { tool } from "@openai/agents";
import { z } from "zod";
import { toolLogger } from "../logger";
import { toolContextManager, formatError } from "../utils/types";
import {
  buildDiscordProfile,
  normalizeUserLookup,
  resolveGuildMember,
} from "../utils/discord-profile";

export const userInfoTool = tool({
  name: "get_user_info",
  description:
    "Get information about a Discord user by username, including public profile image URLs and profile metadata. For avatar/banner visual questions, call this tool, then call describe_image with the relevant profile.availableImageTargets URL. Date responses include ISO strings; use Discord timestamps when replying.",
  parameters: z.object({
    username: z
      .string()
      .min(1)
      .describe("Username, display name, mention, or Discord user ID to look up."),
  }),
  execute: async ({ username }) => {
    const { guild } = toolContextManager.get();
    if (!guild) {
      toolLogger.warn("get_user_info called without guild context");
      return { error: "Not in a server" };
    }
    toolLogger.debug({ username }, "Looking up user");
    try {
      const lookup = normalizeUserLookup(username);
      if (!lookup) {
        return { error: "Username cannot be empty" };
      }
      const member = await resolveGuildMember(guild, lookup);

      if (!member) {
        toolLogger.warn({ username }, "User not found");
        return { error: "User not found: " + username };
      }
      const user = member.user;
      const profile = await buildDiscordProfile(member);
      toolLogger.info({ username, found: member.user.username }, "Found user");
      return {
        username: user.username,
        globalName: user.globalName,
        displayName: member.displayName,
        id: user.id,
        discriminator: user.discriminator,
        bot: user.bot,
        profile,
        avatar: profile.avatar.display.url,
        banner: profile.banner.display.url,
        accentColor: profile.accentColor,
        hexAccentColor: profile.hexAccentColor,
        avatarDecoration: profile.avatarDecoration.display,
        nameplate: profile.collectibles.nameplate,
        primaryGuild: profile.primaryGuild,
        privacyNote:
          "Only public Discord profile/member metadata visible to this bot is returned. Private account data and unexposed profile effects are not available.",
        visualInspectionInstruction:
          "If the user asks what an avatar, banner, decoration, nameplate, or badge looks like, call describe_image with the matching URL from profile.availableImageTargets. Do not infer visual details from the URL alone.",
        createdAt: user.createdAt?.toISOString(),
        joinedServer: member.joinedAt?.toISOString() ?? null,
        nickname: member.nickname,
        pending: member.pending,
        communicationDisabledUntil:
          member.communicationDisabledUntil?.toISOString() ?? null,
        premiumSince: member.premiumSince?.toISOString() ?? null,
        roles: member.roles.cache
          .filter((r) => r.name !== "@everyone")
          .map((r) => ({ name: r.name, color: r.hexColor })),
        highestRole: member.roles.highest.name,
        isOwner: member.id === guild.ownerId,
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { username, error: errorMessage },
        "Error fetching user",
      );
      return { error: "Failed to fetch user: " + username, details: errorMessage };
    }
  },
});
