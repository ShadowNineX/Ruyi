import { env } from '../env';

export interface RuyiUserIdentity {
  surfaceUserId: string;
  username: string;
  personId: string;
  canWriteMemory: boolean;
}

const OWNER_PERSON_ID = 'owner';

export function buildDiscordUserIdentity(
  userId: string,
  username: string,
): RuyiUserIdentity {
  const isOwner = env.OWNER_DISCORD_USER_ID === userId;
  return {
    surfaceUserId: userId,
    username,
    personId: isOwner ? OWNER_PERSON_ID : `discord:${userId}`,
    canWriteMemory: true,
  };
}
