import type { Period } from '../lib/lastfm';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { lastFMClient } from '../lib/lastfm';
import { toolLogger } from '../logger';
import { formatError } from '../utils/types';

export const lastfmTool = tool({
  name: 'lastfm',
  description:
    'Query Last.fm for music listening data. Can get recent scrobbles, now playing, user profile, and top artists/tracks/albums.',
  parameters: z.object({
    action: z
      .enum([
        'now_playing',
        'recent_tracks',
        'user_info',
        'top_artists',
        'top_tracks',
        'top_albums',
      ])
      .describe('The action to perform.'),
    username: z.string().describe('The Last.fm username to query.'),
    period: z
      .enum(['overall', '7day', '1month', '3month', '6month', '12month'])
      .nullable()
      .describe('Time period for top charts.'),
    limit: z
      .number()
      .nullable()
      .describe('Number of results (default: 10, max: 50).'),
  }),
  execute: async ({ action, username, period, limit }) => {
    try {
      const effectiveLimit = Math.min(Math.max(Math.round(limit ?? 10), 1), 50);
      const effectivePeriod: Period = period ?? 'overall';

      toolLogger.info(
        { action, username, period: effectivePeriod, limit: effectiveLimit },
        'Last.fm query',
      );

      switch (action) {
        case 'now_playing': {
          const result = await lastFMClient.getNowPlaying(username);
          if (!result) {
            return { error: 'No recent tracks found for this user' };
          }
          return { success: true, ...result };
        }

        case 'recent_tracks': {
          const result = await lastFMClient.getRecentTracks(
            username,
            effectiveLimit,
          );
          return { success: true, ...result };
        }

        case 'user_info': {
          const result = await lastFMClient.getUserInfo(username);
          return { success: true, user: result };
        }

        case 'top_artists': {
          const result = await lastFMClient.getTopArtists(
            username,
            effectivePeriod,
            effectiveLimit,
          );
          return { success: true, ...result };
        }

        case 'top_tracks': {
          const result = await lastFMClient.getTopTracks(
            username,
            effectivePeriod,
            effectiveLimit,
          );
          return { success: true, ...result };
        }

        case 'top_albums': {
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
      const errorMessage = formatError(error);
      toolLogger.error(
        { error: errorMessage, action, username },
        'Last.fm query failed',
      );
      return { error: errorMessage };
    }
  },
});
