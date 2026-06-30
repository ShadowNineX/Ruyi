import { describe, expect, test } from 'bun:test';
import {
  configScopeKey,
  formatConfigScope,
  guildConfigScope,
  isAiModelPresetId,
  userConfigScope,
} from '../../src/config';

describe('config scopes', () => {
  test('formats Discord guild and DM scope keys', () => {
    expect(configScopeKey(guildConfigScope('guild-1'))).toBe(
      'discord:guild:guild-1',
    );
    expect(configScopeKey(userConfigScope(null, 'user-1'))).toBe(
      'discord:dm:user-1',
    );
  });

  test('prefers guild scope when a guild id is present', () => {
    expect(userConfigScope('guild-1', 'user-1')).toEqual({
      kind: 'discord:guild',
      id: 'guild-1',
    });
  });

  test('formats Discord scope labels', () => {
    expect(formatConfigScope(guildConfigScope('guild-1'))).toBe('this server');
    expect(formatConfigScope(userConfigScope(null, 'user-1'))).toBe(
      'this private chat',
    );
  });
});

describe('AI model preset validation', () => {
  test('accepts known preset ids and rejects unknown ids', () => {
    expect(isAiModelPresetId('balanced')).toBe(true);
    expect(isAiModelPresetId('deep')).toBe(true);
    expect(isAiModelPresetId('gpt-5.5')).toBe(false);
  });
});
