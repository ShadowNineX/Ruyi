import type { RuyiUserIdentity } from './user-identity';

export interface UserMemoryFilter {
  scope: 'user';
  personId: string;
}

export function buildUserMemoryFilter(
  identity: Pick<RuyiUserIdentity, 'personId'>,
): UserMemoryFilter {
  return {
    scope: 'user',
    personId: identity.personId,
  };
}

export function formatUserMemoryContext(
  identity: Pick<RuyiUserIdentity, 'surface' | 'username' | 'personId'>,
): string {
  return identity.personId === 'owner'
    ? `${identity.username} across linked Discord and Steam identities`
    : `${identity.username} on ${identity.surface}`;
}
