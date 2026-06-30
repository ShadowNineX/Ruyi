import { describe, expect, test } from 'bun:test';
import {
  MEMORY_KEY_MAX_LEN,
  sanitizeMemoryKey,
  truncateMemoryValue,
} from '../../src/utils/memory-normalization';
import {
  buildUserMemoryFilter,
  formatUserMemoryContext,
} from '../../src/utils/memory-scope';

describe('memory key and value normalization', () => {
  test('normalizes memory keys into compact snake-case', () => {
    expect(sanitizeMemoryKey('  Alex / Tails!!! ')).toBe('alex_tails');
    expect(sanitizeMemoryKey('__Already__Clean__')).toBe('already__clean');
  });

  test('removes keys that contain no alphanumeric content', () => {
    expect(sanitizeMemoryKey('___---___')).toBe('');
  });

  test('caps memory keys', () => {
    expect(sanitizeMemoryKey('a'.repeat(MEMORY_KEY_MAX_LEN + 20))).toHaveLength(
      MEMORY_KEY_MAX_LEN,
    );
  });

  test('truncates long memory values with an ellipsis', () => {
    expect(truncateMemoryValue('abcdef', 5)).toBe('ab...');
    expect(truncateMemoryValue('abc', 5)).toBe('abc');
  });
});

describe('memory scope helpers', () => {
  test('builds person-scoped user memory filters', () => {
    expect(buildUserMemoryFilter({ personId: 'owner' })).toEqual({
      scope: 'user',
      personId: 'owner',
    });
  });

  test('describes owner memory context separately from Discord users', () => {
    expect(
      formatUserMemoryContext({
        username: 'Shadow',
        personId: 'owner',
      }),
    ).toBe('Shadow');

    expect(
      formatUserMemoryContext({
        username: 'Guest',
        personId: 'discord:123',
      }),
    ).toBe('Guest on Discord');
  });
});
