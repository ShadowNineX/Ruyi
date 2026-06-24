import type { SteamProfileComment } from '../../src/steam/client';
import { describe, expect, test } from 'bun:test';
import { buildSteamChatHistory } from '../../src/steam/service';

function comment(
  id: string,
  authorSteamId: string,
  authorName: string,
  text: string,
  date: string,
): SteamProfileComment {
  return {
    id,
    authorSteamId,
    authorName,
    date: new Date(date),
    text,
    html: '',
  };
}

describe('Steam chat history', () => {
  test('builds ordered context before the current comment', () => {
    const profileId = '76561198000000001';
    const history = buildSteamChatHistory(
      profileId,
      'Ruyi',
      [
        comment(
          'current',
          '76561198000000002',
          'Alex',
          'What did I ask before?',
          '2026-06-19T10:03:00Z',
        ),
        comment(
          'reply',
          profileId,
          'Ruyi',
          'Of course, your humble servant remembers.',
          '2026-06-19T10:02:00Z',
        ),
        comment(
          'first',
          '76561198000000002',
          'Alex',
          'Remember the blue fox quote.',
          '2026-06-19T10:01:00Z',
        ),
      ],
      'current',
    );

    expect(history).toEqual([
      {
        author: 'Alex',
        content: 'Remember the blue fox quote.',
        isBot: false,
      },
      {
        author: 'Ruyi',
        content: 'Of course, your humble servant remembers.',
        isBot: true,
      },
    ]);
  });

  test('does not duplicate the current comment in injected history', () => {
    const profileId = '76561198000000001';
    const history = buildSteamChatHistory(
      profileId,
      'Ruyi',
      [
        comment(
          'current',
          '76561198000000002',
          'Alex',
          'This is the current comment.',
          '2026-06-19T10:01:00Z',
        ),
      ],
      'current',
    );

    expect(history).toEqual([]);
  });

  test('labels active bot comments with the active Steam account personality', () => {
    const tailsProfileId = '76561198000000003';
    const history = buildSteamChatHistory(
      tailsProfileId,
      'Tails',
      [
        comment(
          'reply',
          tailsProfileId,
          'Tails',
          'We can figure this out step by step.',
          '2026-06-19T10:02:00Z',
        ),
        comment(
          'current',
          '76561198000000002',
          'Alex',
          'Hello :D',
          '2026-06-19T10:03:00Z',
        ),
      ],
      'current',
    );

    expect(history).toEqual([
      {
        author: 'Tails',
        content: 'We can figure this out step by step.',
        isBot: true,
      },
    ]);
  });
});
