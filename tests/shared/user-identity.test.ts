import { describe, expect, test } from 'bun:test';
import { buildDiscordUserIdentity } from '../../src/utils/user-identity';

describe('Discord user identity', () => {
  test('maps configured Discord owner id to the owner person', () => {
    expect(buildDiscordUserIdentity('discord-owner', 'Shadow')).toMatchObject({
      surfaceUserId: 'discord-owner',
      username: 'Shadow',
      personId: 'owner',
      canWriteMemory: true,
    });
  });

  test('keeps non-owner Discord users isolated', () => {
    expect(buildDiscordUserIdentity('123', 'Guest')).toMatchObject({
      surfaceUserId: '123',
      username: 'Guest',
      personId: 'discord:123',
      canWriteMemory: true,
    });
  });
});
