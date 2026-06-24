import type CEconItem from 'steamcommunity/classes/CEconItem';
import type CSteamUser from 'steamcommunity/classes/CSteamUser';
import type { SteamAccountConfig } from './accounts';
import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';
import SteamID from 'steamid';
import { botLogger } from '../logger';
import {
  areSteamCommunityLifecycleListenersAttached,
  getSteamCommunityReconnectTimer,
  getSteamCommunityStartPromise,
  incrementSteamCommunityReconnectAttempts,
  isAnySteamCommunityReady,
  isSteamCommunityLoginInProgress,
  isSteamCommunityReady,
  isSteamCommunityReconnectEnabled,
  resetSteamCommunityReconnectAttempts,
  setSteamCommunityLifecycleListenersAttached,
  setSteamCommunityLoginInProgress,
  setSteamCommunityReady,
  setSteamCommunityReconnectEnabled,
  setSteamCommunityReconnectTimer,
  setSteamCommunityStartPromise,
} from '../stores/steam-client-store';
import {
  clearSteamProfileDataCache,
  getOrCreateCachedSteamProfileData,
} from '../stores/steam-profile-store';
import { isValidDate } from '../utils/date';
import {
  getDefaultSteamAccount,
  getSteamAccountById,
  getSteamAccountForBotProfile,
  getSteamAccountForProfile,
  getSteamAccounts,
  steamIntegrationEnabled,
} from './accounts';

const DEFAULT_COMMENT_FETCH_COUNT = 20;
const STEAM_RECONNECT_BASE_DELAY_MS = 5_000;
const STEAM_RECONNECT_MAX_DELAY_MS = 5 * 60_000;
const STEAM_WEB_SESSION_TIMEOUT_MS = 45_000;
const STEAM_ID64_PATTERN = /^\d{17}$/;

interface SteamCommentOptions {
  start?: number;
  count?: number;
}

export type SteamOwnedGamesSort = 'recent' | 'most_played' | 'name';

export interface SteamProfileComment {
  id: string;
  authorSteamId: string;
  authorName: string;
  authorAvatar?: string;
  authorState?: string;
  date: Date;
  text: string;
  html: string;
}

interface SteamProfileCommentPage {
  comments: SteamProfileComment[];
  totalCount: number;
}

interface SteamPersonaSummary {
  personaState?: number;
  personaStateFlags?: number;
  gamePlayedAppId?: number;
  gameName?: string;
  gameId?: string;
  lastSeenOnline?: number;
}

interface SteamProfileSummary {
  steamId64: string;
  profileUrl: string;
  vanityUrl: string | null;
  name: string;
  avatarUrl: string;
  onlineState: string;
  stateMessage: string | null;
  privacyState: string;
  visibilityState: number | null;
  isPublic: boolean;
  vacBanned: boolean;
  tradeBanState: string;
  limited: boolean;
  memberSince: string | null;
  location: string | null;
  realName: string | null;
  summary: string | null;
  primaryGroupSteamId64: string | null;
  groupSteamId64s: string[];
  backgroundUrl: string | null;
  persona: SteamPersonaSummary | null;
  limitations: string[];
}

interface SteamOwnedGameSummary {
  appId: number;
  name: string;
  playtimeForeverMinutes: number;
  playtimeRecentMinutes: number | null;
  playtimeWindowsForeverMinutes: number;
  playtimeMacForeverMinutes: number;
  playtimeLinuxForeverMinutes: number;
  iconUrl: string | null;
  logoUrl: string | null;
  hasCommunityVisibleStats: boolean;
}

interface SteamOwnedGamesSummary {
  appCount: number;
  returnedCount: number;
  sort: SteamOwnedGamesSort;
  games: SteamOwnedGameSummary[];
  recentGames: SteamOwnedGameSummary[];
  limitations: string[];
}

interface SteamProfileItemSummary {
  communityItemId: number | null;
  appId: number | null;
  name: string | null;
  title: string | null;
  description: string | null;
  type: string | null;
  itemClass: string | null;
  imageSmall: string | null;
  imageLarge: string | null;
  movieWebm: string | null;
  movieMp4: string | null;
}

interface SteamEquippedProfileItemsSummary {
  profileBackground: SteamProfileItemSummary | null;
  miniProfileBackground: SteamProfileItemSummary | null;
  avatarFrame: SteamProfileItemSummary | null;
  animatedAvatar: SteamProfileItemSummary | null;
  profileModifier: SteamProfileItemSummary | null;
  limitations: string[];
}

interface SteamInventoryContextSummary {
  id: string;
  name: string;
  assetCount: number | null;
}

interface SteamInventoryAppSummary {
  appId: number;
  name: string;
  iconUrl: string | null;
  inventoryUrl: string | null;
  assetCount: number | null;
  contexts: SteamInventoryContextSummary[];
}

interface SteamInventoryItemSummary {
  id: string;
  appId: number | null;
  contextId: string | null;
  classId: string | null;
  instanceId: string | null;
  amount: number | null;
  name: string | null;
  marketHashName: string | null;
  type: string | null;
  tradable: boolean;
  marketable: boolean;
  imageUrl: string | null;
  largeImageUrl: string | null;
  tags: Array<{
    category: string | null;
    name: string | null;
    categoryName: string | null;
  }>;
}

