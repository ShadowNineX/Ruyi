import { tool } from "@openai/agents";
import { z } from "zod";
import { toolLogger } from "../logger";
import { toolContextManager } from "../utils/types";

export const serverInfoTool = tool({
  name: "get_server_info",
  description: "Get information about the current Discord server",
  parameters: z.object({
    include_members: z
      .boolean()
      .nullable()
      .describe(
        "Whether to include a bounded sample of cached members. Use get_user_info for specific users.",
      ),
    member_limit: z
      .number()
      .nullable()
      .describe("Maximum cached members to include when include_members is true (1-50)."),
  }),
  execute: async ({ include_members, member_limit }) => {
    const { guild } = toolContextManager.get();
    if (!guild) {
      toolLogger.warn("get_server_info called without guild context");
      return { error: "Not in a server" };
    }

    const memberLimit = Math.min(
      Math.max(Math.round(member_limit ?? 10), 1),
      50,
    );
    const cachedMembers = [...guild.members.cache.values()]
      .slice(0, memberLimit)
      .map((m) => ({
        id: m.user.id,
        username: m.user.username,
        displayName: m.displayName,
        globalName: m.user.globalName,
        isBot: m.user.bot,
        joinedAt: m.joinedAt?.toISOString() ?? null,
      }));
    const roles = [...guild.roles.cache.values()]
      .filter((role) => role.name !== "@everyone")
      .sort((a, b) => b.position - a.position)
      .slice(0, 25)
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.hexColor,
        memberCount: role.members.size,
      }));

    toolLogger.info({ server: guild.name }, "Got server info");

    return {
      server: {
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL(),
        ownerId: guild.ownerId,
        createdAt: guild.createdAt.toISOString(),
        description: guild.description,
        premiumTier: guild.premiumTier,
      },
      counts: {
        members: guild.memberCount,
        cachedMembers: guild.members.cache.size,
        roles: guild.roles.cache.size,
        channels: guild.channels.cache.size,
        emojis: guild.emojis.cache.size,
        stickers: guild.stickers.cache.size,
      },
      roles,
      ...(include_members
        ? { cachedMembers }
        : {
            hint:
              "Members are omitted by default to keep responses bounded. Use get_user_info for a specific user.",
          }),
    };
  },
});
