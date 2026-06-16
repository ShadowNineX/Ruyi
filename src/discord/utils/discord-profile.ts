import {
  ActivityType,
  type Activity,
  type Guild,
  type GuildMember,
  type HexColorString,
  type PresenceStatus,
  type User,
  type UserFlagsString,
} from "discord.js";
import { botLogger } from "../../logger";

const USER_ID_REGEX = /^\d{17,20}$/;
const USER_MENTION_REGEX = /^<@!?(\d{17,20})>$/;

interface ProfileImage {
  url: string | null;
  description: string;
}

interface AvatarDecoration {
  url: string | null;
  asset: string | null;
  skuId: string | null;
}

interface Nameplate {
  asset: string;
  label: string;
  palette: string;
  skuId: string;
}

export interface DiscordActivityInfo {
  name: string;
  type: string;
  typeCode: ActivityType;
  summary: string;
  details: string | null;
  state: string | null;
  emoji: string | null;
  url: string | null;
  applicationId: string | null;
  createdAt: string | null;
  startedAt: string | null;
  endsAt: string | null;
  party: {
    id: string | null;
    size: [number, number] | null;
  } | null;
  assets: {
    largeImageUrl: string | null;
    largeText: string | null;
    smallImageUrl: string | null;
    smallText: string | null;
  } | null;
}

export interface DiscordPresenceInfo {
  available: boolean;
  status: PresenceStatus | null;
  clientStatus: Record<string, string> | null;
  activities: DiscordActivityInfo[];
  primaryActivity: DiscordActivityInfo | null;
  activeActivityCount: number;
  unavailableReason: string | null;
}

export interface DiscordProfile {
  id: string;
  username: string;
  globalName: string | null;
  displayName: string;
  nickname: string | null;
  tag: string;
  bot: boolean;
  system: boolean;
  createdAt: string;
  joinedServerAt: string | null;
  accentColor: number | null;
  hexAccentColor: HexColorString | null;
  publicFlags: UserFlagsString[];
  avatar: {
    user: ProfileImage;
    server: ProfileImage;
    display: ProfileImage;
    default: ProfileImage;
  };
  banner: {
    user: ProfileImage;
    server: ProfileImage;
    display: ProfileImage;
  };
  avatarDecoration: {
    user: AvatarDecoration;
    server: AvatarDecoration;
    display: AvatarDecoration;
  };
  collectibles: {
    nameplate: Nameplate | null;
  };
  primaryGuild: {
    tag: string | null;
    badgeUrl: string | null;
    identityEnabled: boolean | null;
    identityGuildId: string | null;
  } | null;
  availableImageTargets: Array<{
    key: string;
    label: string;
    url: string;
    suggestedDescribeImageQuestion: string;
  }>;
  unavailable: string[];
}

type DiscordProfileBase = Omit<
  DiscordProfile,
  "availableImageTargets" | "unavailable"
>;

const ACTIVITY_TYPE_NAMES = ActivityType as unknown as Record<number, string>;

export function normalizeUserLookup(query: string): string {
  return USER_MENTION_REGEX.exec(query.trim())?.[1] ?? query.trim();
}

export function unavailableDiscordPresence(
  reason: string,
): DiscordPresenceInfo {
  return {
    available: false,
    status: null,
    clientStatus: null,
    activities: [],
    primaryActivity: null,
    activeActivityCount: 0,
    unavailableReason: reason,
  };
}

function image(url: string | null | undefined, description: string): ProfileImage {
  return { url: url ?? null, description };
}

function decorationFrom(
  url: string | null | undefined,
  data: { asset: string; skuId: string } | null,
): AvatarDecoration {
  return {
    url: url ?? null,
    asset: data?.asset ?? null,
    skuId: data?.skuId ?? null,
  };
}

function formatFlags(user: User): UserFlagsString[] {
  return user.flags?.toArray() ?? [];
}

function getNameplate(user: User): Nameplate | null {
  const nameplate = user.collectibles?.nameplate;
  if (!nameplate) return null;

  return {
    asset: nameplate.asset,
    label: nameplate.label,
    palette: nameplate.palette,
    skuId: nameplate.skuId,
  };
}

function toIso(date: Date | null | undefined): string | null {
  return date?.toISOString() ?? null;
}

function activityTypeName(type: ActivityType): string {
  return ACTIVITY_TYPE_NAMES[type] ?? String(type);
}

