import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toolLogger } from "../logger";
import { lastFMClient, type Period } from "../lib/lastfm";

export const lastfmTool = defineTool("lastfm", {
  description:
    "Query Last.fm for music listening data. Can get recent scrobbles, now playing, user profile, and top artists/tracks/albums.",
  parameters: z.object({
    action: z
      .enum([
        "now_playing",
        "recent_tracks",
        "user_info",
        "top_artists",
        "top_tracks",
        "top_albums",
      ])
      .describe("The action to perform."),
    username: z.string().describe("The Last.fm username to query."),
    period: z
      .enum(["overall", "7day", "1month", "3month", "6month", "12month"])
      .nullable()
      .describe("Time period for top charts."),
    limit: z
      .number()
      .nullable()
      .describe("Number of results (default: 10, max: 50)."),
  }),
  handler: async ({ action, username, period, limit }) => {
    try {
      const effectiveLimit = Math.min(limit ?? 10, 50);
      const effectivePeriod: Period = period ?? "overall";

      toolLogger.info(
        { action, username, period: effectivePeriod, limit: effectiveLimit },
        "Last.fm query",
      );

      switch (action) {
        case "now_playing": {
          const result = await lastFMClient.getNowPlaying(username);
          if (!result) {
            return { error: "No recent tracks found for this user" };
          }
          return { success: true, ...result };
        }

        case "recent_tracks": {
          const result = await lastFMClient.getRecentTracks(
            username,
            effectiveLimit,
          );
          return { success: true, ...result };
        }

        case "user_info": {
          const result = await lastFMClient.getUserInfo(username);
          return { success: true, user: result };
        }

        case "top_artists": {
          const result = await lastFMClient.getTopArtists(
            username,
            effectivePeriod,
            effectiveLimit,
          );
          return { success: true, ...result };
        }

        case "top_tracks": {
          const result = await lastFMClient.getTopTracks(
            username,
            effectivePeriod,
            effectiveLimit,
          );
          return { success: true, ...result };
        }

        case "top_albums": {
          const result = await lastFMClient.getTopAlbums(
            username,
            effectivePeriod,
            effectiveLimit,
          );
          return { success: true, ...result };
        }

        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toolLogger.error(
        { error: errorMessage, action, username },
        "Last.fm query failed",
      );
      return { error: errorMessage };
    }
  },
});
