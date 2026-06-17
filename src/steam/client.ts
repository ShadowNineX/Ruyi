import SteamUser from "steam-user";
import SteamCommunity from "steamcommunity";
import SteamID from "steamid";
import type CSteamUser from "steamcommunity/classes/CSteamUser";
import { env } from "../env";
import { botLogger } from "../logger";
import { steamIntegrationEnabled } from "../utils/user-identity";

const DEFAULT_COMMENT_FETCH_COUNT = 20;
const STEAM_ID64_PATTERN = /^\d{17}$/;

interface SteamCommentOptions {
  start?: number;
  count?: number;
}

interface SteamProfileCommentPage {
  comments: SteamUserComment[];
  totalCount: number;
}

type SteamUserComment = SteamCommunity.UserComment;
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
      comments: SteamUserComment[],
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
  ): Promise<SteamUserComment[]> {
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
        resolve({ comments, totalCount });
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