interface SteamInventoryItemsSummary {
  appId: number;
  contextId: string;
  returnedCount: number;
  totalCount: number | null;
  currencyCount: number;
  tradableOnly: boolean;
  items: SteamInventoryItemSummary[];
  limitations: string[];
}

type RawSteamUserComment = SteamCommunity.UserComment;
type RawSteamInventoryContexts = Record<string, unknown>;
interface SteamInventoryContentsResponse {
  currency: CEconItem[];
  inventory: CEconItem[];
  totalItems: number;
}
interface SteamProfileReadOptions {
  forceRefresh?: boolean;
}
type SteamEquippedProfileItemsResponse = Partial<SteamUser.ProfileItems> & {
  profile_background?: SteamUser.ProfileItem | null;
  mini_profile_background?: SteamUser.ProfileItem | null;
  avatar_frame?: SteamUser.ProfileItem | null;
  animated_avatar?: SteamUser.ProfileItem | null;
  profile_modifier?: SteamUser.ProfileItem | null;
};
type SteamCommentNotificationListener = (
  count: number,
  myItems: number,
  discussions: number,
) => void;

type SteamProfileWithComments = Omit<
  CSteamUser,
  | 'comment'
  | 'deleteComment'
  | 'getAvatarURL'
  | 'getComments'
  | 'getInventoryContents'
  | 'getInventoryContexts'
> & {
  getAvatarURL: (size?: string, protocol?: string) => string;
  getInventoryContexts: (
    callback: (
      error: SteamCommunity.CallbackError,
      apps: RawSteamInventoryContexts,
    ) => void,
  ) => void;
  getInventoryContents: (
    appId: number,
    contextId: string,
    tradableOnly: boolean,
    language: string,
    callback: (
      error: SteamCommunity.CallbackError,
      inventory: CEconItem[],
      currency: CEconItem[],
      totalItems: number,
    ) => void,
  ) => void;
  comment: (
    message: string,
    callback: (error: Error | null, commentId?: string) => void,
  ) => void;
  deleteComment: (
    commentId: string,
    callback: (error: Error | null) => void,
  ) => void;
  getComments: (
    options: SteamCommentOptions,
    callback: (
      error: SteamCommunity.CallbackError,
      comments: RawSteamUserComment[],
      totalCount: number,
    ) => void,
  ) => void;
};

const STEAM_PROFILE_WITH_COMMENT_METHODS = [
  'comment',
  'deleteComment',
  'getAvatarURL',
  'getComments',
  'getInventoryContents',
  'getInventoryContexts',
] as const satisfies readonly (keyof SteamProfileWithComments)[];

function hasSteamProfileWithCommentMethods(
  profile: CSteamUser,
): boolean {
  return STEAM_PROFILE_WITH_COMMENT_METHODS.every(
    method => typeof profile[method] === 'function',
  );
}

function requireSteamProfileWithComments(
  profile: CSteamUser,
): SteamProfileWithComments {
  if (!hasSteamProfileWithCommentMethods(profile)) {
    throw new TypeError('Steam profile response is missing comment methods');
  }

  const normalizedProfile: unknown = profile;
  return normalizedProfile as SteamProfileWithComments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getSteamLogOnOptions(
  account: SteamAccountConfig,
): { refreshToken: string; steamID: string } {
  return {
    refreshToken: account.refreshToken,
    steamID: account.botSteamId64,
  };
}

function toSteamUserLookup(profileId: string): SteamID | string {
  const normalized = normalizeSteamProfileLookup(profileId);
  return STEAM_ID64_PATTERN.test(normalized)
    ? new SteamID(normalized)
    : normalized;
}

function getSteamStartupStatus(
  user: SteamUser,
  loginInProgress: boolean,
): string {
  if (user.steamID) { return 'logged_on_without_web_session'; }
  if (loginInProgress) { return 'login_in_progress'; }
  return 'not_connected';
}

export function normalizeSteamProfileLookup(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) { return trimmed; }
  if (!URL.canParse(trimmed)) { return trimmed; }

  const url = new URL(trimmed);
  const hostname = url.hostname.toLowerCase();
  if (!hostname.endsWith('steamcommunity.com')) { return trimmed; }

  const [kind, identifier] = url.pathname.split('/').filter(Boolean);
  if ((kind === 'profiles' || kind === 'id') && identifier) {
    return decodeURIComponent(identifier);
  }

  return trimmed;
}

function normalizeCommentId(id: unknown): string | null {
  if (typeof id !== 'string' && typeof id !== 'number') { return null; }
  const normalized = String(id).trim();
  return normalized || null;
}

function normalizeCommentDate(
  comment: RawSteamUserComment,
  fetchedAt: Date,
  index: number,
): Date {
  if (isValidDate(comment.date)) { return comment.date; }

  botLogger.debug(
    {
      commentId: normalizeCommentId(comment.id),
      index,
    },
    'Steam comment had no valid timestamp; using fetch-order timestamp',
  );
  return new Date(fetchedAt.getTime() - index);
}

