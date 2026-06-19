import { describe, expect, test } from 'bun:test';
import {
  getSmitheryConnectionId,
  isValidSmitheryConnectionId,
} from '../../src/utils/smithery-connection-id';

describe('Smithery connection IDs', () => {
  test('uses only Smithery-safe characters for Discord guild scopes', () => {
    const connectionId = getSmitheryConnectionId(
      { kind: 'discord:guild', id: '1475985846371881064' },
      'youtube',
    );

    expect(connectionId).toBe('youtube-discord-guild-1475985846371881064');
    expect(isValidSmitheryConnectionId(connectionId)).toBe(true);
    expect(
      isValidSmitheryConnectionId('youtube-discord:guild-1475985846371881064'),
    ).toBe(false);
  });

  test('uses only Smithery-safe characters for Discord DM scopes', () => {
    const connectionId = getSmitheryConnectionId(
      { kind: 'discord:dm', id: '1239152319048978494' },
      'youtube',
    );

    expect(connectionId).toBe('youtube-discord-dm-1239152319048978494');
    expect(isValidSmitheryConnectionId(connectionId)).toBe(true);
  });

  test('rejects generated IDs longer than Smithery accepts', () => {
    expect(() =>
      getSmitheryConnectionId(
        { kind: 'discord:guild', id: '1'.repeat(260) },
        'youtube',
      ),
    ).toThrow('Generated Smithery connection ID is invalid or too long');
  });
});
