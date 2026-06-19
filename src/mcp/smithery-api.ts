import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@smithery/api/resources/connections/connections';
import type { ISmitheryConnection, SmitheryConnectionScope, SmitheryConnectionStatus, SmitheryServerId } from '../db/models';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import Smithery from '@smithery/api';
import { createConnection, SmitheryAuthorizationError } from '@smithery/api/mcp';
import {
  getAllSmitheryConnections,
  getSmitheryConnection,

  saveSmitheryConnection,

} from '../db/models';
import { env } from '../env';
import { mcpLogger } from '../logger';
import { getSmitheryConnectionId } from '../utils/smithery-connection-id';
import { SMITHERY_SERVERS } from './smithery-catalog';

const SMITHERY_MCP_BASE_URL = 'https://mcp.smithery.run';
const MCP_CLIENT_INFO = {
  name: 'ruyi-discord-bot',
  version: '1.0.0',
} as const;
const SMITHERY_APP_METADATA = {
  app: 'ruyi-discord-bot',
} as const;

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
  destructive?: boolean;
  inputSchema?: unknown;
}

export interface SmitheryToolCallResult {
  connectionId: string;
  toolName: string;
  result: unknown;
}

function requireSmitheryConfig(): {
  apiKey: string;
  namespace: string;
} {
  if (!env.SMITHERY_API_KEY || !env.SMITHERY_NAMESPACE) {
    throw new Error(
      'Smithery Connect is not configured. Set SMITHERY_API_KEY and SMITHERY_NAMESPACE.',
    );
  }

  return {
    apiKey: env.SMITHERY_API_KEY,
    namespace: env.SMITHERY_NAMESPACE,
  };
}

function getSmitheryClient(): Smithery {
  const { apiKey } = requireSmitheryConfig();
  return new Smithery({ apiKey });
}

function normalizeStatus(
  state: Connection['status'] extends { state: infer T } ? T : string,
): SmitheryConnectionStatus {
  switch (state) {
    case 'connected':
    case 'auth_required':
    case 'input_required':
    case 'disconnected':
    case 'error':
      return state;
    default:
      return 'unknown';
  }
}

function getConnectionMetadata(
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
): Record<string, string> {
  return {
    ...SMITHERY_APP_METADATA,
    scopeKind: scope.kind,
    scopeId: scope.id,
    serverId,
  };
}

function getErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('status' in error)) { return undefined; }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function getStatusSetupUrl(status: Connection['status'] | undefined): string | undefined {
  if (!status) { return undefined; }
  if (status.state === 'auth_required') {
    return status.setupUrl;
  }
  if (status.state === 'input_required') {
    return status.setupUrl;
  }
  return undefined;
}

function getStatusErrorMessage(
  status: Connection['status'] | undefined,
): string | undefined {
  return status?.state === 'error' ? status.message : undefined;
}

function toSnapshot(connection: Connection): SmitheryConnectionSnapshot {
  return {
    connectionId: connection.connectionId,
    status: normalizeStatus(connection.status?.state ?? 'unknown'),
    setupUrl: getStatusSetupUrl(connection.status),
    errorMessage: getStatusErrorMessage(connection.status),
  };
}

function toToolSummary(tool: McpTool): SmitheryToolSummary {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    readOnly: tool.annotations?.readOnlyHint,
    destructive: tool.annotations?.destructiveHint,
    inputSchema: tool.inputSchema,
  };
}

async function saveSnapshot(
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
  snapshot: SmitheryConnectionSnapshot,
): Promise<ISmitheryConnection> {
  return saveSmitheryConnection({
    scope,
    serverId,
    connectionId: snapshot.connectionId,
    status: snapshot.status,
    setupUrl: snapshot.setupUrl,
    errorMessage: snapshot.errorMessage,
  });
}

async function withSmitheryMcpClient<T>(
  connectionId: string,
  callback: (client: McpClient) => Promise<T>,
): Promise<T> {
  const { namespace } = requireSmitheryConfig();
  const smithery = getSmitheryClient();
  const { transport } = await createConnection({
    client: smithery,
    namespace,
    connectionId,
  });
  const client = new McpClient(MCP_CLIENT_INFO, { capabilities: {} });

  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close().catch((error: unknown) => {
      mcpLogger.debug(
        {
          connectionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to close Smithery MCP client',
      );
    });
  }
}

