import {
  getAllSmitheryConnections,
  type SmitheryServerId,
} from "../../db/models";
import { refreshKnownSmitheryConnections } from "../../mcp/smithery-api";
import { SMITHERY_SERVER_IDS } from "./constants";

export interface SmitheryLinkState {
  linkedServerIds: SmitheryServerId[];
  needsSetupServerIds: SmitheryServerId[];
  unlinkedServerIds: SmitheryServerId[];
}

export async function getSmitheryLinkState(): Promise<SmitheryLinkState> {
  await refreshKnownSmitheryConnections();

  const connections = await getAllSmitheryConnections();
  const linkedSet = new Set(
    connections
      .filter((connection) => connection.status === "connected")
      .map((connection) => connection.serverId),
  );
  const setupSet = new Set(
    connections
      .filter((connection) => connection.status !== "connected")
      .map((connection) => connection.serverId),
  );

  const linkedServerIds = SMITHERY_SERVER_IDS.filter((serverId) =>
    linkedSet.has(serverId),
  );
  const needsSetupServerIds = SMITHERY_SERVER_IDS.filter((serverId) =>
    setupSet.has(serverId),
  );
  const unlinkedServerIds = SMITHERY_SERVER_IDS.filter(
    (serverId) => !linkedSet.has(serverId) && !setupSet.has(serverId),
  );

  return { linkedServerIds, needsSetupServerIds, unlinkedServerIds };
}
