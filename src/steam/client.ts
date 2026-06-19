import type CEconItem from 'steamcommunity/classes/CEconItem';
import type CSteamUser from 'steamcommunity/classes/CSteamUser';
import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';
import SteamID from 'steamid';
import { env } from '../env';
import { botLogger } from '../logger';
import {
  areSteamCommunityLifecycleListenersAttached,
  getSteamCommunityStartPromise,
  isSteamCommunityReady,
  setSteamCommunityLifecycleListenersAttached,
  setSteamCommunityReady,
  setSteamCommunityStartPromise,
} from '../stores/steam-client-store';
import {
  clearSteamProfileDataCache,
  getOrCreateCachedSteamProfileData,
} from '../stores/steam-profile-store';
import { isValidDate } from '../utils/date';
import { steamIntegrationEnabled } from '../utils/user-identity';

const DEFAULT_COMMENT_FETCH_COUNT = 20;
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

export interface SteamPersonaSummary {
  personaState?: number;
  personaStateFlags?: number;
  gamePlayedAppId?: number;
  gameName?: string;
  gameId?: string;
  lastSeenOnline?: number;
}

export interface SteamProfileSummary {
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

export interface SteamOwnedGameSummary {
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

export interface SteamOwnedGamesSummary {
  appCount: number;
  returnedCount: number;
  sort: SteamOwnedGamesSort;
  games: SteamOwnedGameSummary[];
  recentGames: SteamOwnedGameSummary[];
  limitations: string[];
}

export interface SteamProfileItemSummary {
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

export interface SteamEquippedProfileItemsSummary {
  profileBackground: SteamProfileItemSummary | null;
  miniProfileBackground: SteamProfileItemSummary | null;
  avatarFrame: SteamProfileItemSummary | null;
  animatedAvatar: SteamProfileItemSummary | null;
  profileModifier: SteamProfileItemSummary | null;
  limitations: string[];
}

export interface SteamInventoryContextSummary {
  id: string;
  name: string;
  assetCount: number | null;
}

export interface SteamInventoryAppSummary {
  appId: number;
  name: string;
  iconUrl: string | null;
  inventoryUrl: string | null;
  assetCount: number | null;
  contexts: SteamInventoryContextSummary[];
}

export interface SteamInventoryItemSummary {
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

export interface SteamInventoryItemsSummary {
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
  | 'getProfileBackground'
> & {
  getAvatarURL: (size?: string, protocol?: string) => string;
  getProfileBackground: (
    callback: (error: SteamCommunity.CallbackError, backgroundUrl: string | null) => void,
  ) => void;
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

function getSteamLogOnOptions(): { refreshToken: string; steamID: string } {
  const refreshToken = env.STEAM_REFRESH_TOKEN;
  const steamID = env.STEAM_BOT_STEAM_ID64;
  if (!refreshToken || !steamID) {
    throw new TypeError('Steam login is not fully configured');
  }
  return { refreshToken, steamID };
}

function toSteamUserLookup(profileId: string): SteamID | string {
  const normalized = normalizeSteamProfileLookup(profileId);
  return STEAM_ID64_PATTERN.test(normalized)
    ? new SteamID(normalized)
    : normalized;
}

export function normalizeSteamProfileLookup(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) { return trimmed; }

  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    if (!hostname.endsWith('steamcommunity.com')) { return trimmed; }

    const [kind, identifier] = url.pathname.split('/').filter(Boolean);
    if ((kind === 'profiles' || kind === 'id') && identifier) {
      return decodeURIComponent(identifier);
    }
  } catch {
    // Plain SteamID64 or vanity ID, not a URL.
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

class SteamCommunityClient {
  private readonly user = new SteamUser({ renewRefreshTokens: true });
  private readonly community = new SteamCommunity();

  private setOnlinePresence(reason: string): void {
    this.user.setPersona(SteamUser.EPersonaState.Online);
    botLogger.info({ reason }, 'Steam account presence set to online');
  }

  private attachLifecycleListeners(): void {
    if (areSteamCommunityLifecycleListenersAttached()) { return; }

    this.user.on('loggedOn', () => {
      botLogger.info('Steam account logged on');
      this.setOnlinePresence('loggedOn');
    });
    this.user.on('refreshToken', () => {
      botLogger.warn(
        'Steam emitted a refreshed token; update STEAM_REFRESH_TOKEN in env before the old token expires',
      );
    });
    this.user.on('disconnected', (eresult, message) => {
      setSteamCommunityReady(false);
      setSteamCommunityStartPromise(null);
      clearSteamProfileDataCache();
      botLogger.warn({ eresult, message }, 'Steam account disconnected');
    });
    this.user.on('error', (error) => {
      setSteamCommunityReady(false);
      setSteamCommunityStartPromise(null);
      clearSteamProfileDataCache();
      botLogger.error(
        { error: getErrorMessage(error), stack: error.stack, name: error.name },
        'Steam account emitted an error',
      );
    });

    setSteamCommunityLifecycleListenersAttached(true);
  }

  start(): Promise<void> {
    if (!steamIntegrationEnabled()) {
      botLogger.info('Steam integration disabled; missing Steam environment');
      return Promise.resolve();
    }
    if (isSteamCommunityReady()) { return Promise.resolve(); }

    const existingStartPromise = getSteamCommunityStartPromise();
    if (existingStartPromise !== null) { return existingStartPromise; }

    const logOnOptions = getSteamLogOnOptions();
    this.attachLifecycleListeners();

    const startPromise = new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        this.user.off('webSession', onWebSession);
        reject(error);
      };
      const onWebSession = (_sessionId: string, cookies: string[]): void => {
        this.community.setCookies(cookies);
        setSteamCommunityReady(true);
        this.setOnlinePresence('webSession');
        this.user.off('error', fail);
        botLogger.info('Steam Community web session established');
        resolve();
      };

      this.user.once('webSession', onWebSession);
      this.user.once('error', fail);

      this.user.logOn(logOnOptions);
    }).catch((error: unknown) => {
      setSteamCommunityStartPromise(null);
      botLogger.error(
        { error: getErrorMessage(error) },
        'Steam integration failed to start',
      );
      throw error;
    });

