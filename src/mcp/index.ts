import {
  getAllSmitheryConnections,
  type SmitheryServerId,
} from "../db/models";
import { mcpLogger } from "../logger";
import { SMITHERY_SERVERS } from "./smithery-catalog";
import {
  getSmitheryNamespaceMcpUrl,
  isSmitheryConfigured,
  listSmitheryConnectionTools,
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

    const [sanitizedConnectionId] = toolName.split("_");
    if (sanitizedConnectionId && sanitizedConnectionId in SMITHERY_SERVERS) {
      return getConnectionName(sanitizedConnectionId as SmitheryServerId);
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
      const tools =
        connection.status === "connected"
          ? await this.getConnectionToolNames(connection.serverId)
          : [];
      mcpLogger.info(
        {
          serverId: connection.serverId,
          connectionId: connection.connectionId,
          status: connection.status,
          toolCount: tools.length,
          toolSample: tools.slice(0, 8),
          hasSetupUrl: Boolean(connection.setupUrl),
          error: connection.errorMessage,
        },
        `${serverName} Smithery connection status`,
      );
    }

    mcpLogger.info(
      {
        configured: true,
        namespaceUrl: getSmitheryNamespaceMcpUrl(),
        connected: connectedCount,
        total: connections.length,
      },
      "Smithery Connect health check complete",
    );
  }

  private async getConnectionToolNames(
    serverId: SmitheryServerId,
  ): Promise<string[]> {
    try {
      const tools = await listSmitheryConnectionTools(serverId);
      return tools.map((tool) => tool.name);
    } catch (error) {
      mcpLogger.warn(
        {
          serverId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to list Smithery connection tools",
      );
      return [];
    }
  }
}

export const mcpRegistry = new MCPRegistry();
