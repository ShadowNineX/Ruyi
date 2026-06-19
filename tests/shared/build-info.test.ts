import { describe, expect, test } from 'bun:test';
import { formatShortCommit, getBuildInfo } from '../../src/build-info';

describe('build info', () => {
  test('uses development metadata when compile-time values are absent', () => {
    expect(getBuildInfo()).toEqual({
      commit: 'development',
      shortCommit: 'development',
      buildTime: null,
      bundled: false,
    });
  });

  test('formats Git commit hashes for compact display', () => {
    expect(formatShortCommit('0123456789abcdef')).toBe('0123456789ab');
    expect(formatShortCommit('unknown')).toBe('unknown');
  });
});
