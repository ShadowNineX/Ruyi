import type { SearchableMessage } from '../../src/utils/message-search';
import { describe, expect, test } from 'bun:test';
import {
  rankMessageMatches,

  summarizeMessageSearchMatches,
} from '../../src/utils/message-search';

function message(
  id: string,
  content: string,
  timestamp: string,
  author = 'Alex',
): SearchableMessage {
  return {
    id,
    author,
    content,
    timestamp: new Date(timestamp),
  };
}

describe('shared message search ranking', () => {
  test('prefers exact phrase matches over partial and fuzzy matches', () => {
    const matches = rankMessageMatches(
      [
        message(
          'partial',
          'blue fox memory but not the phrase',
          '2026-06-19T10:02:00Z',
        ),
        message(
          'exact',
          'please remember the blue fox quote',
          '2026-06-19T10:01:00Z',
        ),
      ],
      'blue fox quote',
      5,
    );

    expect(matches[0]?.item.id).toBe('exact');
    expect(matches[0]?.matchType).toBe('exact_phrase');
    expect(summarizeMessageSearchMatches(matches).exactPhraseFound).toBe(true);
  });

  test('uses Fuse matching for typo-heavy related wording', () => {
    const matches = rankMessageMatches(
      [
        message('misspelled', 'remembr blu quot later', '2026-06-19T10:01:00Z'),
        message('other', 'unrelated profile comment', '2026-06-19T10:02:00Z'),
      ],
      'remember blue quote',
      5,
    );

    expect(matches[0]?.item.id).toBe('misspelled');
    expect(matches[0]?.matchType).toBe('fuzzy');
    expect(matches[0]?.fuseScore).toBeNumber();
  });

  test('returns newest messages first when no query is supplied', () => {
    const matches = rankMessageMatches(
      [
        message('old', 'older message', '2026-06-19T10:01:00Z'),
        message('new', 'newer message', '2026-06-19T10:02:00Z'),
      ],
      null,
      5,
    );

    expect(matches.map(match => match.item.id)).toEqual(['new', 'old']);
    expect(matches.every(match => match.matchType === 'recent')).toBe(true);
  });

  test('keeps non-English letters searchable deterministically', () => {
    const matches = rankMessageMatches(
      [
        message(
          'swedish',
          'Jag gillar blå räv och Tails',
          '2026-06-19T10:01:00Z',
        ),
      ],
      'blå räv',
      5,
    );

    expect(matches[0]?.item.id).toBe('swedish');
    expect(matches[0]?.matchType).toBe('exact_phrase');
  });
});
