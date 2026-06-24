import { describe, expect, test } from 'bun:test';
import {
  buildAgentSessionId,
  normalizeSessionLabel,
} from '../../src/utils/session-label';

describe('agent session labels', () => {
  test('normalizes labels without regex trimming', () => {
    expect(normalizeSessionLabel('Tails')).toBe('tails');
    expect(normalizeSessionLabel(' Real Miles Prower! ')).toBe('real-miles-prower');
    expect(normalizeSessionLabel('---')).toBe('assistant');
  });

  test('builds account-visible agent session ids', () => {
    expect(
      buildAgentSessionId({
        conversationId: '76561198716653765',
        label: 'tails',
        surface: 'steam',
        timestamp: 1782265954498,
      }),
    ).toBe('tails-steam-76561198716653765-1782265954498');
  });
});
