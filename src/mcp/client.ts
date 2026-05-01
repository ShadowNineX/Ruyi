import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { z } from "zod";
import { aiLogger, toolLogger } from "../logger";
import { mcpRegistry, type MCPServer } from "./index";

interface ConnectedClient {
  server: MCPServer;
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: MCPToolDef[];
}

function propertyToZod(prop: Record<string, unknown>): z.ZodType {
  switch (prop.type) {
    case "string":
      if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
        return z.enum(prop.enum as [string, ...string[]]);
      }
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    default:
      return z.unknown();
  }
}

function jsonSchemaToZod(
  schema: unknown,
): z.ZodObject<Record<string, z.ZodType>> {
  if (!schema || typeof schema !== "object") {
    return z.object({});
  }

  const s = schema as Record<string, unknown>;

  if (s.type !== "object" || !s.properties) {
    return z.object({});
  }

  const props = s.properties as Record<string, Record<string, unknown>>;
  const required = (s.required as string[]) ?? [];
  const shape: Record<string, z.ZodType> = {};

  for (const [key, prop] of Object.entries(props)) {
    let fieldSchema = propertyToZod(prop);

    if (prop.description && typeof prop.description === "string") {
      fieldSchema = fieldSchema.describe(prop.description);
    }

    shape[key] = required.includes(key) ? fieldSchema : fieldSchema.optional();
  }

  return z.object(shape);
}

function createSmitheryAuthProvider(tokens: OAuthTokens): OAuthClientProvider {
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
      return tokens;
    },
    saveTokens: async () => {},
    redirectToAuthorization: async () => {},
    saveCodeVerifier: async () => {},
    codeVerifier: async () => {
      throw new Error("No code verifier");
    },
  };
}

async function connectToServer(
  server: MCPServer,
): Promise<ConnectedClient | null> {
  if (!server.isEnabled()) {
    aiLogger.debug({ server: server.name }, "MCP server not enabled, skipping");
    return null;
  }

  const config = server.getConfig();
  if (!config) {
    return null;
  }

  const client = new Client(
    { name: `ruyi-${server.name}`, version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    const serverUrl = new URL(config.url);
    const tokens = server.getTokens();

    let transport: StreamableHTTPClientTransport;

    if (tokens) {
      const authProvider = createSmitheryAuthProvider(tokens);
      transport = new StreamableHTTPClientTransport(serverUrl, {
        authProvider,
      });
    } else if (config.headers) {
      const headers = config.headers;
      const authFetch = async (
        input: Request | string | URL,
        init?: RequestInit,
      ): Promise<Response> => {
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
    } else {
      transport = new StreamableHTTPClientTransport(serverUrl);
    }

    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools = toolsResult.tools;

    aiLogger.info(
      {
        server: server.name,
        toolCount: tools.length,
        tools: tools.map((t) => t.name),
      },
      "Connected to MCP server via StreamableHTTP",
    );

    return { server, client, transport, tools };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    aiLogger.error(
      { server: server.name, error: errorMsg },
      "Failed to connect to MCP server",
    );
    return null;
  }
}

export class MCPConnectionManager {
  private readonly activeConnections = new Map<string, ConnectedClient>();
  private wrappedTools: Tool[] = [];

  private createWrappedTool(
    serverName: string,
    mcpTool: MCPToolDef,
  ): Tool | null {
    const connection = this.activeConnections.get(serverName);
    if (!connection) {
      aiLogger.warn(
        { serverName, tool: mcpTool.name },
        "No active connection for tool",
      );
      return null;
    }

    const zodSchema = jsonSchemaToZod(mcpTool.inputSchema);

    try {
      const tool = defineTool(mcpTool.name, {
        description: mcpTool.description ?? `MCP tool from ${serverName}`,
        parameters: zodSchema,
        handler: async (args) => {
          toolLogger.info(
            { server: serverName, tool: mcpTool.name, args },
            "Calling MCP tool",
          );

          try {
            const result = await connection.client.callTool({
              name: mcpTool.name,
              arguments: args,
            });

            toolLogger.info(
              { server: serverName, tool: mcpTool.name },
              "MCP tool call complete",
            );

            if (result.content && Array.isArray(result.content)) {
              const textParts = result.content
                .filter((c) => c.type === "text")
                .map((c) => (c as { type: "text"; text: string }).text);

              if (textParts.length > 0) {
                return { result: textParts.join("\n") };
              }

              return { result: result.content };
            }

            return { result };
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : "Unknown error";
            toolLogger.error(
              { server: serverName, tool: mcpTool.name, error: errorMsg },
              "MCP tool call failed",
            );
            return { error: errorMsg };
          }
        },
      });

      return tool as Tool;
    } catch (error) {
      aiLogger.error(
        { error, tool: mcpTool.name },
        "Failed to create wrapped tool",
      );
      return null;
    }
  }

  async initialize(): Promise<Tool[]> {
    aiLogger.info("Initializing MCP tool connections...");

    for (const [, connection] of this.activeConnections) {
      try {
        await connection.transport.close();
      } catch {
        // Ignore close errors
      }
    }
    this.activeConnections.clear();
    this.wrappedTools = [];

    const connections = await Promise.all(
      mcpRegistry.servers.map((server) => connectToServer(server)),
    );

    for (const connection of connections) {
      if (connection) {
        this.activeConnections.set(connection.server.name, connection);

        for (const mcpTool of connection.tools) {
          const wrapped = this.createWrappedTool(
            connection.server.name,
            mcpTool,
          );
          if (wrapped) {
            this.wrappedTools.push(wrapped);
          }
        }
      }
    }

    aiLogger.info(
      {
        servers: [...this.activeConnections.keys()],
        toolCount: this.wrappedTools.length,
        tools: this.wrappedTools.map((t) => t.name),
      },
      "MCP tools initialized",
    );

    return this.wrappedTools;
  }

  getTools(): Tool[] {
    return this.wrappedTools;
  }

  async reconnect(serverName: string): Promise<boolean> {
    const server = mcpRegistry.servers.find((s) => s.name === serverName);
    if (!server) {
      aiLogger.warn({ serverName }, "Unknown MCP server");
      return false;
    }

    const existing = this.activeConnections.get(serverName);
    if (existing) {
      try {
        await existing.transport.close();
      } catch {
        // Ignore
      }
      this.activeConnections.delete(serverName);

      this.wrappedTools = this.wrappedTools.filter(
        (t) => !existing.tools.some((mt) => mt.name === t.name),
      );
    }

    const connection = await connectToServer(server);
    if (connection) {
      this.activeConnections.set(serverName, connection);

      for (const mcpTool of connection.tools) {
        const wrapped = this.createWrappedTool(serverName, mcpTool);
        if (wrapped) {
          this.wrappedTools.push(wrapped);
        }
      }

      return true;
    }

    return false;
  }

  async closeAll(): Promise<void> {
    for (const [name, connection] of this.activeConnections) {
      try {
        await connection.transport.close();
        aiLogger.debug({ server: name }, "Closed MCP connection");
      } catch {
        // Ignore close errors
      }
    }
    this.activeConnections.clear();
    this.wrappedTools = [];
  }
}

export const mcpConnectionManager = new MCPConnectionManager();
