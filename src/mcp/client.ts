import {
  MCPServerStreamableHttp,
  connectMcpServers,
  type MCPServer as AgentsMCPServer,
  type MCPServers,
} from "@openai/agents";
import { aiLogger, toolLogger } from "../logger";
import { mcpRegistry, type MCPServer as RuyiMCPServer } from "./index";

interface MCPToolInfo {
  name: string;
  description?: string;
}

type AuthenticatedFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers) return {};

  if (headers instanceof Headers) {
    const normalized: Record<string, string> = {};
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }

  if (Array.isArray(headers)) {
    const normalized: Record<string, string> = {};
    for (const entry of headers) {
      if (
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string"
      ) {
        normalized[entry[0]] = entry[1];
      }
    }
    return normalized;
  }

  if (typeof headers === "object") {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") normalized[key] = value;
    }
    return normalized;
  }

  return {};
}

function createAuthenticatedFetch(
  headers: Record<string, string>,
): AuthenticatedFetch {
  return async (input, init) => {
    const nextInit = {
      ...init,
      headers: {
        ...headers,
        ...normalizeHeaders(init?.headers),
      },
    };
    return fetch(input, nextInit);
  };
}

export class MCPConnectionManager {
  private connectedServers: MCPServers | null = null;
  private activeServers: AgentsMCPServer[] = [];
  private tools: MCPToolInfo[] = [];

  private createAgentsServer(server: RuyiMCPServer): AgentsMCPServer | null {
    if (!server.isEnabled()) {
      aiLogger.debug({ server: server.name }, "MCP server not enabled, skipping");
      return null;
    }

    const config = server.getConfig();
    if (!config) return null;

    const options = {
      url: config.url,
      name: server.name,
      cacheToolsList: true,
      fetch: config.headers ? createAuthenticatedFetch(config.headers) : undefined,
      errorFunction: ({ error }: { error: unknown }) => {
        const message = error instanceof Error ? error.message : "Unknown MCP error";
        toolLogger.error({ server: server.name, error: message }, "MCP tool call failed");
        return message;
      },
    };

    return new MCPServerStreamableHttp(options);
  }

  private async refreshToolCache(): Promise<MCPToolInfo[]> {
    const toolGroups = await Promise.all(
      this.activeServers.map(async (server) => {
        try {
          const tools = await server.listTools();
          return tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
          }));
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          aiLogger.warn(
            { server: server.name, error: errorMsg },
            "Failed to list MCP tools from active server",
          );
          return [];
        }
      }),
    );

    return toolGroups.flat();
  }

  async initialize(): Promise<MCPToolInfo[]> {
    aiLogger.info("Initializing MCP server connections...");
    await this.closeAll();

    const servers = mcpRegistry.servers
      .map((server) => this.createAgentsServer(server))
      .filter((server): server is AgentsMCPServer => server !== null);

    if (servers.length === 0) {
      aiLogger.info("No enabled MCP servers to connect");
      return [];
    }

    try {
      this.connectedServers = await connectMcpServers(servers, {
        connectInParallel: true,
        dropFailed: true,
        strict: false,
        suppressAbortError: true,
      });
      this.activeServers = this.connectedServers.active;
      this.tools = await this.refreshToolCache();

      for (const [server, error] of this.connectedServers.errors) {
        aiLogger.warn(
          { server: server.name, error: error.message },
          "MCP server failed to connect",
        );
      }

      aiLogger.info(
        {
          servers: this.activeServers.map((server) => server.name),
          failed: this.connectedServers.failed.map((server) => server.name),
          toolCount: this.tools.length,
          tools: this.tools.map((tool) => tool.name),
        },
        "MCP servers initialized through OpenAI Agents SDK",
      );

      return this.tools;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      aiLogger.error({ error: errorMsg }, "Failed to initialize MCP servers");
      this.connectedServers = null;
      this.activeServers = [];
      this.tools = [];
      return [];
    }
  }

  getServers(): AgentsMCPServer[] {
    return this.activeServers;
  }

  getTools(): MCPToolInfo[] {
    return this.tools;
  }

  async reconnect(serverName: string): Promise<boolean> {
    await this.initialize();
    return this.activeServers.some((server) => server.name === serverName);
  }

  async closeAll(): Promise<void> {
    if (this.connectedServers) {
      try {
        await this.connectedServers.close();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        aiLogger.warn({ error: errorMsg }, "Failed to close MCP servers cleanly");
      }
    }

    this.connectedServers = null;
    this.activeServers = [];
    this.tools = [];
  }
}

export const mcpConnectionManager = new MCPConnectionManager();
