import { env } from "../env";

export type UserSurface = "discord" | "steam";

export interface RuyiUserIdentity {
  surface: UserSurface;
  surfaceUserId: string;
  username: string;
  personId: string;
  canWriteMemory: boolean;
}

const OWNER_PERSON_ID = "owner";

export function steamIntegrationEnabled(): boolean {
  return Boolean(
    env.STEAM_REFRESH_TOKEN &&
      env.STEAM_BOT_STEAM_ID64 &&
      env.STEAM_OWNER_STEAM_ID64 &&
      env.OWNER_DISCORD_USER_ID,
  );
}

export function buildDiscordUserIdentity(
  userId: string,
  username: string,
): RuyiUserIdentity {
  const isOwner = env.OWNER_DISCORD_USER_ID === userId;
  return {
    surface: "discord",
    surfaceUserId: userId,
    username,
    personId: isOwner ? OWNER_PERSON_ID : `discord:${userId}`,
    canWriteMemory: true,
  };
}

export function buildSteamUserIdentity(
  steamId64: string,
  username: string,
): RuyiUserIdentity {
  const isOwner = env.STEAM_OWNER_STEAM_ID64 === steamId64;
  return {
    surface: "steam",
    surfaceUserId: steamId64,
    username,
    personId: isOwner ? OWNER_PERSON_ID : `steam:${steamId64}`,
    canWriteMemory: isOwner,
  };
}

export function resolveSteamProfileTarget(
  target: "bot" | "owner",
): string | null {
  if (target === "bot") return env.STEAM_BOT_STEAM_ID64 ?? null;
  return env.STEAM_OWNER_STEAM_ID64 ?? null;
}
