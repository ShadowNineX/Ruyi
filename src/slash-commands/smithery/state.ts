import { getAllSmitheryTokens, type SmitheryServerId } from "../../db/models";
import { SMITHERY_SERVER_IDS } from "./constants";
import type { SmitheryOAuthProvider } from "./oauth-provider";

export interface PendingSmitheryFlow {
  provider: SmitheryOAuthProvider;
  serverUrl: string;
  serverId: SmitheryServerId;
  authUrl?: URL;
}

export interface SmitheryLinkState {
  linkedServerIds: SmitheryServerId[];
  unlinkedServerIds: SmitheryServerId[];
}

export const pendingSmitheryFlows = new Map<string, PendingSmitheryFlow>();

export async function getSmitheryLinkState(): Promise<SmitheryLinkState> {
  const linkedTokens = await getAllSmitheryTokens();
  const linkedSet = new Set(linkedTokens.map((token) => token.serverId));

  const linkedServerIds = SMITHERY_SERVER_IDS.filter((serverId) =>
    linkedSet.has(serverId),
  );
  const unlinkedServerIds = SMITHERY_SERVER_IDS.filter(
    (serverId) => !linkedSet.has(serverId),
  );

  return { linkedServerIds, unlinkedServerIds };
}