    setSteamCommunityStartPromise(startPromise);
    return startPromise;
  }

  stop(): void {
    if (!steamIntegrationEnabled()) { return; }
    setSteamCommunityReady(false);
    setSteamCommunityStartPromise(null);
    clearSteamProfileDataCache();
    this.user.logOff();
  }

  isReady(): boolean {
    return isSteamCommunityReady();
  }

  onCommentNotification(
    listener: SteamCommentNotificationListener,
  ): () => void {
    this.user.on('newComments', listener);
    return () => {
      this.user.off('newComments', listener);
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
      `profile-summary:${normalizeSteamProfileLookup(lookup)}`,
      async () => {
        await this.ensureReady();
        const profile = await this.getProfile(lookup, options);
        const steamId64 = profileSteamId64(profile);
        const [backgroundUrl, persona] = await Promise.all([
          this.getProfileBackground(profile),
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
      `owned-games:${normalizeSteamProfileLookup(lookup)}`,
      async () => {
        await this.ensureReady();
        const profile = await this.getProfile(lookup, options);
        return this.user.getUserOwnedApps(profile.steamID, {
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
    return getOrCreateCachedSteamProfileData(
      `equipped-items:${normalizeSteamProfileLookup(lookup)}`,
      async () => {
        await this.ensureReady();
        const profile = await this.getProfile(lookup, options);
        const items = await this.user.getEquippedProfileItems(profile.steamID, {
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
    if (isSteamCommunityReady()) { return; }
    await this.start();
  }

  private async getProfile(
    profileId: string,
    options: SteamProfileReadOptions = {},
  ): Promise<SteamProfileWithComments> {
    const normalized = normalizeSteamProfileLookup(profileId);
    return getOrCreateCachedSteamProfileData(`profile:${normalized}`, async () => {
      const lookup = toSteamUserLookup(profileId);
      return new Promise((resolve, reject) => {
        this.community.getSteamUser(lookup, (error, profile) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(profile as unknown as SteamProfileWithComments);
        });
      });
    }, options);
  }

  private async getProfileBackground(
    profile: SteamProfileWithComments,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      profile.getProfileBackground((error, backgroundUrl) => {
        if (error) {
          botLogger.debug(
            {
              steamId64: profileSteamId64(profile),
              error: getErrorMessage(error),
            },
            'Steam profile background unavailable',
          );
          resolve(null);
          return;
        }
        resolve(backgroundUrl);
      });
    });
  }

  private async getPersona(steamId64: string): Promise<SteamPersonaSummary | null> {
    try {
      const { personas } = await this.user.getPersonas([steamId64]);
      return normalizeSteamPersona(personas[steamId64]);
    } catch (error) {
      botLogger.debug(
        { steamId64, error: getErrorMessage(error) },
        'Steam persona unavailable',
      );
      return null;
    }
  }
}

export const steamCommunityClient = new SteamCommunityClient();