function activitySummary(
  type: string,
  name: string,
  details: string | null,
  state: string | null,
  emoji: string | null,
): string {
  const parts = [`${type}: ${name}`];
  if (details) parts.push(`details: ${details}`);
  if (state) parts.push(`state: ${state}`);
  if (emoji) parts.push(`emoji: ${emoji}`);
  return parts.join(" | ");
}

function formatDiscordActivity(activity: Activity): DiscordActivityInfo {
  const type = activityTypeName(activity.type);
  const details = activity.details ?? null;
  const state = activity.state ?? null;
  const emoji = activity.emoji?.toString() ?? null;
  const assets = activity.assets
    ? {
        largeImageUrl: activity.assets.largeImageURL(),
        largeText: activity.assets.largeText,
        smallImageUrl: activity.assets.smallImageURL(),
        smallText: activity.assets.smallText,
      }
    : null;

  return {
    name: activity.name,
    type,
    typeCode: activity.type,
    summary: activitySummary(type, activity.name, details, state, emoji),
    details,
    state,
    emoji,
    url: activity.url,
    applicationId: activity.applicationId,
    createdAt: toIso(activity.createdAt),
    startedAt: toIso(activity.timestamps?.start),
    endsAt: toIso(activity.timestamps?.end),
    party: activity.party
      ? {
          id: activity.party.id,
          size: activity.party.size ?? null,
        }
      : null,
    assets,
  };
}

export function buildDiscordPresence(member: GuildMember): DiscordPresenceInfo {
  const presence = member.presence ?? member.guild.presences.cache.get(member.id);
  if (!presence) {
    return unavailableDiscordPresence(
      "No current presence is visible for this server member. The user may be offline/invisible, uncached, or the Guild Presences intent may be unavailable.",
    );
  }

  const activities = presence.activities.map(formatDiscordActivity);
  const primaryActivity =
    activities.find((activity) => activity.typeCode !== ActivityType.Custom) ??
    activities[0] ??
    null;

  return {
    available: true,
    status: presence.status,
    clientStatus: presence.clientStatus
      ? { ...presence.clientStatus }
      : null,
    activities,
    primaryActivity,
    activeActivityCount: activities.length,
    unavailableReason: null,
  };
}

function profileImageTargets(profile: DiscordProfileBase) {
  const targets = [
    {
      key: "display_avatar",
      label: "display avatar/profile picture",
      url: profile.avatar.display.url,
      suggestedDescribeImageQuestion:
        "Describe this Discord profile picture/avatar. Mention visible subject, colors, style, text, and mood.",
    },
    {
      key: "user_avatar",
      label: "global user avatar",
      url: profile.avatar.user.url,
      suggestedDescribeImageQuestion:
        "Describe this Discord global avatar. Mention visible subject, colors, style, text, and mood.",
    },
    {
      key: "server_avatar",
      label: "server-specific avatar",
      url: profile.avatar.server.url,
      suggestedDescribeImageQuestion:
        "Describe this Discord server-specific avatar. Mention visible subject, colors, style, text, and mood.",
    },
    {
      key: "display_banner",
      label: "display banner",
      url: profile.banner.display.url,
      suggestedDescribeImageQuestion:
        "Describe this Discord profile banner. Mention visible subject, colors, style, text, and mood.",
    },
    {
      key: "avatar_decoration",
      label: "avatar decoration",
      url: profile.avatarDecoration.display.url,
      suggestedDescribeImageQuestion:
        "Describe this Discord avatar decoration overlay. Mention its shape, colors, theme, and visible effects.",
    },
    {
      key: "primary_guild_badge",
      label: "primary guild badge",
      url: profile.primaryGuild?.badgeUrl,
      suggestedDescribeImageQuestion:
        "Describe this Discord guild tag badge. Mention visible icon, colors, and style.",
    },
  ];

  return targets.filter(
    (target): target is Omit<typeof target, "url"> & { url: string } =>
      typeof target.url === "string" && target.url.length > 0,
  );
}

function unavailableProfileFields(profile: DiscordProfileBase): string[] {
  const unavailable: string[] = [];
  if (!profile.banner.display.url) unavailable.push("profile banner");
  if (!profile.avatarDecoration.display.url) unavailable.push("avatar decoration");
  if (!profile.collectibles.nameplate) unavailable.push("nameplate collectible");
  if (!profile.primaryGuild?.tag) unavailable.push("primary guild tag");
  return unavailable;
}

