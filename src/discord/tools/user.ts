import { tool } from "@openai/agents";
import type { Guild, GuildMember, User } from "discord.js";
import { z } from "zod";
import { toolLogger } from "../../logger";
import { toolContextManager, formatError } from "../../utils/types";
import {
  buildDiscordPresence,
  buildDiscordProfile,
  buildDiscordUserProfile,
  type DiscordPresenceInfo,
  type DiscordProfile,
  normalizeUserLookup,
  resolveGuildMember,
  unavailableDiscordPresence,
} from "../utils/discord-profile";

const USER_ID_REGEX = /^\d{17,20}$/;
const USER_INFO_INCLUDES = [
  "images",
  "activity",
  "member",
  "roles",
  "profile",
] as const;
const DEFAULT_USER_INFO_INCLUDES = ["images", "activity"] as const;
const userInfoIncludeSchema = z.enum(USER_INFO_INCLUDES);

type UserInfoInclude = z.infer<typeof userInfoIncludeSchema>;
type UserInfoPayload = Record<string, unknown>;

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

async function resolvePrivateChatUser(
  lookup: string,
  messageUser: User,
): Promise<User | null> {
  if (matchesCurrentUserLookup(lookup, messageUser)) {
    return messageUser.fetch(true);
  }

  if (USER_ID_REGEX.test(lookup)) {
    return messageUser.client.users.fetch(lookup, { force: true });
  }

  return null;
}

function normalizeIncludes(includes: UserInfoInclude[]): Set<UserInfoInclude> {
  return new Set(includes);
}

function buildBaseUserInfo(
  user: User,
  displayName: string,
  profile: DiscordProfile,
): UserInfoPayload {
  return {
    username: user.username,
    globalName: user.globalName,
    displayName,
    id: user.id,
    discriminator: user.discriminator,
    bot: user.bot,
    privacyNote:
      "Only public Discord profile/member metadata visible to this bot is returned. Private account data and unexposed profile effects are not available.",
    createdAt: user.createdAt?.toISOString(),
    profileUnavailable: profile.unavailable,
  };
}

function addImageInfo(
  payload: UserInfoPayload,
  profile: DiscordProfile,
): void {
  payload.images = {
    avatar: profile.avatar.display,
    banner: profile.banner.display,
    avatarDecoration: profile.avatarDecoration.display,
    nameplate: profile.collectibles.nameplate,
    primaryGuild: profile.primaryGuild,
    availableImageTargets: profile.availableImageTargets,
    unavailable: profile.unavailable,
  };
  payload.avatar = profile.avatar.display.url;
  payload.banner = profile.banner.display.url;
  payload.avatarDecoration = profile.avatarDecoration.display;
  payload.nameplate = profile.collectibles.nameplate;
  payload.primaryGuild = profile.primaryGuild;
  payload.visualInspectionInstruction =
    "If the user asks what an avatar, banner, decoration, nameplate, or badge looks like, call describe_image with the matching URL from images.availableImageTargets. Do not infer visual details from the URL alone.";
}

function addActivityInfo(
  payload: UserInfoPayload,
  presence: DiscordPresenceInfo,
): void {
  payload.presence = presence;
  payload.status = presence.status;
  payload.activities = presence.activities;
}

function addProfileInfo(
  payload: UserInfoPayload,
  profile: DiscordProfile,
): void {
  payload.profile = profile;
}

function addSelectedProfileSections(
  payload: UserInfoPayload,
  includes: Set<UserInfoInclude>,
  profile: DiscordProfile,
  presence: DiscordPresenceInfo,
): void {
  if (includes.has("images")) addImageInfo(payload, profile);
  if (includes.has("activity")) addActivityInfo(payload, presence);
  if (includes.has("profile")) addProfileInfo(payload, profile);
}

function addPrivateChatMemberInfo(payload: UserInfoPayload): void {
  payload.member = {
    joinedServer: null,
    nickname: null,
    pending: null,
    communicationDisabledUntil: null,
    premiumSince: null,
    isOwner: false,
  };
}

function addPrivateChatRoleInfo(payload: UserInfoPayload): void {
  payload.roles = [];
  payload.highestRole = null;
  payload.isOwner = false;
}

