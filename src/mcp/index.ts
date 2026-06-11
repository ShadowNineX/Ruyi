import {
  getAllSmitheryConnections,
  type SmitheryServerId,
} from "../db/models";
import { mcpLogger } from "../logger";
import { SMITHERY_SERVERS } from "./smithery-catalog";
import {
  isSmitheryConfigured,
  refreshKnownSmitheryConnections,
} from "./smithery-api";

function getConnectionName(serverId: SmitheryServerId): string {
  return SMITHERY_SERVERS[serverId]?.name ?? serverId;
}

export class MCPRegistry {
  getServerForTool(toolName: string): string | undefined {
    const [connectionId] = toolName.split(".");
    if (connectionId && connectionId in SMITHERY_SERVERS) {
      return getConnectionName(connectionId as SmitheryServerId);
    }

    return toolName.startsWith("smithery") ? "Smithery" : undefined;
  }

  async logHealth(): Promise<void> {
    if (!isSmitheryConfigured()) {
      mcpLogger.warn(
        "Smithery Connect disabled. Set SMITHERY_API_KEY and SMITHERY_NAMESPACE to enable MCP tools.",
      );
      return;
    }

    await refreshKnownSmitheryConnections();
    const connections = await getAllSmitheryConnections();
    const connectedCount = connections.filter(
      (connection) => connection.status === "connected",
    ).length;

    for (const connection of connections) {
      const serverName = getConnectionName(connection.serverId);
      mcpLogger.info(
        {
          serverId: connection.serverId,
          connectionId: connection.connectionId,
          status: connection.status,
          hasSetupUrl: Boolean(connection.setupUrl),
          error: connection.errorMessage,
        },
        `${serverName} Smithery connection status`,
      );
    }

    mcpLogger.info(
      {
        configured: true,
        connected: connectedCount,
        total: connections.length,
      },
      "Smithery Connect health check complete",
    );
  }
}

export const mcpRegistry = new MCPRegistry();
