import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toolLogger } from "../logger";
import { toolContextManager } from "../utils/types";

export const channelInfoTool = defineTool("get_channel_info", {
  description: "Get information about the current Discord channel",
  parameters: z.object({}),
  handler: async () => {
    const { channel } = toolContextManager.get();
    if (!channel) {
      toolLogger.warn("get_channel_info called without channel context");
      return { error: "No channel context" };
    }
    toolLogger.info({ channel: channel.name }, "Got channel info");
    return {
      name: channel.name,
      id: channel.id,
      topic: channel.topic || "No topic",
    };
  },
});