function addGuildMemberInfo(
  payload: UserInfoPayload,
  member: GuildMember,
  ownerId: string,
): void {
  const isOwner = member.id === ownerId;
  const joinedServer = member.joinedAt?.toISOString() ?? null;
  const communicationDisabledUntil =
    member.communicationDisabledUntil?.toISOString() ?? null;
  const premiumSince = member.premiumSince?.toISOString() ?? null;

  payload.member = {
    joinedServer,
    nickname: member.nickname,
    pending: member.pending,
    communicationDisabledUntil,
    premiumSince,
    isOwner,
  };
  payload.joinedServer = joinedServer;
  payload.nickname = member.nickname;
  payload.pending = member.pending;
  payload.communicationDisabledUntil = communicationDisabledUntil;
  payload.premiumSince = premiumSince;
  payload.isOwner = isOwner;
}

function addGuildRoleInfo(
  payload: UserInfoPayload,
  member: GuildMember,
  ownerId: string,
): void {
  payload.roles = member.roles.cache
    .filter((role) => role.name !== "@everyone")
    .map((role) => ({ name: role.name, color: role.hexColor }));
  payload.highestRole = member.roles.highest.name;
  payload.isOwner = member.id === ownerId;
}

async function buildPrivateChatUserInfo(
  lookup: string,
  requester: User,
  includes: Set<UserInfoInclude>,
): Promise<UserInfoPayload> {
  const user = await resolvePrivateChatUser(lookup, requester);

  if (!user) {
    return {
      error:
        "In private chats I can only look up you, a mention, or a Discord user ID.",
    };
  }

  const profile = await buildDiscordUserProfile(user);
  const presence = unavailableDiscordPresence(
    "Current Discord presence/activity is only available for server members when the Guild Presences intent is enabled.",
  );
  const payload = buildBaseUserInfo(
    user,
    user.globalName ?? user.username,
    profile,
  );
  addSelectedProfileSections(payload, includes, profile, presence);
  if (includes.has("member")) addPrivateChatMemberInfo(payload);
  if (includes.has("roles")) addPrivateChatRoleInfo(payload);
  payload.privacyNote =
    "Only public Discord profile metadata visible to this bot is returned. Server-specific member data is unavailable in private chats.";
  toolLogger.info({ lookup, found: user.username }, "Found user");
  return payload;
}

async function buildGuildUserInfo(
  guild: Guild,
  lookup: string,
  includes: Set<UserInfoInclude>,
): Promise<UserInfoPayload> {
  const member = await resolveGuildMember(guild, lookup);

  if (!member) {
    toolLogger.warn({ lookup }, "User not found");
    return { error: "User not found: " + lookup };
  }

  const profile = await buildDiscordProfile(member);
  const presence = buildDiscordPresence(member);
  const payload = buildBaseUserInfo(member.user, member.displayName, profile);
  addSelectedProfileSections(payload, includes, profile, presence);
  if (includes.has("member")) addGuildMemberInfo(payload, member, guild.ownerId);
  if (includes.has("roles")) addGuildRoleInfo(payload, member, guild.ownerId);
  toolLogger.info({ lookup, found: member.user.username }, "Found user");
  return payload;
}

export const userInfoTool = tool({
  name: "get_user_info",
  description:
    "Get selected information about a Discord user by username. Use include=['activity'] for online status/game/listening/watching, include=['images'] for avatar/banner/decoration URLs, include=['member'] for join/account dates, include=['roles'] for server roles, and include=['profile'] only when the full raw profile object is needed. For avatar/banner visual questions, call this tool with include=['images'], then call describe_image with the relevant images.availableImageTargets URL. Date responses include ISO strings; use Discord timestamps when replying.",
  parameters: z.object({
    username: z
      .string()
      .min(1)
      .describe("Username, display name, mention, or Discord user ID to look up."),
    include: z
      .array(userInfoIncludeSchema)
      .default([...DEFAULT_USER_INFO_INCLUDES])
      .describe(
        "Which user data sections to return. Keep this narrow: use ['activity'] for status/game/activity, ['images'] for avatar/banner visuals, ['member'] for account/server dates, ['roles'] for role data, and ['profile'] only for the full profile object.",
      ),
  }),
  execute: async ({ username, include }) => {
    const { guild, message } = toolContextManager.get();
    const includes = normalizeIncludes(include);
    toolLogger.debug({ username, include }, "Looking up user");
    try {
      const lookup = normalizeUserLookup(username);
      if (!lookup) {
        return { error: "Username cannot be empty" };
      }

      if (guild) {
        return await buildGuildUserInfo(guild, lookup, includes);
      }

      if (!message) {
        return { error: "User lookup needs active Discord context" };
      }

      return await buildPrivateChatUserInfo(lookup, message.author, includes);
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { username, include, error: errorMessage },
        "Error fetching user",
      );
      return { error: "Failed to fetch user: " + username, details: errorMessage };
    }
  },
});
