import { z } from "zod";
import { env } from "../env";
import { mcpLogger } from "../logger";
import {
  getAllSmitheryConnections,
  saveSmitheryConnection,
  type ISmitheryConnection,
  type SmitheryConnectionStatus,
  type SmitheryServerId,
} from "../db/models";
import { SMITHERY_SERVERS } from "./smithery-catalog";

const SMITHERY_API_BASE_URL = "https://api.smithery.ai";
const SMITHERY_MCP_BASE_URL = "https://mcp.smithery.run";
const SERVICE_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const ConnectionStatusSchema = z.looseObject({
  state: z.string(),
  setupUrl: z.string().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});

const ConnectionSchema = z.looseObject({
  connectionId: z.string(),
  name: z.string().optional(),
  mcpUrl: z.string().nullable().optional(),
  status: ConnectionStatusSchema,
});

const DeleteConnectionSchema = z.looseObject({
  success: z.boolean(),
});

const ServiceTokenSchema = z.looseObject({
  token: z.string(),
  expiresAt: z.string(),
});

const SmitheryToolSchema = z.looseObject({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  annotations: z
    .looseObject({
      readOnlyHint: z.boolean().optional(),
    })
    .optional(),
});

const ToolListEnvelopeSchema = z.looseObject({
  tools: z.array(SmitheryToolSchema).default([]),
});

const ErrorResponseSchema = z.looseObject({
  message: z.string().optional(),
  error: z.string().optional(),
});

export interface SmitheryConnectionSnapshot {
  connectionId: string;
  status: SmitheryConnectionStatus;
  setupUrl?: string;
  errorMessage?: string;
}

export interface SmitheryToolSummary {
  name: string;
  title?: string;
  description?: string;
  readOnly?: boolean;
}

interface CachedServiceToken {
  token: string;
  expiresAtMs: number;
}

export class SmitheryApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SmitheryApiError";
  }
}

let cachedServiceToken: CachedServiceToken | null = null;

function requireSmitheryConfig(): {
  apiKey: string;
  namespace: string;
} {
  if (!env.SMITHERY_API_KEY || !env.SMITHERY_NAMESPACE) {
    throw new Error(
      "Smithery Connect is not configured. Set SMITHERY_API_KEY and SMITHERY_NAMESPACE.",
    );
  }

  return {
    apiKey: env.SMITHERY_API_KEY,
    namespace: env.SMITHERY_NAMESPACE,
  };
}

function normalizeStatus(state: string): SmitheryConnectionStatus {
  switch (state) {
    case "connected":
    case "auth_required":
    case "input_required":
    case "disconnected":
    case "error":
      return state;
    default:
      return "unknown";
  }
}

function getConnectionId(serverId: SmitheryServerId): string {
  return serverId;
}

function getApiUrl(path: string): string {
  return `${SMITHERY_API_BASE_URL}${path}`;
}

function getAuthHeaders(): Record<string, string> {
  const { apiKey } = requireSmitheryConfig();
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

function getErrorText(status: number, text: string): string {
  if (!text) return `Smithery request failed with status ${status}`;

  try {
    const parsed: unknown = JSON.parse(text);
    const error = ErrorResponseSchema.safeParse(parsed);
    const message = error.success
      ? (error.data.message ?? error.data.error)
      : undefined;
    return message ?? text;
  } catch {
    return text;
  }
}

function toToolSummary(
  tool: z.infer<typeof SmitheryToolSchema>,
): SmitheryToolSummary {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    readOnly: tool.annotations?.readOnlyHint,
  };
}

function parseToolList(payload: unknown): SmitheryToolSummary[] {
  const directTools = ToolListEnvelopeSchema.safeParse(payload);
  if (directTools.success) {
    return directTools.data.tools.map(toToolSummary);
  }

  const byConnection = z.record(z.string(), z.unknown()).safeParse(payload);
  if (!byConnection.success) return [];

  return Object.values(byConnection.data).flatMap((value) => {
    const envelope = ToolListEnvelopeSchema.safeParse(value);
    return envelope.success ? envelope.data.tools.map(toToolSummary) : [];
  });
}

async function readJson<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new SmitheryApiError(response.status, getErrorText(response.status, text));
  }

  const parsed: unknown = text ? JSON.parse(text) : {};
  return schema.parse(parsed);
}

async function smitheryFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(getApiUrl(path), {
    ...init,
    headers: {
      ...getAuthHeaders(),
      ...init.headers,
    },
  });

  return readJson(response, schema);
}

async function saveSnapshot(
  serverId: SmitheryServerId,
  snapshot: SmitheryConnectionSnapshot,
): Promise<ISmitheryConnection> {
  return saveSmitheryConnection({
    serverId,
    connectionId: snapshot.connectionId,
    status: snapshot.status,
    setupUrl: snapshot.setupUrl,
    errorMessage: snapshot.errorMessage,
  });
}