async function requireConnectedSmitheryConnection(
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
): Promise<ISmitheryConnection> {
  const connection = await getSmitheryConnection(scope, serverId);
  if (!connection) {
    throw new Error(`${SMITHERY_SERVERS[serverId].name} is not linked. Run /smithery first.`);
  }
  if (connection.status !== 'connected') {
    throw new Error(
      `${SMITHERY_SERVERS[serverId].name} is not ready. Current Smithery status: ${connection.status}.`,
    );
  }
  return connection;
}

export function isSmitheryConfigured(): boolean {
  return Boolean(env.SMITHERY_API_KEY && env.SMITHERY_NAMESPACE);
}

export function getSmitheryNamespaceMcpUrl(): string {
  const { namespace } = requireSmitheryConfig();
  return new URL(
    encodeURIComponent(namespace),
    `${SMITHERY_MCP_BASE_URL}/`,
  ).toString();
}

export async function createOrUpdateSmitheryConnection(
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
): Promise<SmitheryConnectionSnapshot> {
  const { namespace } = requireSmitheryConfig();
  const server = SMITHERY_SERVERS[serverId];
  const client = getSmitheryClient();

  const connection = await client.connections.set(
    getSmitheryConnectionId(scope, serverId),
    {
      namespace,
      transport: 'http',
      mcpUrl: server.mcpUrl,
      name: server.name,
      metadata: getConnectionMetadata(scope, serverId),
    },
  );

  const snapshot = toSnapshot(connection);
  await saveSnapshot(scope, serverId, snapshot);
  return snapshot;
}

export async function refreshSmitheryConnection(
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
): Promise<SmitheryConnectionSnapshot> {
  const { namespace } = requireSmitheryConfig();
  const client = getSmitheryClient();
  const connection = await client.connections.get(
    getSmitheryConnectionId(scope, serverId),
    { namespace },
  );
  const snapshot = toSnapshot(connection);
  await saveSnapshot(scope, serverId, snapshot);
  return snapshot;
}

export async function refreshKnownSmitheryConnections(
  scope?: SmitheryConnectionScope,
): Promise<void> {
  if (!isSmitheryConfigured()) { return; }

  const connections = await getAllSmitheryConnections(scope);
  for (const connection of connections) {
    try {
      await refreshSmitheryConnection(
        { kind: connection.scopeKind, id: connection.scopeId },
        connection.serverId,
      );
    } catch (error) {
      mcpLogger.warn(
        {
          scopeKind: connection.scopeKind,
          scopeId: connection.scopeId,
          serverId: connection.serverId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh Smithery connection status',
      );
    }
  }
}

export async function deleteSmitheryConnection(
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
): Promise<boolean> {
  const { namespace } = requireSmitheryConfig();
  const client = getSmitheryClient();

  try {
    const result = await client.connections.delete(
      getSmitheryConnectionId(scope, serverId),
      { namespace },
    );
    return result.success;
  } catch (error) {
    if (getErrorStatus(error) === 404) { return true; }
    throw error;
  }
}

export async function listSmitheryConnectionTools(
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
): Promise<SmitheryToolSummary[]> {
  const connection = await requireConnectedSmitheryConnection(scope, serverId);
  const result = await withSmitheryMcpClient(connection.connectionId, client =>
    client.listTools());
  return result.tools.map(toToolSummary);
}

export async function callSmitheryConnectionTool(
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
  toolName: string,
  args: Record<string, unknown>,
): Promise<SmitheryToolCallResult> {
  const connection = await requireConnectedSmitheryConnection(scope, serverId);

  try {
    const result = await withSmitheryMcpClient(connection.connectionId, client =>
      client.callTool({ name: toolName, arguments: args }));
    return {
      connectionId: connection.connectionId,
      toolName,
      result,
    };
  } catch (error) {
    if (error instanceof SmitheryAuthorizationError) {
      await saveSnapshot(scope, serverId, {
        connectionId: error.connectionId,
        status: 'auth_required',
        setupUrl: error.authorizationUrl,
        errorMessage: error.message,
      });
    }
    throw error;
  }
}