function normalizeSteamProfileComment(
  comment: RawSteamUserComment,
  fetchedAt: Date,
  index: number,
): SteamProfileComment | null {
  const id = normalizeCommentId(comment.id);
  if (!id) { return null; }

  return {
    id,
    authorSteamId: comment.author.steamID.getSteamID64(),
    authorName:
      typeof comment.author.name === 'string'
        ? comment.author.name
        : 'Steam user',
    authorAvatar:
      typeof comment.author.avatar === 'string'
        ? comment.author.avatar
        : undefined,
    authorState:
      typeof comment.author.state === 'string'
        ? comment.author.state
        : undefined,
    date: normalizeCommentDate(comment, fetchedAt, index),
    text: typeof comment.text === 'string' ? comment.text.trim() : '',
    html: typeof comment.html === 'string' ? comment.html : '',
  };
}

function normalizeSteamProfileComments(
  comments: RawSteamUserComment[],
): SteamProfileComment[] {
  const fetchedAt = new Date();
  return comments.flatMap((comment, index) => {
    const normalized = normalizeSteamProfileComment(comment, fetchedAt, index);
    return normalized ? [normalized] : [];
  });
}

function dateToIso(value: unknown): string | null {
  return isValidDate(value) ? value.toISOString() : null;
}

function profileSteamId64(profile: SteamProfileWithComments): string {
  return profile.steamID.getSteamID64();
}

function profileUrlFor(steamId64: string): string {
  return `https://steamcommunity.com/profiles/${steamId64}`;
}

function normalizeSteamPersona(value: unknown): SteamPersonaSummary | null {
  if (!isRecord(value)) { return null; }

  return {
    personaState: optionalNumber(value.persona_state) ?? undefined,
    personaStateFlags: optionalNumber(value.persona_state_flags) ?? undefined,
    gamePlayedAppId: optionalNumber(value.game_played_app_id) ?? undefined,
    gameName: optionalString(value.game_name) ?? undefined,
    gameId:
      optionalString(value.gameid)
      ?? optionalString(value.game_id)
      ?? undefined,
    lastSeenOnline: optionalNumber(value.last_seen_online) ?? undefined,
  };
}

function normalizeSteamProfileSummary(
  profile: SteamProfileWithComments,
  backgroundUrl: string | null,
  persona: SteamPersonaSummary | null,
): SteamProfileSummary {
  const steamId64 = profileSteamId64(profile);
  const visibilityState = optionalNumber(profile.visibilityState);
  const groupSteamId64s
    = profile.groups?.map(group => group.getSteamID64()) ?? [];

  return {
    steamId64,
    profileUrl: profileUrlFor(steamId64),
    vanityUrl: profile.customURL ? `https://steamcommunity.com/id/${profile.customURL}` : null,
    name: profile.name,
    avatarUrl: profile.getAvatarURL('full', 'https://'),
    onlineState: profile.onlineState,
    stateMessage: profile.stateMessage || null,
    privacyState: profile.privacyState,
    visibilityState,
    isPublic: profile.privacyState === 'public' && visibilityState === 3,
    vacBanned: profile.vacBanned,
    tradeBanState: profile.tradeBanState,
    limited: profile.isLimitedAccount,
    memberSince: dateToIso(profile.memberSince),
    location: profile.location,
    realName: profile.realName,
    summary: profile.summary,
    primaryGroupSteamId64: profile.primaryGroup?.getSteamID64() ?? null,
    groupSteamId64s,
    backgroundUrl,
    persona,
    limitations:
      profile.privacyState === 'public'
        ? []
        : ['Steam may hide profile details, games, or inventory because this profile is not public.'],
  };
}

function normalizeOwnedGame(game: SteamUser.OwnedApp): SteamOwnedGameSummary {
  return {
    appId: game.appid,
    name: game.name,
    playtimeForeverMinutes: game.playtime_forever,
    playtimeRecentMinutes: game.playtime_2weeks,
    playtimeWindowsForeverMinutes: game.playtime_windows_forever,
    playtimeMacForeverMinutes: game.playtime_mac_forever,
    playtimeLinuxForeverMinutes: game.playtime_linux_forever,
    iconUrl: game.img_icon_url || null,
    logoUrl: game.img_logo_url || null,
    hasCommunityVisibleStats: game.has_community_visible_stats,
  };
}

function sortOwnedGames(
  games: SteamOwnedGameSummary[],
  sort: SteamOwnedGamesSort,
): SteamOwnedGameSummary[] {
  return [...games].sort((first, second) => {
    if (sort === 'name') { return first.name.localeCompare(second.name); }
    if (sort === 'most_played') {
      return second.playtimeForeverMinutes - first.playtimeForeverMinutes;
    }
    return (
      (second.playtimeRecentMinutes ?? 0)
      - (first.playtimeRecentMinutes ?? 0)
    );
  });
}

function normalizeOwnedGamesSummary(
  response: SteamUser.UserOwnedApps,
  limit: number,
  sort: SteamOwnedGamesSort,
): SteamOwnedGamesSummary {
  const games = response.apps.map(normalizeOwnedGame);
  const sortedGames = sortOwnedGames(games, sort);
  const recentGames = sortOwnedGames(
    games.filter(game => (game.playtimeRecentMinutes ?? 0) > 0),
    'recent',
  ).slice(0, limit);

  return {
    appCount: response.app_count,
    returnedCount: Math.min(sortedGames.length, limit),
    sort,
    games: sortedGames.slice(0, limit),
    recentGames,
    limitations:
      sortedGames.length > limit
        ? [`Returned ${limit} of ${sortedGames.length} visible games.`]
        : [],
  };
}