function toSnapshot(
  connection: z.infer<typeof ConnectionSchema>,
): SmitheryConnectionSnapshot {
  const status = normalizeStatus(connection.status.state);
  return {
    connectionId: connection.connectionId,
    status,
    setupUrl: connection.status.setupUrl,
    errorMessage: connection.status.message ?? connection.status.error,
  };
}

export function isSmitheryConfigured(): boolean {
  return Boolean(env.SMITHERY_API_KEY && env.SMITHERY_NAMESPACE);
}

export function getSmitheryNamespaceMcpUrl(): string {
  const { namespace } = requireSmitheryConfig();
  const url = new URL(encodeURIComponent(namespace), `${SMITHERY_MCP_BASE_URL}/`);
  if (env.SMITHERY_MCP_MODE === "smart") {
    url.searchParams.set("mode", "smart");
  }
  return url.toString();
}

export function getSmitheryMcpMode(): "direct" | "smart" {
  return env.SMITHERY_MCP_MODE;
}

export async function createOrUpdateSmitheryConnection(
  serverId: SmitheryServerId,
): Promise<SmitheryConnectionSnapshot> {
  const { namespace } = requireSmitheryConfig();
  const server = SMITHERY_SERVERS[serverId];
  const connectionId = getConnectionId(serverId);

  const connection = await smitheryFetch(
    `/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connectionId)}`,
    ConnectionSchema,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transport: "http",
        mcpUrl: server.mcpUrl,
        name: server.name,
        metadata: {
          app: "ruyi-discord-bot",
          serverId,
        },
      }),
    },
  );
  const snapshot = toSnapshot(connection);
  await saveSnapshot(serverId, snapshot);
  return snapshot;
}

export async function refreshSmitheryConnection(
  serverId: SmitheryServerId,
): Promise<SmitheryConnectionSnapshot> {
  const { namespace } = requireSmitheryConfig();
  const connectionId = getConnectionId(serverId);
  const connection = await smitheryFetch(
    `/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connectionId)}`,
    ConnectionSchema,
  );
  const snapshot = toSnapshot(connection);
  await saveSnapshot(serverId, snapshot);
  return snapshot;
}

export async function refreshKnownSmitheryConnections(): Promise<void> {
  if (!isSmitheryConfigured()) return;

  const connections = await getAllSmitheryConnections();
  for (const connection of connections) {
    try {
      await refreshSmitheryConnection(connection.serverId);
    } catch (error) {
      mcpLogger.warn(
        {
          serverId: connection.serverId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to refresh Smithery connection status",
      );
    }
  }
}

export async function deleteSmitheryConnection(
  serverId: SmitheryServerId,
): Promise<boolean> {
  const { namespace } = requireSmitheryConfig();
  const connectionId = getConnectionId(serverId);

  try {
    const result = await smitheryFetch(
      `/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connectionId)}`,
      DeleteConnectionSchema,
      { method: "DELETE" },
    );
    return result.success;
  } catch (error) {
    if (error instanceof SmitheryApiError && error.status === 404) {
      return true;
    }
    throw error;
  }
}

export async function createSmitheryServiceToken(): Promise<string> {
  const { namespace } = requireSmitheryConfig();
  const token = await smitheryFetch("/tokens", ServiceTokenSchema, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      policy: [
        {
          namespaces: namespace,
          resources: "connections",
          operations: ["read", "execute"],
          ttl: "1h",
        },
      ],
    }),
  });

  const expiresAtMs = new Date(token.expiresAt).getTime();
  cachedServiceToken = {
    token: token.token,
    expiresAtMs,
  };

  return token.token;
}

export async function getSmitheryServiceToken(): Promise<string> {
  if (
    cachedServiceToken &&
    cachedServiceToken.expiresAtMs - SERVICE_TOKEN_REFRESH_BUFFER_MS > Date.now()
  ) {
    return cachedServiceToken.token;
  }

  return createSmitheryServiceToken();
}

export function clearSmitheryServiceTokenCache(): void {
  cachedServiceToken = null;
}

export async function listSmitheryConnectionTools(
  serverId: SmitheryServerId,
): Promise<SmitheryToolSummary[]> {
  const { namespace } = requireSmitheryConfig();
  const connectionId = getConnectionId(serverId);
  const payload = await smitheryFetch(
    `/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connectionId)}/.tools`,
    z.unknown(),
  );

  return parseToolList(payload);
}

export async function listSmitheryNamespaceTools(): Promise<
  SmitheryToolSummary[]
> {
  const { namespace } = requireSmitheryConfig();
  const payload = await smitheryFetch(
    `/connect/${encodeURIComponent(namespace)}/.tools`,
    z.unknown(),
  );

  return parseToolList(payload);
}
