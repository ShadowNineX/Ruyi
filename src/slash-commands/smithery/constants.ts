import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SmitheryServerId } from "../../db/models";

export const SMITHERY_REDIRECT_URL = "https://smithery.ai/oauth/callback";

export const SMITHERY_CLIENT_METADATA: OAuthClientMetadata = {
  client_name: "Ruyi Discord Bot",
  redirect_uris: [SMITHERY_REDIRECT_URL],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  scope: "mcp:read mcp:write",
};

export const DISCORD_BUTTON_URL_MAX_LENGTH = 512;
export const DISCORD_EMBED_DESCRIPTION_MAX_LENGTH = 4096;

export const SMITHERY_SERVER_IDS = [
  "brave",
  "youtube",
] as const satisfies readonly SmitheryServerId[];

export interface SmitheryServerInfo {
  name: string;
  emoji: string;
  description: string;
}

export const SMITHERY_SERVERS: Record<SmitheryServerId, SmitheryServerInfo> = {
  brave: {
    name: "Brave Search",
    emoji: "🦁",
    description: "Web, news, image, and local search",
  },
  youtube: {
    name: "YouTube",
    emoji: "📺",
    description: "Video search, channel info, captions",
  },
};

export function parseSmitheryServerId(value: string): SmitheryServerId | null {
  return SMITHERY_SERVER_IDS.includes(value as SmitheryServerId)
    ? (value as SmitheryServerId)
    : null;
}