function normalizeProfileItem(
  item: SteamUser.ProfileItem | null | undefined,
): SteamProfileItemSummary | null {
  if (!item) { return null; }
  return {
    communityItemId: optionalNumber(item.communityitemid),
    appId: optionalNumber(item.appid),
    name: optionalString(item.name),
    title: optionalString(item.item_title),
    description: optionalString(item.item_description),
    type: optionalString(item.item_type),
    itemClass: optionalString(item.item_class),
    imageSmall: optionalString(item.image_small),
    imageLarge: optionalString(item.image_large),
    movieWebm: optionalString(item.movie_webm),
    movieMp4: optionalString(item.movie_mp4),
  };
}

function normalizeEquippedProfileItems(
  items: SteamEquippedProfileItemsResponse,
): SteamEquippedProfileItemsSummary {
  return {
    profileBackground: normalizeProfileItem(
      items.profile_background ?? items.profile_backgrounds?.[0],
    ),
    miniProfileBackground: normalizeProfileItem(
      items.mini_profile_background ?? items.mini_profile_backgrounds?.[0],
    ),
    avatarFrame: normalizeProfileItem(
      items.avatar_frame ?? items.avatar_frames?.[0],
    ),
    animatedAvatar: normalizeProfileItem(
      items.animated_avatar ?? items.animated_avatars?.[0],
    ),
    profileModifier: normalizeProfileItem(
      items.profile_modifier ?? items.profile_modifiers?.[0],
    ),
    limitations: [],
  };
}

function getProfileBackgroundUrlFromItems(
  items: SteamEquippedProfileItemsSummary,
): string | null {
  const background = items.profileBackground;
  return (
    background?.imageLarge
    ?? background?.imageSmall
    ?? background?.movieWebm
    ?? background?.movieMp4
    ?? null
  );
}

function normalizeInventoryContexts(
  apps: RawSteamInventoryContexts,
): SteamInventoryAppSummary[] {
  return Object.entries(apps).flatMap(([appId, value]) => {
    if (!isRecord(value)) { return []; }
    const parsedAppId = optionalNumber(appId);
    if (parsedAppId === null) { return []; }
    const rawContexts = isRecord(value.rgContexts) ? value.rgContexts : {};
    const contexts = Object.entries(rawContexts).flatMap(([id, context]) => {
      if (!isRecord(context)) { return []; }
      return [
        {
          id,
          name: optionalString(context.name) ?? id,
          assetCount: optionalNumber(context.asset_count),
        },
      ];
    });

    return [
      {
        appId: parsedAppId,
        name: optionalString(value.name) ?? `App ${appId}`,
        iconUrl: optionalString(value.icon),
        inventoryUrl: optionalString(value.link),
        assetCount: optionalNumber(value.asset_count),
        contexts,
      },
    ];
  }).sort((first, second) => first.name.localeCompare(second.name));
}

function getInventoryItemImageUrl(
  item: CEconItem,
  field: 'icon_url' | 'icon_url_large',
): string | null {
  const rawItem = item as unknown as Record<string, unknown>;
  if (!optionalString(rawItem[field])) { return null; }
  return field === 'icon_url_large' ? item.getLargeImageURL() : item.getImageURL();
}

function normalizeInventoryItem(item: CEconItem): SteamInventoryItemSummary {
  return {
    id: item.id,
    appId: optionalNumber(item.appid),
    contextId: optionalString(item.contextid),
    classId: optionalString(item.classid),
    instanceId: optionalString(item.instanceid),
    amount: optionalNumber(item.amount),
    name: optionalString(item.name),
    marketHashName: optionalString(item.market_hash_name),
    type: optionalString(item.type),
    tradable: item.tradable,
    marketable: item.marketable,
    imageUrl: getInventoryItemImageUrl(item, 'icon_url'),
    largeImageUrl: getInventoryItemImageUrl(item, 'icon_url_large'),
    tags: Array.isArray(item.tags)
      ? item.tags.map((tag: unknown) => ({
          category: isRecord(tag) ? optionalString(tag.category) : null,
          name: isRecord(tag) ? optionalString(tag.name) : null,
          categoryName: isRecord(tag) ? optionalString(tag.category_name) : null,
        }))
      : [],
  };
}

function normalizeInventoryItemsSummary(
  appId: number,
  contextId: string,
  inventory: CEconItem[],
  currency: CEconItem[],
  totalItems: number,
  tradableOnly: boolean,
  limit: number,
): SteamInventoryItemsSummary {
  return {
    appId,
    contextId,
    returnedCount: Math.min(inventory.length, limit),
    totalCount: Number.isFinite(totalItems) ? totalItems : null,
    currencyCount: currency.length,
    tradableOnly,
    items: inventory.slice(0, limit).map(normalizeInventoryItem),
    limitations:
      inventory.length > limit
        ? [`Returned ${limit} of ${inventory.length} fetched inventory items.`]
        : [],
  };
}

class SteamCommunityAccountClient {
  private readonly user = new SteamUser({
    autoRelogin: true,
    renewRefreshTokens: true,
  });

  private readonly community = new SteamCommunity();

  constructor(readonly account: SteamAccountConfig) {}

  get accountId(): string {
    return this.account.id;
  }

  private setOnlinePresence(reason: string): void {
    this.user.setPersona(SteamUser.EPersonaState.Online);
    botLogger.info(
      { accountId: this.accountId, reason },
      'Steam account presence set to online',
    );
  }

