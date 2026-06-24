import type { SteamAccountEnv } from '../env';
import { env } from '../env';

export type SteamProfileCommentTarget = 'bot' | 'owner';
export type SteamAccountConfig = SteamAccountEnv;

export function getSteamAccounts(): readonly SteamAccountConfig[] {
  return env.STEAM_ACCOUNTS;
}

export function steamIntegrationEnabled(): boolean {
  return getSteamAccounts().length > 0 && Boolean(env.OWNER_DISCORD_USER_ID);
}

export function getDefaultSteamAccount(): SteamAccountConfig | null {
  return getSteamAccounts()[0] ?? null;
}

export function getSteamAccountById(
  accountId: string | null | undefined,
): SteamAccountConfig | null {
  if (!accountId) { return getDefaultSteamAccount(); }
  return getSteamAccounts().find(account => account.id === accountId) ?? null;
}

export function getSteamAccountForBotProfile(
  profileId: string,
): SteamAccountConfig | null {
  return (
    getSteamAccounts().find(account => account.botSteamId64 === profileId)
    ?? null
  );
}

function getSteamAccountForOwnerProfile(
  profileId: string,
): SteamAccountConfig | null {
  if (env.STEAM_OWNER_STEAM_ID64 !== profileId) { return null; }
  return getDefaultSteamAccount();
}

export function getSteamAccountForProfile(
  profileId: string,
): SteamAccountConfig | null {
  return (
    getSteamAccountForBotProfile(profileId)
    ?? getSteamAccountForOwnerProfile(profileId)
  );
}

export function resolveSteamProfileTarget(
  target: SteamProfileCommentTarget,
  accountId?: string | null,
): string | null {
  const account = getSteamAccountById(accountId);
  if (!account) { return null; }
  return target === 'bot' ? account.botSteamId64 : env.STEAM_OWNER_STEAM_ID64 ?? null;
}

export function getSteamAccountDisplayName(account: SteamAccountConfig): string {
  return account.personality === 'tails' ? 'Tails' : 'Ruyi';
}
