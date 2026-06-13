import { tool } from "@openai/agents";
import type { User } from "discord.js";
import { z } from "zod";
import { toolLogger } from "../logger";
import { toolContextManager, formatError } from "../utils/types";
import {
  buildDiscordProfile,
  buildDiscordUserProfile,
  normalizeUserLookup,
  resolveGuildMember,
} from "../utils/discord-profile";

const USER_ID_REGEX = /^\d{17,20}$/;

function matchesCurrentUserLookup(
  lookup: string,
  user: User,
): boolean {
  const lowerLookup = lookup.toLowerCase();
  return (
    lowerLookup === "me" ||
    lowerLookup === "myself" ||
    lookup === user.id ||
    lowerLookup === user.username.toLowerCase() ||
    user.globalName?.toLowerCase() === lowerLookup
  );
}

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
    const { guild, message } = toolContextManager.get();
    toolLogger.debug({ username }, "Looking up user");
    try {
      const lookup = normalizeUserLookup(username);
      if (!lookup) {
        return { error: "Username cannot be empty" };
      }

      if (!guild) {
        if (!message) {
          return { error: "User lookup needs active Discord context" };
        }

        const user = matchesCurrentUserLookup(lookup, message.author)
          ? await message.author.fetch(true)
          : USER_ID_REGEX.test(lookup)
            ? await message.client.users.fetch(lookup, { force: true })
            : null;

        if (!user) {
          return {
            error:
              "In private chats I can only look up you, a mention, or a Discord user ID.",
          };
        }

        const profile = await buildDiscordUserProfile(user);
        toolLogger.info({ username, found: user.username }, "Found user");
        return {
          username: user.username,
          globalName: user.globalName,
          displayName: user.globalName ?? user.username,
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
            "Only public Discord profile metadata visible to this bot is returned. Server-specific member data is unavailable in private chats.",
          visualInspectionInstruction:
            "If the user asks what an avatar, banner, decoration, nameplate, or badge looks like, call describe_image with the matching URL from profile.availableImageTargets. Do not infer visual details from the URL alone.",
          createdAt: user.createdAt?.toISOString(),
          joinedServer: null,
          nickname: null,
          pending: null,
          communicationDisabledUntil: null,
          premiumSince: null,
          roles: [],
          highestRole: null,
          isOwner: false,
        };
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
