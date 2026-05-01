import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toolLogger } from "../logger";
import { toolContextManager } from "../utils/types";

export const serverInfoTool = defineTool("get_server_info", {
  description: "Get information about the current Discord server",
  parameters: z.object({}),
  handler: async () => {
    const { guild } = toolContextManager.get();
    if (!guild) {
      toolLogger.warn("get_server_info called without guild context");
      return { error: "Not in a server" };
    }
    toolLogger.info({ server: guild.name }, "Got server info");
    const members = await guild.members.fetch();
    const list = members.map((m) => ({
      id: m.user.id,
      username: m.user.username,
      globalName: m.user.globalName,
      tag: m.user.tag,
      avatar: m.user.avatarURL(),
      banner: m.user.bannerURL(),
      joinedAt: m.joinedAt?.toISOString() ?? null,
      createdAt: m.user.createdAt.toISOString(),
      isBot: m.user.bot,
      roles: m.roles.cache.map((r) => r.name),
    }));
    return {
      server: {
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL(),
      },
      memberCount: members.size,
      members: list,
    };
  },
});
