import type {
  SmitheryConnectionScope,
  SmitheryServerId,
} from '../db/models';

const SMITHERY_CONNECTION_ID_PATTERN = /^[\w-]{1,255}$/;

function toConnectionIdPart(value: string): string {
  return value.replaceAll(/[^\w-]+/g, '-');
}

export function isValidSmitheryConnectionId(value: unknown): value is string {
  return (
    typeof value === 'string'
    && SMITHERY_CONNECTION_ID_PATTERN.test(value)
  );
}

export function getSmitheryConnectionId(
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
): string {
  const connectionId = [
    serverId,
    toConnectionIdPart(scope.kind),
    toConnectionIdPart(scope.id),
  ].join('-');

  if (!isValidSmitheryConnectionId(connectionId)) {
    throw new Error(
      `Generated Smithery connection ID is invalid or too long: ${connectionId}`,
    );
  }

  return connectionId;
}
