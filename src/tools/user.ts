import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toolLogger } from "../logger";
import { toolContextManager } from "../utils/types";

export const userInfoTool = defineTool("get_user_info", {
  description:
    "Get information about a Discord user by username. The response includes Discord timestamp embeds (like <t:123456789:F>) for dates - use these EXACTLY as-is in your response so Discord renders them as interactive timestamps users can hover over.",
  parameters: z.object({
    username: z.string().describe("Username to look up"),
  }),
  handler: async ({ username }) => {
    const { guild } = toolContextManager.get();
    if (!guild) {
      toolLogger.warn("get_user_info called without guild context");
      return { error: "Not in a server" };
    }
    toolLogger.debug({ username }, "Looking up user");
    try {
      const members = await guild.members.fetch({ query: username, limit: 10 });
      const member =
        members.find(
          (m) => m.user.username.toLowerCase() === username.toLowerCase(),
        ) || members.first();
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
      toolLogger.error({ username, error }, "Error fetching user");
      return { error: "Failed to fetch user: " + username };
    }
  },
});
