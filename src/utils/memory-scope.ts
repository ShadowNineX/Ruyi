import type { ConfigScope } from "../config";

export interface UserMemoryFilter {
  scope: "user";
  scopeKind: ConfigScope["kind"];
  scopeId: string;
  userId: string;
}

export function buildUserMemoryFilter(
  userId: string,
  scope: ConfigScope,
): UserMemoryFilter {
  return {
    scope: "user",
    scopeKind: scope.kind,
    scopeId: scope.id,
    userId,
  };
}

export function formatUserMemoryContext(
  username: string,
  scope: ConfigScope,
  guildName?: string | null,
): string {
  if (scope.kind === "guild") {
    return guildName
      ? `${username} in server ${guildName}`
      : `${username} in this server`;
  }

  return `${username} in this private chat`;
}
