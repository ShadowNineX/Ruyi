import {
  MCPServerStreamableHttp,
  connectMcpServers,
  type MCPServer as AgentsMCPServer,
  type MCPServers,
} from "@openai/agents";
import { aiLogger, toolLogger } from "../logger";
import { mcpRegistry, type MCPServer as RuyiMCPServer } from "./index";
import { createAuthenticatedFetch, getErrorMessage } from "./http";

interface MCPToolInfo {
  name: string;
  description?: string;
}

type MCPToolList = Awaited<
  ReturnType<MCPServerStreamableHttp["listTools"]>
>;
type MCPTool = MCPToolList[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasObjectType(value: unknown): boolean {
  if (value === "object") return true;
  return Array.isArray(value) && value.includes("object");
}

function isObjectSchema(value: Record<string, unknown>): boolean {
  return hasObjectType(value.type) || isRecord(value.properties);
}

function sanitizeMcpSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMcpSchema);
  if (!isRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "format") continue;
    sanitized[key] = sanitizeMcpSchema(nestedValue);
  }

  if (isObjectSchema(sanitized)) {
    sanitized.additionalProperties = false;
  }

  return sanitized;
}

class SanitizedMCPServerStreamableHttp extends MCPServerStreamableHttp {
  override async listTools(): Promise<MCPTool[]> {
    const tools = await super.listTools();
    return tools.map((tool) => ({
      ...tool,
      inputSchema: sanitizeMcpSchema(tool.inputSchema) as MCPTool["inputSchema"],
    }));
  }
}

export class MCPConnectionManager {
  private connectedServers: MCPServers | null = null;
  private activeServers: AgentsMCPServer[] = [];
  private tools: MCPToolInfo[] = [];
  private initializePromise: Promise<MCPToolInfo[]> | null = null;

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
        const message = getErrorMessage(error);
        toolLogger.error({ server: server.name, error: message }, "MCP tool call failed");
        return message;
      },
    };

    return new SanitizedMCPServerStreamableHttp(options);
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
          const errorMsg = getErrorMessage(error);
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
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = this.initializeServers().finally(() => {
      this.initializePromise = null;
    });

    return this.initializePromise;
  }

  private async initializeServers(): Promise<MCPToolInfo[]> {
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
        const sourceServer = mcpRegistry.servers.find(
          (candidate) => candidate.name === server.name,
        );
        await sourceServer?.handleConnectionFailure(error);
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
      const errorMsg = getErrorMessage(error);
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
        const errorMsg = getErrorMessage(error);
        aiLogger.warn({ error: errorMsg }, "Failed to close MCP servers cleanly");
      }
    }

    this.connectedServers = null;
    this.activeServers = [];
    this.tools = [];
  }
}

export const mcpConnectionManager = new MCPConnectionManager();