  private clearScheduledReconnect(): void {
    const timer = getSteamCommunityReconnectTimer(this.accountId);
    if (!timer) { return; }

    clearTimeout(timer);
    setSteamCommunityReconnectTimer(this.accountId, null);
  }

  private scheduleReconnect(reason: string): void {
    if (
      !steamIntegrationEnabled()
      || !isSteamCommunityReconnectEnabled(this.accountId)
      || isSteamCommunityReady(this.accountId)
      || getSteamCommunityReconnectTimer(this.accountId)
    ) {
      return;
    }

    const attempt = incrementSteamCommunityReconnectAttempts(this.accountId);
    const delayMs = Math.min(
      STEAM_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
      STEAM_RECONNECT_MAX_DELAY_MS,
    );
    const timer = setTimeout(() => {
      setSteamCommunityReconnectTimer(this.accountId, null);
      if (
        !isSteamCommunityReconnectEnabled(this.accountId)
        || isSteamCommunityReady(this.accountId)
      ) {
        return;
      }

      botLogger.info(
        { accountId: this.accountId, attempt, reason },
        'Retrying Steam Community connection',
      );
      void this.start().catch(() => {
        // start() logs the failure and schedules the next retry.
      });
    }, delayMs);

    setSteamCommunityReconnectTimer(this.accountId, timer);
    botLogger.warn(
      { accountId: this.accountId, attempt, delayMs, reason },
      'Scheduled Steam Community reconnect',
    );
  }

  private requestWebSession(reason: string): void {
    if (!this.user.steamID) { return; }

    try {
      this.user.webLogOn();
      botLogger.debug({ reason }, 'Requested Steam Community web session');
    } catch (error) {
      botLogger.warn(
        { accountId: this.accountId, reason, error: getErrorMessage(error) },
        'Could not request Steam Community web session',
      );
    }
  }

  private resetConnectionAfterStartupTimeout(status: string): void {
    setSteamCommunityLoginInProgress(this.accountId, false);
    setSteamCommunityReady(this.accountId, false);
    clearSteamProfileDataCache(this.accountId);

    try {
      this.user.logOff();
    } catch (error) {
      botLogger.warn(
        { accountId: this.accountId, status, error: getErrorMessage(error) },
        'Could not reset Steam connection after startup timeout',
      );
    }
  }

  private attachLifecycleListeners(): void {
    if (areSteamCommunityLifecycleListenersAttached(this.accountId)) { return; }

    this.user.on('debug', (message) => {
      botLogger.debug({ accountId: this.accountId, message }, 'Steam user debug');
    });
    this.user.on('loggedOn', () => {
      setSteamCommunityLoginInProgress(this.accountId, false);
      botLogger.info({ accountId: this.accountId }, 'Steam account logged on');
      this.setOnlinePresence('loggedOn');
    });
    this.user.on('refreshToken', () => {
      botLogger.warn(
        { accountId: this.accountId },
        'Steam emitted a refreshed token; update this account refreshToken in STEAM_ACCOUNTS before the old token expires',
      );
    });
    this.user.on('disconnected', (eresult, message) => {
      setSteamCommunityLoginInProgress(this.accountId, false);
      setSteamCommunityReady(this.accountId, false);
      setSteamCommunityStartPromise(this.accountId, null);
      clearSteamProfileDataCache(this.accountId);
      botLogger.warn(
        { accountId: this.accountId, eresult, message },
        'Steam account disconnected',
      );
      this.scheduleReconnect('disconnected');
    });
    this.user.on('error', (error) => {
      setSteamCommunityLoginInProgress(this.accountId, false);
      setSteamCommunityReady(this.accountId, false);
      setSteamCommunityStartPromise(this.accountId, null);
      clearSteamProfileDataCache(this.accountId);
      botLogger.error(
        {
          accountId: this.accountId,
          error: getErrorMessage(error),
          stack: error.stack,
          name: error.name,
        },
        'Steam account emitted an error',
      );
      this.scheduleReconnect('error');
    });
    this.user.on('webSession', (sessionId, cookies) => {
      setSteamCommunityLoginInProgress(this.accountId, false);
      this.community.setCookies(cookies);
      setSteamCommunityReady(this.accountId, true);
      setSteamCommunityStartPromise(this.accountId, null);
      resetSteamCommunityReconnectAttempts(this.accountId);
      this.clearScheduledReconnect();
      this.setOnlinePresence('webSession');
      botLogger.info(
        { accountId: this.accountId, sessionIdLength: sessionId.length },
        'Steam Community web session established',
      );
    });
    this.community.on('sessionExpired', (error) => {
      setSteamCommunityReady(this.accountId, false);
      botLogger.warn(
        { accountId: this.accountId, error: getErrorMessage(error) },
        'Steam Community session expired',
      );
      this.requestWebSession('sessionExpired');
    });

    setSteamCommunityLifecycleListenersAttached(this.accountId, true);
  }

  start(): Promise<void> {
    if (!steamIntegrationEnabled()) {
      botLogger.info('Steam integration disabled; missing Steam environment');
      return Promise.resolve();
    }
    setSteamCommunityReconnectEnabled(this.accountId, true);
    if (isSteamCommunityReady(this.accountId)) { return Promise.resolve(); }

    const existingStartPromise = getSteamCommunityStartPromise(this.accountId);
    if (existingStartPromise !== null) { return existingStartPromise; }

    const logOnOptions = getSteamLogOnOptions(this.account);
    this.attachLifecycleListeners();

    const startPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) { return; }

