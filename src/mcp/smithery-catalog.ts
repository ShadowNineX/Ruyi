import type { SmitheryServerId } from "../db/models";

export const SMITHERY_SERVER_IDS = [
  "youtube",
] as const satisfies readonly SmitheryServerId[];

export interface SmitheryServerInfo {
  name: string;
  emoji: string;
  description: string;
  mcpUrl: string;
}

export const SMITHERY_SERVERS: Record<SmitheryServerId, SmitheryServerInfo> = {
  youtube: {
    name: "YouTube",
    emoji: "📺",
    description: "Video search, channel info, captions",
    mcpUrl: "https://server.smithery.ai/youtube",
  },
};

export function parseSmitheryServerId(value: string): SmitheryServerId | null {
  return SMITHERY_SERVER_IDS.includes(value as SmitheryServerId)
    ? (value as SmitheryServerId)
    : null;
}
