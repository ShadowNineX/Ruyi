import {
  MCPServerStreamableHttp,
  type MCPServer as AgentsMCPServer,
} from "@openai/agents";
import { aiLogger } from "../logger";

/**
 * MCP server configuration used by the OpenAI Agents SDK wrapper.
 */
export interface MCPServerConfig {
  type: "streamable_http";
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

  /** Called when the server rejects stored credentials. */
  protected async handleAuthFailure(_error: string): Promise<void> {
    // Base MCP servers may not have credentials to clear.
  }

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
      type: "streamable_http" as const,
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
      },
      "MCP server config generated",
    );

    return config;
  }

  /**
   * Perform a health check by connecting to the MCP server
   * using the OpenAI Agents SDK MCP server wrapper.
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
   * Connect to the MCP server through the OpenAI Agents SDK and list tools.
   */
  private async connectAndListTools(): Promise<{
    success: boolean;
    reachable?: boolean;
    tools?: string[];
    error?: string;
  }> {
    const server = this.createHealthCheckServer();

    try {
      await server.connect();
      const toolsResult = await server.listTools();
      const tools = toolsResult.map((tool) => tool.name);

      return { success: true, tools };
    } catch (error) {
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
        await this.handleAuthFailure(errorMsg);
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
    } finally {
      await this.closeHealthCheckServer(server);
    }
  }

  private createHealthCheckServer(): AgentsMCPServer {
    const config = this.getConfig();

    return new MCPServerStreamableHttp({
      url: this.url,
      name: `${this.name}-health-check`,
      cacheToolsList: false,
      fetch: config?.headers
        ? createAuthenticatedFetch(config.headers)
        : undefined,
    });
  }

  private async closeHealthCheckServer(server: AgentsMCPServer): Promise<void> {
    try {
      await server.close();
    } catch (error) {
      aiLogger.debug(
        { server: this.name, error: (error as Error).message },
        "MCP health-check close failed",
      );
    }
  }
}

function normalizeHeaders(headers: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};

  if (headers instanceof Headers) {
    const normalized: Record<string, string> = {};
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized[key] = value;
  }
  return normalized;
}

function createAuthenticatedFetch(headers: Record<string, string>) {
  return async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> =>
    fetch(input, {
      ...init,
      headers: {
        ...headers,
        ...normalizeHeaders(init?.headers),
      },
    });
}