export async function resolveGuildMember(
  guild: Guild,
  query: string,
): Promise<GuildMember | null> {
  const lookup = normalizeUserLookup(query);
  if (!lookup) return null;
  const lowerLookup = lookup.toLowerCase();

  const member = USER_ID_REGEX.test(lookup)
    ? await guild.members.fetch(lookup).catch((error: unknown) => {
        botLogger.debug(
          { query, error: (error as Error).message },
          "Could not fetch profile member by ID",
        );
        return null;
      })
    : null;
  if (member) return member.fetch(true);

  const members = await guild.members.fetch({ query: lookup, limit: 10 });
  const found =
    members.find(
      (candidate) =>
        candidate.user.username.toLowerCase() === lowerLookup ||
        candidate.displayName.toLowerCase() === lowerLookup ||
        candidate.user.globalName?.toLowerCase() === lowerLookup,
    ) ??
    members.first() ??
    null;

  return found ? found.fetch(true) : null;
}

export async function buildDiscordProfile(member: GuildMember): Promise<DiscordProfile> {
  const fetchedMember = await member.fetch(true);
  const user = await fetchedMember.user.fetch(true);
  const displayAvatarUrl = fetchedMember.displayAvatarURL({
    extension: "png",
    size: 1024,
  });
  const displayBannerUrl = fetchedMember.displayBannerURL({
    extension: "png",
    size: 1024,
  });
  const guildBadgeUrl = user.guildTagBadgeURL({ extension: "png", size: 256 });

  const profileBase: DiscordProfileBase = {
    id: user.id,
    username: user.username,
    globalName: user.globalName,
    displayName: fetchedMember.displayName,
    nickname: fetchedMember.nickname,
    tag: user.tag,
    bot: user.bot,
    system: user.system,
    createdAt: user.createdAt.toISOString(),
    joinedServerAt: fetchedMember.joinedAt?.toISOString() ?? null,
    accentColor: user.accentColor ?? null,
    hexAccentColor: user.hexAccentColor ?? null,
    publicFlags: formatFlags(user),
    avatar: {
      user: image(
        user.avatarURL({ extension: "png", size: 1024 }),
        "Global Discord avatar. Null means the user is using their default avatar.",
      ),
      server: image(
        fetchedMember.avatarURL({ extension: "png", size: 1024 }),
        "Server-specific avatar. Null means no server avatar is equipped here.",
      ),
      display: image(
        displayAvatarUrl,
        "Currently visible avatar/profile picture in this server.",
      ),
      default: image(user.defaultAvatarURL, "Discord default avatar fallback."),
    },
    banner: {
      user: image(
        user.bannerURL({ extension: "png", size: 1024 }),
        "Global profile banner. Null means no global banner is visible to the bot.",
      ),
      server: image(
        fetchedMember.bannerURL({ extension: "png", size: 1024 }),
        "Server-specific profile banner. Null means no server banner is equipped here.",
      ),
      display: image(
        displayBannerUrl,
        "Currently visible profile banner in this server.",
      ),
    },
    avatarDecoration: {
      user: decorationFrom(user.avatarDecorationURL(), user.avatarDecorationData),
      server: decorationFrom(
        fetchedMember.avatarDecorationURL(),
        fetchedMember.avatarDecorationData,
      ),
      display: decorationFrom(
        fetchedMember.displayAvatarDecorationURL(),
        fetchedMember.avatarDecorationData ?? user.avatarDecorationData,
      ),
    },
    collectibles: {
      nameplate: getNameplate(user),
    },
    primaryGuild: user.primaryGuild
      ? {
          tag: user.primaryGuild.tag,
          badgeUrl: guildBadgeUrl,
          identityEnabled: user.primaryGuild.identityEnabled,
          identityGuildId: user.primaryGuild.identityGuildId,
        }
      : null,
  };

  return {
    ...profileBase,
    availableImageTargets: profileImageTargets(profileBase),
    unavailable: unavailableProfileFields(profileBase),
  };
}

