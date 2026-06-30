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

  test('builds agent session ids', () => {
    expect(
      buildAgentSessionId({
        conversationId: 'channel-1',
        label: 'ruyi',
        timestamp: 1782265954498,
      }),
    ).toBe('ruyi-channel-1-1782265954498');
  });
});
