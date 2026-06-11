import { tool } from "@openai/agents";
import { z } from "zod";
import { toolLogger } from "../logger";
import { toolContextManager, formatError } from "../utils/types";

const USER_ID_REGEX = /^\d{17,20}$/;
const USER_MENTION_REGEX = /^<@!?(\d{17,20})>$/;

function normalizeUserLookup(query: string): string {
  return USER_MENTION_REGEX.exec(query.trim())?.[1] ?? query.trim();
}

export const userInfoTool = tool({
  name: "get_user_info",
  description:
    "Get information about a Discord user by username. The response includes Discord timestamp embeds (like <t:123456789:F>) for dates - use these EXACTLY as-is in your response so Discord renders them as interactive timestamps users can hover over.",
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
      const lowerLookup = lookup.toLowerCase();

      let member = USER_ID_REGEX.test(lookup)
        ? await guild.members.fetch(lookup).catch((error: unknown) => {
            toolLogger.debug(
              { username, error: formatError(error) },
              "Could not fetch member by ID",
            );
            return null;
          })
        : null;

      const members = member
        ? null
        : await guild.members.fetch({ query: lookup, limit: 10 });
      member ??=
        members?.find(
          (m) =>
            m.user.username.toLowerCase() === lowerLookup ||
            m.displayName.toLowerCase() === lowerLookup ||
            m.user.globalName?.toLowerCase() === lowerLookup,
        ) ??
        members?.first() ??
        null;

      if (!member) {
        toolLogger.warn({ username }, "User not found");
        return { error: "User not found: " + username };
      }
      const user = member.user;
      toolLogger.info({ username, found: member.user.username }, "Found user");
      return {
        username: user.username,
        displayName: member.displayName,
        id: user.id,
        discriminator: user.discriminator,
        bot: user.bot,
        avatar: user.avatarURL(),
        banner: user.bannerURL(),
        accentColor: user.accentColor,
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