        const status = getSteamStartupStatus(
          this.user,
          isSteamCommunityLoginInProgress(this.accountId),
        );
        this.resetConnectionAfterStartupTimeout(status);
        fail(
          new Error(
            `Timed out waiting for Steam Community web session: ${status}`,
          ),
        );
      }, STEAM_WEB_SESSION_TIMEOUT_MS);
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.user.off('webSession', onWebSession);
        this.user.off('error', fail);
      };
      const fail = (error: Error): void => {
        if (settled) { return; }
        settled = true;
        cleanup();
        reject(error);
      };
      const onWebSession = (): void => {
        if (settled) { return; }
        settled = true;
        cleanup();
        resolve();
      };

      this.user.once('webSession', onWebSession);
      this.user.once('error', fail);

      try {
        if (this.user.steamID) {
          this.requestWebSession('existing_connection');
        } else if (isSteamCommunityLoginInProgress(this.accountId)) {
          botLogger.info(
            { accountId: this.accountId },
            'Steam login already in progress; waiting for web session',
          );
        } else {
          botLogger.info({ accountId: this.accountId }, 'Logging into Steam account');
          setSteamCommunityLoginInProgress(this.accountId, true);
          this.user.logOn(logOnOptions);
        }
      } catch (error) {
        setSteamCommunityLoginInProgress(this.accountId, false);
        fail(toError(error));
      }
    }).catch((error: unknown) => {
      setSteamCommunityStartPromise(this.accountId, null);
      botLogger.error(
        { accountId: this.accountId, error: getErrorMessage(error) },
        'Steam integration failed to start',
      );
      this.scheduleReconnect('start_failed');
      throw error;
    });

    setSteamCommunityStartPromise(this.accountId, startPromise);
    return startPromise;
  }

  stop(): void {
    if (!steamIntegrationEnabled()) { return; }
    setSteamCommunityReconnectEnabled(this.accountId, false);
    this.clearScheduledReconnect();
    setSteamCommunityLoginInProgress(this.accountId, false);
    setSteamCommunityReady(this.accountId, false);
    setSteamCommunityStartPromise(this.accountId, null);
    resetSteamCommunityReconnectAttempts(this.accountId);
    clearSteamProfileDataCache(this.accountId);
    this.user.logOff();
  }

  isReady(): boolean {
    return isSteamCommunityReady(this.accountId);
  }

  onCommentNotification(
    listener: SteamCommentNotificationListener,
  ): () => void {
    this.user.on('newComments', listener);
    return () => {
      this.user.off('newComments', listener);
    };
  }

  onReady(listener: () => void): () => void {
    this.user.on('webSession', listener);
    return () => {
      this.user.off('webSession', listener);
    };
  }

  async getProfileComments(
    profileId: string,
    count = DEFAULT_COMMENT_FETCH_COUNT,
  ): Promise<SteamProfileComment[]> {
    const page = await this.getProfileCommentPage(profileId, count);
    return page.comments;
  }

  async getProfileCommentPage(
    profileId: string,
    count = DEFAULT_COMMENT_FETCH_COUNT,
  ): Promise<SteamProfileCommentPage> {
    await this.ensureReady();
    const profile = await this.getProfile(profileId);
    return new Promise((resolve, reject) => {
      profile.getComments({ count }, (error, comments, totalCount) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          comments: normalizeSteamProfileComments(comments),
          totalCount,
        });
      });
    });
  }

  async postProfileComment(
    profileId: string,
    message: string,
  ): Promise<string | null> {
    await this.ensureReady();
    const profile = await this.getProfile(profileId);
    return new Promise<string | null>((resolve, reject) => {
      profile.comment(message, (error, commentId) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(commentId ?? null);
      });
    });
  }

  async deleteProfileComment(
    profileId: string,
    commentId: string,
  ): Promise<void> {
    await this.ensureReady();
    const profile = await this.getProfile(profileId);
    return new Promise<void>((resolve, reject) => {
      profile.deleteComment(commentId, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async getPublicProfileSummary(
    lookup: string,
    options: SteamProfileReadOptions = {},
  ): Promise<SteamProfileSummary> {
    return getOrCreateCachedSteamProfileData(
      this.accountId,
      `profile-summary:${normalizeSteamProfileLookup(lookup)}`,
      async () => {
        await this.ensureReady();
        const profile = await this.getProfile(lookup, options);
        const steamId64 = profileSteamId64(profile);
        const [backgroundUrl, persona] = await Promise.all([
          this.getProfileBackgroundUrlForSteamId(steamId64, options),
          this.getPersona(steamId64),
        ]);
        return normalizeSteamProfileSummary(profile, backgroundUrl, persona);
      },
      options,
    );
  }

  async getOwnedGames(
    lookup: string,
    limit: number,
    sort: SteamOwnedGamesSort,
    options: SteamProfileReadOptions = {},
  ): Promise<SteamOwnedGamesSummary> {
    const response = await getOrCreateCachedSteamProfileData(
      this.accountId,
      `owned-games:${normalizeSteamProfileLookup(lookup)}`,
      async () => {
        await this.ensureReady();
        const steamId64 = await this.resolveSteamId64(lookup, options);
        return this.user.getUserOwnedApps(steamId64, {
          includePlayedFreeGames: true,
        });
      },
      options,
    );
    return normalizeOwnedGamesSummary(response, limit, sort);
  }

  async getEquippedProfileItems(
    lookup: string,
    options: SteamProfileReadOptions = {},
  ): Promise<SteamEquippedProfileItemsSummary> {
    const steamId64 = await this.resolveSteamId64(lookup, options);
    return this.getEquippedProfileItemsForSteamId(steamId64, options);
  }

  private async getEquippedProfileItemsForSteamId(
    steamId64: string,
    options: SteamProfileReadOptions = {},
  ): Promise<SteamEquippedProfileItemsSummary> {
    return getOrCreateCachedSteamProfileData(
      this.accountId,
      `equipped-items:${steamId64}`,
      async () => {
        await this.ensureReady();
        const items = await this.user.getEquippedProfileItems(steamId64, {
          language: 'english',
        });
        return normalizeEquippedProfileItems(items);
      },
      options,
    );
  }

  async getInventoryContexts(
    lookup: string,
    options: SteamProfileReadOptions = {},
  ): Promise<SteamInventoryAppSummary[]> {
    return getOrCreateCachedSteamProfileData(
      this.accountId,
      `inventory-contexts:${normalizeSteamProfileLookup(lookup)}`,
      async () => {
        await this.ensureReady();
        const profile = await this.getProfile(lookup, options);
        return new Promise((resolve, reject) => {
          profile.getInventoryContexts((error, apps) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(normalizeInventoryContexts(apps));
          });
        });
      },
      options,
    );
  }

  async getInventoryItems(
    lookup: string,
    appId: number,
    contextId: string,
    tradableOnly: boolean,
    limit: number,
    options: SteamProfileReadOptions = {},
  ): Promise<SteamInventoryItemsSummary> {
    const response = await getOrCreateCachedSteamProfileData(
      this.accountId,
      [
        'inventory-items',
        normalizeSteamProfileLookup(lookup),
        appId,
        contextId,
        tradableOnly,
      ].join(':'),
      async () => {
        await this.ensureReady();
        const profile = await this.getProfile(lookup, options);
        return new Promise<SteamInventoryContentsResponse>((resolve, reject) => {
          profile.getInventoryContents(
            appId,
            contextId,
            tradableOnly,
            'english',
            (error, inventory, currency, totalItems) => {
              if (error) {
                reject(error);
                return;
              }
              resolve({ currency, inventory, totalItems });
            },
          );
        });
      },
      options,
    );

    return normalizeInventoryItemsSummary(
      appId,
      contextId,
      response.inventory,
      response.currency,
      response.totalItems,
      tradableOnly,
      limit,
    );
  }

  private async ensureReady(): Promise<void> {
    if (!steamIntegrationEnabled()) {
      throw new TypeError('Steam integration is not configured');
    }
    if (isSteamCommunityReady(this.accountId)) { return; }
    await this.start();
  }

  private async getProfile(
    profileId: string,
    options: SteamProfileReadOptions = {},
  ): Promise<SteamProfileWithComments> {
    const normalized = normalizeSteamProfileLookup(profileId);
    return getOrCreateCachedSteamProfileData(
      this.accountId,
      `profile:${normalized}`,
      async () => {
        const lookup = toSteamUserLookup(profileId);
        return new Promise<SteamProfileWithComments>((resolve, reject) => {
          this.community.getSteamUser(lookup, (error, profile) => {
            if (error) {
              reject(error);
              return;
            }
            try {
              resolve(requireSteamProfileWithComments(profile));
            } catch (validationError) {
              reject(validationError);
            }
          });
        });
      },
      options,
    );
  }

  private async resolveSteamId64(
    lookup: string,
    options: SteamProfileReadOptions = {},
  ): Promise<string> {
    const normalized = normalizeSteamProfileLookup(lookup);
    if (STEAM_ID64_PATTERN.test(normalized)) { return normalized; }

    const profile = await this.getProfile(normalized, options);
    return profileSteamId64(profile);
  }

  private async getProfileBackgroundUrlForSteamId(
    steamId64: string,
    options: SteamProfileReadOptions = {},
  ): Promise<string | null> {
    try {
      const items = await this.getEquippedProfileItemsForSteamId(steamId64, options);
      return getProfileBackgroundUrlFromItems(items);
    } catch (error) {
      botLogger.debug(
        { accountId: this.accountId, steamId64, error: getErrorMessage(error) },
        'Steam profile background unavailable from equipped profile items',
      );
      return null;
    }
  }

  private async getPersona(steamId64: string): Promise<SteamPersonaSummary | null> {
    try {
      const { personas } = await this.user.getPersonas([steamId64]);
      return normalizeSteamPersona(personas[steamId64]);
    } catch (error) {
      botLogger.debug(
        { accountId: this.accountId, steamId64, error: getErrorMessage(error) },
        'Steam persona unavailable',
      );
      return null;
    }
  }
}

class SteamCommunityClient {
  private readonly clients = new Map<string, SteamCommunityAccountClient>(
    getSteamAccounts().map(account => [
      account.id,
      new SteamCommunityAccountClient(account),
    ]),
  );

  private getClient(accountId?: string | null): SteamCommunityAccountClient {
    const account = getSteamAccountById(accountId);
    if (!account) {
      throw new TypeError('Steam integration is not configured');
    }

    const client = this.clients.get(account.id);
    if (!client) {
      throw new TypeError(`Steam account "${account.id}" is not configured`);
    }
    return client;
  }

  private getClientForProfile(
    profileId: string,
    accountId?: string | null,
  ): SteamCommunityAccountClient {
    if (accountId) { return this.getClient(accountId); }

    const account = getSteamAccountForProfile(profileId) ?? getDefaultSteamAccount();
    return this.getClient(account?.id ?? null);
  }

  getAccountClients(): readonly SteamCommunityAccountClient[] {
    return [...this.clients.values()];
  }

  getBotProfileIds(): string[] {
    return this.getAccountClients().map(client => client.account.botSteamId64);
  }

  getAccountIdForBotProfile(profileId: string): string | null {
    return getSteamAccountForBotProfile(profileId)?.id ?? null;
  }

  async startAll(): Promise<void> {
    const clients = this.getAccountClients();
    const results = await Promise.allSettled(
      clients.map(async client => ({
        accountId: client.accountId,
        result: await client.start(),
      })),
    );
    const failures = results.flatMap((result, index) => {
      if (result.status === 'fulfilled') { return []; }
      return [
        {
          accountId: clients[index]?.accountId ?? 'unknown',
          reason: result.reason,
        },
      ];
    });

    if (failures.length === 0) { return; }

    botLogger.warn(
      {
        failed: failures.length,
        total: clients.length,
        errors: failures.map(failure => ({
          accountId: failure.accountId,
          error: getErrorMessage(failure.reason),
        })),
      },
      'Some Steam accounts failed to start',
    );

    if (failures.length === clients.length) {
      const [failure] = failures;
      throw toError(failure?.reason ?? 'All Steam accounts failed to start');
    }
  }

  start(accountId?: string | null): Promise<void> {
    return accountId ? this.getClient(accountId).start() : this.startAll();
  }

  stop(): void {
    for (const client of this.getAccountClients()) {
      client.stop();
    }
  }

  isReady(accountId?: string | null): boolean {
    if (accountId) { return this.getClient(accountId).isReady(); }
    return steamIntegrationEnabled() && this.getAccountClients().every(client => client.isReady());
  }

  isAnyReady(): boolean {
    return isAnySteamCommunityReady();
  }

  onCommentNotification(
    accountId: string,
    listener: SteamCommentNotificationListener,
  ): () => void {
    return this.getClient(accountId).onCommentNotification(listener);
  }

  onReady(accountId: string, listener: () => void): () => void {
    return this.getClient(accountId).onReady(listener);
  }

  getProfileComments(
    profileId: string,
    count = DEFAULT_COMMENT_FETCH_COUNT,
    accountId?: string | null,
  ): Promise<SteamProfileComment[]> {
    return this.getClientForProfile(profileId, accountId).getProfileComments(
      profileId,
      count,
    );
  }

  getProfileCommentPage(
    profileId: string,
    count = DEFAULT_COMMENT_FETCH_COUNT,
    accountId?: string | null,
  ): Promise<SteamProfileCommentPage> {
    return this.getClientForProfile(profileId, accountId).getProfileCommentPage(
      profileId,
      count,
    );
  }

  postProfileComment(
    profileId: string,
    message: string,
    accountId?: string | null,
  ): Promise<string | null> {
    return this.getClientForProfile(profileId, accountId).postProfileComment(
      profileId,
      message,
    );
  }

  deleteProfileComment(
    profileId: string,
    commentId: string,
    accountId?: string | null,
  ): Promise<void> {
    return this.getClientForProfile(profileId, accountId).deleteProfileComment(
      profileId,
      commentId,
    );
  }

  getPublicProfileSummary(
    lookup: string,
    options: SteamProfileReadOptions = {},
    accountId?: string | null,
  ): Promise<SteamProfileSummary> {
    return this.getClient(accountId).getPublicProfileSummary(lookup, options);
  }

  getOwnedGames(
    lookup: string,
    limit: number,
    sort: SteamOwnedGamesSort,
    options: SteamProfileReadOptions = {},
    accountId?: string | null,
  ): Promise<SteamOwnedGamesSummary> {
    return this.getClient(accountId).getOwnedGames(lookup, limit, sort, options);
  }

  getEquippedProfileItems(
    lookup: string,
    options: SteamProfileReadOptions = {},
    accountId?: string | null,
  ): Promise<SteamEquippedProfileItemsSummary> {
    return this.getClient(accountId).getEquippedProfileItems(lookup, options);
  }

  getInventoryContexts(
    lookup: string,
    options: SteamProfileReadOptions = {},
    accountId?: string | null,
  ): Promise<SteamInventoryAppSummary[]> {
    return this.getClient(accountId).getInventoryContexts(lookup, options);
  }

  getInventoryItems(
    lookup: string,
    appId: number,
    contextId: string,
    tradableOnly: boolean,
    limit: number,
    options: SteamProfileReadOptions = {},
    accountId?: string | null,
  ): Promise<SteamInventoryItemsSummary> {
    return this.getClient(accountId).getInventoryItems(
      lookup,
      appId,
      contextId,
      tradableOnly,
      limit,
      options,
    );
  }
}

export const steamCommunityClient = new SteamCommunityClient();
