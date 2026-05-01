import { MCPServer } from "./base";
import { env } from "../env";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  getSmitheryTokens,
  getAllSmitheryTokens,
  saveSmitheryTokens,
  isTokenExpired,
  type ISmitheryToken,
  type SmitheryServerId,
} from "../db/models";
import { aiLogger } from "../logger";

// Cache for tokens per server to avoid DB queries on every request
const cachedTokens = new Map<SmitheryServerId, ISmitheryToken>();
const cacheLoadedAt = new Map<SmitheryServerId, number>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache

/**
 * Base class for Smithery-hosted MCP servers.
 * Provides common authentication and URL handling for all Smithery servers.
 *
 * Tokens are stored in MongoDB per-server and managed automatically.
 * Use /smithery command to authorize and store tokens.
 *
 * @see https://smithery.ai/docs/use/connect
 */
export abstract class SmitheryMCPServer extends MCPServer {
  /** The Smithery server slug (e.g., "brave", "youtube") */
  protected abstract readonly slug: SmitheryServerId;

  protected get url(): string {
    return `https://server.smithery.ai/${this.slug}`;
  }

  /**
   * Load tokens from database with caching (per-server).
   */
  private async loadTokens(): Promise<ISmitheryToken | null> {
    const now = Date.now();
    const cached = cachedTokens.get(this.slug);
    const loadedAt = cacheLoadedAt.get(this.slug) ?? 0;

    if (cached && now - loadedAt < CACHE_TTL_MS) {
      return cached;
    }

    const tokens = await getSmitheryTokens(this.slug);
    if (tokens) {
      cachedTokens.set(this.slug, tokens);
      cacheLoadedAt.set(this.slug, now);
    }
    return tokens;
  }

  /**
   * Refresh the access token using the refresh token.
   */
  private async refreshAccessToken(
    refreshToken: string,
  ): Promise<ISmitheryToken | null> {
    try {
      aiLogger.info({ server: this.slug }, "Refreshing Smithery access token");

      const response = await fetch("https://smithery.ai/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        aiLogger.error({ error, server: this.slug }, "Failed to refresh token");
        return null;
      }

      const data = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
      };

      // Save the new tokens for this server
      const newTokens = await saveSmitheryTokens(this.slug, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refreshToken,
        expiresIn: data.expires_in,
      });

      // Update cache
      cachedTokens.set(this.slug, newTokens);
      cacheLoadedAt.set(this.slug, Date.now());

      aiLogger.info({ server: this.slug }, "Token refreshed successfully");
      return newTokens;
    } catch (error) {
      aiLogger.error({ error, server: this.slug }, "Error refreshing token");
      return null;
    }
  }

  /**
   * Get valid tokens, refreshing if necessary.
   */
  private async getValidTokens(): Promise<ISmitheryToken | null> {
    const tokens = await this.loadTokens();
    if (!tokens) return null;

    // Check if token is expired and we have a refresh token
    if (isTokenExpired(tokens) && tokens.refreshToken) {
      return this.refreshAccessToken(tokens.refreshToken);
    }

    return tokens;
  }

  /**
   * Get OAuth tokens for Smithery authentication.
   */
  protected override getOAuthTokens(): OAuthTokens | undefined {
    // For sync access, use cached tokens for this server
    const tokens = cachedTokens.get(this.slug);
    if (!tokens) return undefined;

    return {
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      refresh_token: tokens.refreshToken,
    };
  }

  /**
   * Check if tokens are available (sync check using cache or env fallback).
   */
  isEnabled(): boolean {
    // Check cache for this server
    if (cachedTokens.has(this.slug)) return true;
    // Fallback to env for initial load before DB is checked
    return !!env.SMITHERY_ACCESS_TOKEN;
  }

  protected getHeaders(): Record<string, string> | undefined {
    // Use cached token for this server, or env fallback
    const token =
      cachedTokens.get(this.slug)?.accessToken ?? env.SMITHERY_ACCESS_TOKEN;
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  }

  /**
   * Initialize tokens from database for all Smithery servers.
   * Call this at startup to load tokens into cache.
   */
  static async initializeTokens(): Promise<{
    brave: boolean;
    youtube: boolean;
  }> {
    const allTokens = await getAllSmitheryTokens();
    const result: Record<SmitheryServerId, boolean> = {
      brave: false,
      youtube: false,
    };

    for (const tokens of allTokens) {
      const serverId = tokens.serverId;
      cachedTokens.set(serverId, tokens);
      cacheLoadedAt.set(serverId, Date.now());
      result[serverId] = true;
      aiLogger.info(
        { server: serverId },
        "Smithery tokens loaded from database",
      );

      // Check if expired and try to refresh
      if (isTokenExpired(tokens) && tokens.refreshToken) {
        aiLogger.info(
          { server: serverId },
          "Tokens expired, attempting refresh",
        );
        // Create a temporary instance to refresh
        const instance = new (class extends SmitheryMCPServer {
          readonly name = "init";
          readonly toolPrefix = "";
          protected readonly slug = serverId;
        })();
        const refreshed = await instance.refreshAccessToken(
          tokens.refreshToken,
        );
        result[serverId] = !!refreshed;
      }
    }

    return result;
  }
}
