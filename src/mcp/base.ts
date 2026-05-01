import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { aiLogger } from "../logger";

/**
 * MCP server configuration type (matches SDK expectations)
 */
export interface MCPServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  tools: string[];
}

/**
 * Result of an MCP server health check.
 */
export interface MCPHealthCheckResult {
  name: string;
  url: string;
  enabled: boolean;
  /** Server responded successfully (2xx) */
  connected: boolean;
  /** Server is reachable but has auth/method issues */
  reachable: boolean;
  error?: string;
  responseTimeMs?: number;
  /** List of tools available from the MCP server */
  tools?: string[];
}

/**
 * Base class for MCP server configurations.
 * Extend this class to add new MCP servers.
 */
export abstract class MCPServer {
  /** Display name for this MCP server (e.g., "github", "reddit") */
  abstract readonly name: string;

  /** Tool name prefix used by this server to identify its tools */
  abstract readonly toolPrefix: string;

  /** Server URL */
  protected abstract readonly url: string;

  /** Whether this server is enabled (has required credentials) */
  abstract isEnabled(): boolean;

  /** Get the authorization headers for this server */
  protected abstract getHeaders(): Record<string, string> | undefined;

  /**
   * Check if a tool name belongs to this MCP server.
   */
  ownsTool(toolName: string): boolean {
    return toolName.toLowerCase().startsWith(this.toolPrefix.toLowerCase());
  }

  /**
   * Get the SDK-compatible configuration for this server.
   * Returns undefined if the server is not enabled.
   */
  getConfig(): MCPServerConfig | undefined {
    if (!this.isEnabled()) {
      aiLogger.debug(
        `${this.name.toUpperCase()} MCP server disabled (missing credentials)`,
      );
      return undefined;
    }

    const headers = this.getHeaders();
    const config = {
      type: "sse" as const,
      url: this.url,
      headers,
      tools: ["*"],
    };

    // Debug log to verify token is present
    aiLogger.debug(
      {
        server: this.name,
        url: this.url,
        hasHeaders: !!headers,
        hasAuth: !!headers?.Authorization,
        authPrefix: headers?.Authorization?.substring(0, 15) + "...",
      },
      "MCP server config generated",
    );

    return config;
  }

  /**
   * Perform a health check by connecting to the MCP server
   * using the official MCP SDK client.
   */
  async checkHealth(): Promise<MCPHealthCheckResult> {
    const result: MCPHealthCheckResult = {
      name: this.name,
      url: this.url,
      enabled: this.isEnabled(),
      connected: false,
      reachable: false,
    };

    if (!this.isEnabled()) {
      result.error = "Server disabled (missing credentials)";
      return result;
    }

    const startTime = performance.now();

    try {
      const toolsResult = await this.connectAndListTools();
      result.responseTimeMs = Math.round(performance.now() - startTime);

      if (toolsResult.success) {
        result.connected = true;
        result.reachable = true;
        result.tools = toolsResult.tools;
      } else {
        result.reachable = toolsResult.reachable ?? false;
        result.error = toolsResult.error;
      }
    } catch (error) {
      result.responseTimeMs = Math.round(performance.now() - startTime);
      result.error =
        error instanceof Error ? error.message : "Connection failed";
    }

    return result;
  }

  /**
   * Get OAuth tokens for this server if available.
   * Override in subclasses that support OAuth (e.g., Smithery).
   */
  protected getOAuthTokens(): OAuthTokens | undefined {
    return undefined;
  }

  /**
   * Public accessor for OAuth tokens (used by MCP client wrapper).
   */
  getTokens(): OAuthTokens | undefined {
    return this.getOAuthTokens();
  }

  /**
   * Connect to the MCP server using the official SDK and list tools.
   */
  private async connectAndListTools(): Promise<{
    success: boolean;
    reachable?: boolean;
    tools?: string[];
    error?: string;
  }> {
    const serverUrl = new URL(this.url);
    const tokens = this.getOAuthTokens();

    const client = new Client(
      { name: "ruyi-health-check", version: "1.0.0" },
      { capabilities: {} },
    );

    let transport: StreamableHTTPClientTransport | null = null;

    try {
      // If we have OAuth tokens, use an authProvider.
      // Otherwise inject static auth headers via a custom fetch wrapper.
      if (tokens) {
        const authProvider = this.createAuthProvider(tokens);
        transport = new StreamableHTTPClientTransport(serverUrl, {
          authProvider,
        });
      } else {
        const headers = this.getHeaders() ?? {};
        const authFetch = async (
          input: Request | string | URL,
          init?: RequestInit,
        ): Promise<Response> => {
          // Normalize init.headers — may be a Headers instance (not spreadable as a plain object)
          let existingHeaders: Record<string, string> = {};
          if (init?.headers instanceof Headers) {
            init.headers.forEach((value, key) => {
              existingHeaders[key] = value;
            });
          } else if (init?.headers) {
            existingHeaders = init.headers as Record<string, string>;
          }
          const newInit = {
            ...init,
            headers: {
              ...headers,
              ...existingHeaders,
            },
          };
          return fetch(input, newInit);
        };

        transport = new StreamableHTTPClientTransport(serverUrl, {
          fetch: authFetch,
        });
      }

      await client.connect(transport);

      // List tools
      const toolsResult = await client.listTools();
      const tools = toolsResult.tools.map((t) => t.name);

      await transport.close();

      return { success: true, tools };
    } catch (error) {
      // Close the failed transport
      if (transport) {
        try {
          await transport.close();
        } catch {
          // Ignore close errors
        }
      }

      const errorMsg = error instanceof Error ? error.message : "Unknown error";

      aiLogger.debug(
        { error: errorMsg },
        `MCP connection failed for ${this.name}`,
      );

      // Check if it's an auth error (server is reachable but credentials are wrong)
      if (
        errorMsg.includes("401") ||
        errorMsg.includes("403") ||
        errorMsg.includes("Unauthorized")
      ) {
        return {
          success: false,
          reachable: true,
          error: `Auth failed: ${errorMsg}`,
        };
      }

      // Check if server responded at all (reachable but protocol issue)
      if (
        errorMsg.includes("405") ||
        errorMsg.includes("404") ||
        errorMsg.includes("500") ||
        errorMsg.includes("Internal Server Error")
      ) {
        return {
          success: false,
          reachable: true,
          error: `Server error: ${errorMsg}`,
        };
      }

      return {
        success: false,
        reachable: false,
        error: `Connection failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Create an OAuth provider with stored tokens.
   */
  private createAuthProvider(tokens: OAuthTokens): OAuthClientProvider {
    const storedTokens = tokens;
    return {
      get redirectUrl(): string {
        return "https://smithery.ai/oauth/callback";
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: "Ruyi Discord Bot",
          redirect_uris: ["https://smithery.ai/oauth/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      clientInformation(): OAuthClientInformation | undefined {
        return undefined;
      },
      saveClientInformation: async () => {},
      tokens(): OAuthTokens | undefined {
        return storedTokens;
      },
      saveTokens: async () => {},
      redirectToAuthorization: async () => {},
      saveCodeVerifier: async () => {},
      codeVerifier: async () => {
        throw new Error("No code verifier");
      },
    };
  }
}