export async function buildDiscordUserProfile(user: User): Promise<DiscordProfile> {
  const fetchedUser = await user.fetch(true);
  const avatarUrl = fetchedUser.avatarURL({ extension: "png", size: 1024 });
  const bannerUrl = fetchedUser.bannerURL({ extension: "png", size: 1024 });
  const guildBadgeUrl = fetchedUser.guildTagBadgeURL({
    extension: "png",
    size: 256,
  });

  const profileBase: DiscordProfileBase = {
    id: fetchedUser.id,
    username: fetchedUser.username,
    globalName: fetchedUser.globalName,
    displayName: fetchedUser.globalName ?? fetchedUser.username,
    nickname: null,
    tag: fetchedUser.tag,
    bot: fetchedUser.bot,
    system: fetchedUser.system,
    createdAt: fetchedUser.createdAt.toISOString(),
    joinedServerAt: null,
    accentColor: fetchedUser.accentColor ?? null,
    hexAccentColor: fetchedUser.hexAccentColor ?? null,
    publicFlags: formatFlags(fetchedUser),
    avatar: {
      user: image(
        avatarUrl,
        "Global Discord avatar. Null means the user is using their default avatar.",
      ),
      server: image(null, "Server-specific avatar is unavailable in a private chat."),
      display: image(avatarUrl ?? fetchedUser.defaultAvatarURL, "Global avatar/profile picture."),
      default: image(fetchedUser.defaultAvatarURL, "Discord default avatar fallback."),
    },
    banner: {
      user: image(
        bannerUrl,
        "Global profile banner. Null means no global banner is visible to the bot.",
      ),
      server: image(null, "Server-specific profile banner is unavailable in a private chat."),
      display: image(bannerUrl, "Global profile banner."),
    },
    avatarDecoration: {
      user: decorationFrom(
        fetchedUser.avatarDecorationURL(),
        fetchedUser.avatarDecorationData,
      ),
      server: decorationFrom(null, null),
      display: decorationFrom(
        fetchedUser.avatarDecorationURL(),
        fetchedUser.avatarDecorationData,
      ),
    },
    collectibles: {
      nameplate: getNameplate(fetchedUser),
    },
    primaryGuild: fetchedUser.primaryGuild
      ? {
          tag: fetchedUser.primaryGuild.tag,
          badgeUrl: guildBadgeUrl,
          identityEnabled: fetchedUser.primaryGuild.identityEnabled,
          identityGuildId: fetchedUser.primaryGuild.identityGuildId,
        }
      : null,
  };

  return {
    ...profileBase,
    availableImageTargets: profileImageTargets(profileBase),
    unavailable: unavailableProfileFields(profileBase),
  };
}

export function formatProfileContext(profile: DiscordProfile): string {
  const lines = [
    `Discord profile for current user:`,
    `  - username: ${profile.username}`,
    profile.globalName ? `  - global name: ${profile.globalName}` : null,
    `  - display name: ${profile.displayName}`,
    profile.nickname ? `  - server nickname: ${profile.nickname}` : null,
    `  - avatar/profile picture URL: ${profile.avatar.display.url}`,
    profile.banner.display.url
      ? `  - profile banner URL: ${profile.banner.display.url}`
      : `  - profile banner URL: none visible`,
    profile.avatarDecoration.display.url
      ? `  - avatar decoration URL: ${profile.avatarDecoration.display.url}`
      : `  - avatar decoration URL: none visible`,
    profile.collectibles.nameplate
      ? `  - nameplate: ${profile.collectibles.nameplate.label || profile.collectibles.nameplate.asset} (${profile.collectibles.nameplate.palette})`
      : null,
    profile.primaryGuild?.tag
      ? `  - primary guild tag: ${profile.primaryGuild.tag}`
      : null,
    `  - Use get_user_info for full profile metadata; use describe_image on the relevant image URL when asked what an avatar/banner/decoration looks like.`,
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
}

export function formatPresenceContext(
  presence: DiscordPresenceInfo | null,
): string {
  if (!presence?.available) return "";

  const lines = [
    "Current Discord presence for the target user:",
    presence.status ? `  - status: ${presence.status}` : null,
    presence.clientStatus
      ? `  - clients: ${Object.entries(presence.clientStatus)
          .map(([client, status]) => `${client}=${status}`)
          .join(", ")}`
      : null,
    presence.activities.length > 0
      ? `  - activities: ${presence.activities
          .map((activity) => activity.summary)
          .join("; ")}`
      : "  - activities: none visible",
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
}
