import SteamUser from "steam-user";
import SteamCommunity from "steamcommunity";
import SteamID from "steamid";
import type CSteamUser from "steamcommunity/classes/CSteamUser";
import { env } from "../env";
import { botLogger } from "../logger";
import { steamIntegrationEnabled } from "../utils/user-identity";
import { isValidDate } from "../utils/date";

const DEFAULT_COMMENT_FETCH_COUNT = 20;
const STEAM_ID64_PATTERN = /^\d{17}$/;

interface SteamCommentOptions {
  start?: number;
  count?: number;
}

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

type RawSteamUserComment = SteamCommunity.UserComment;
type SteamCommentNotificationListener = (
  count: number,
  myItems: number,
  discussions: number,
) => void;

type SteamProfileWithComments = Omit<CSteamUser, "comment" | "getComments"> & {
  comment(
    message: string,
    callback: (error: Error | null, commentId?: string) => void,
  ): void;
  getComments(
    options: SteamCommentOptions,
    callback: (
      error: SteamCommunity.CallbackError,
      comments: RawSteamUserComment[],
      totalCount: number,
    ) => void,
  ): void;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getSteamLogOnOptions(): { refreshToken: string; steamID: string } {
  const refreshToken = env.STEAM_REFRESH_TOKEN;
  const steamID = env.STEAM_BOT_STEAM_ID64;
  if (!refreshToken || !steamID) {
    throw new TypeError("Steam login is not fully configured");
  }
  return { refreshToken, steamID };
}

function toSteamUserLookup(profileId: string): SteamID | string {
  const normalized = profileId.trim();
  return STEAM_ID64_PATTERN.test(normalized)
    ? new SteamID(normalized)
    : normalized;
}

function normalizeCommentId(id: unknown): string | null {
  if (typeof id !== "string" && typeof id !== "number") return null;
  const normalized = String(id).trim();
  return normalized || null;
}

function normalizeCommentDate(
  comment: RawSteamUserComment,
  fetchedAt: Date,
  index: number,
): Date {
  if (isValidDate(comment.date)) return comment.date;

  botLogger.debug(
    {
      commentId: normalizeCommentId(comment.id),
      index,
    },
    "Steam comment had no valid timestamp; using fetch-order timestamp",
  );
  return new Date(fetchedAt.getTime() - index);
}

function normalizeSteamProfileComment(
  comment: RawSteamUserComment,
  fetchedAt: Date,
  index: number,
): SteamProfileComment | null {
  const id = normalizeCommentId(comment.id);
  if (!id) return null;

  return {
    id,
    authorSteamId: comment.author.steamID.getSteamID64(),
    authorName:
      typeof comment.author.name === "string"
        ? comment.author.name
        : "Steam user",
    authorAvatar:
      typeof comment.author.avatar === "string"
        ? comment.author.avatar
        : undefined,
    authorState:
      typeof comment.author.state === "string"
        ? comment.author.state
        : undefined,
    date: normalizeCommentDate(comment, fetchedAt, index),
    text: typeof comment.text === "string" ? comment.text.trim() : "",
    html: typeof comment.html === "string" ? comment.html : "",
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

class SteamCommunityClient {
  private readonly user = new SteamUser({ renewRefreshTokens: true });
  private readonly community = new SteamCommunity();
  private startPromise: Promise<void> | null = null;
  private ready = false;
  private lifecycleListenersAttached = false;

  private setOnlinePresence(reason: string): void {
    this.user.setPersona(SteamUser.EPersonaState.Online);
    botLogger.info({ reason }, "Steam account presence set to online");
  }

  private attachLifecycleListeners(): void {
    if (this.lifecycleListenersAttached) return;

    this.user.on("loggedOn", () => {
      botLogger.info("Steam account logged on");
      this.setOnlinePresence("loggedOn");
    });
    this.user.on("refreshToken", () => {
      botLogger.warn(
        "Steam emitted a refreshed token; update STEAM_REFRESH_TOKEN in env before the old token expires",
      );
    });
    this.user.on("disconnected", (eresult, message) => {
      this.ready = false;
      this.startPromise = null;
      botLogger.warn({ eresult, message }, "Steam account disconnected");
    });
    this.user.on("error", (error) => {
      this.ready = false;
      this.startPromise = null;
      botLogger.error(
        { error: getErrorMessage(error), stack: error.stack, name: error.name },
        "Steam account emitted an error",
      );
    });

    this.lifecycleListenersAttached = true;
  }

  start(): Promise<void> {
    if (!steamIntegrationEnabled()) {
      botLogger.info("Steam integration disabled; missing Steam environment");
      return Promise.resolve();
    }
    if (this.ready) return Promise.resolve();
    if (this.startPromise !== null) return this.startPromise;

    const logOnOptions = getSteamLogOnOptions();
    this.attachLifecycleListeners();

    this.startPromise = new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        this.user.off("webSession", onWebSession);
        reject(error);
      };
      const onWebSession = (_sessionId: string, cookies: string[]): void => {
        this.community.setCookies(cookies);
        this.ready = true;
        this.setOnlinePresence("webSession");
        this.user.off("error", fail);
        botLogger.info("Steam Community web session established");
        resolve();
      };

      this.user.once("webSession", onWebSession);
      this.user.once("error", fail);

      this.user.logOn(logOnOptions);
    }).catch((error: unknown) => {
      this.startPromise = null;
      botLogger.error(
        { error: getErrorMessage(error) },
        "Steam integration failed to start",
      );
      throw error;
    });

    return this.startPromise ?? Promise.resolve();
  }

  stop(): void {
    if (!steamIntegrationEnabled()) return;
    this.ready = false;
    this.startPromise = null;
    this.user.logOff();
  }

  onCommentNotification(
    listener: SteamCommentNotificationListener,
  ): () => void {
    this.user.on("newComments", listener);
    return () => {
      this.user.off("newComments", listener);
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

  private async ensureReady(): Promise<void> {
    if (!steamIntegrationEnabled()) {
      throw new TypeError("Steam integration is not configured");
    }
    if (this.ready) return;
    await this.start();
  }

  private async getProfile(
    profileId: string,
  ): Promise<SteamProfileWithComments> {
    const lookup = toSteamUserLookup(profileId);
    return new Promise((resolve, reject) => {
      this.community.getSteamUser(lookup, (error, profile) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(profile as SteamProfileWithComments);
      });
    });
  }
}

export const steamCommunityClient = new SteamCommunityClient();
