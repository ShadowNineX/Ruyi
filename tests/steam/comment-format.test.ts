import { describe, expect, test } from 'bun:test';
import { STEAM_PROFILE_COMMENT_MAX_LENGTH } from '../../src/constants';
import { normalizeSteamProfileComment } from '../../src/steam/comment-format';

describe('Steam profile comment formatting', () => {
  test('trims surrounding whitespace', () => {
    expect(normalizeSteamProfileComment('  hello from Ruyi  ')).toEqual({
      comment: 'hello from Ruyi',
      truncated: false,
      removedUnsupportedFormatting: false,
      convertedAlignmentSpaces: false,
    });
  });

  test('keeps the small supported Steam BBCode allowlist intact', () => {
    expect(
      normalizeSteamProfileComment(
        '[h2]Title[/h2]\n[h3]Sub[/h3]\n[b]bold[/b] [u]under[/u] [i]italic[/i] [strike]strike[/strike] [spoiler]spoiler[/spoiler]\n[hr][/hr]\n[p]paragraph[/p]\n[pullquote]pullquote[/pullquote]\n[url=https://example.com]link[/url]',
      ),
    ).toEqual({
      comment:
        '[h2]Title[/h2]\n[h3]Sub[/h3]\n[b]bold[/b] [u]under[/u] [i]italic[/i] [strike]strike[/strike] [spoiler]spoiler[/spoiler]\n[hr][/hr]\n[p]paragraph[/p]\n[pullquote]pullquote[/pullquote]\n[url=https://example.com]link[/url]',
      truncated: false,
      removedUnsupportedFormatting: false,
      convertedAlignmentSpaces: false,
    });
  });

  test('keeps Yi quotes plain instead of inventing BBCode', () => {
    expect(
      normalizeSteamProfileComment(
        'May fortune favor you, Lord Yi. Your humble servant remains by your side.',
      ),
    ).toEqual({
      comment:
        'May fortune favor you, Lord Yi. Your humble servant remains by your side.',
      truncated: false,
      removedUnsupportedFormatting: false,
      convertedAlignmentSpaces: false,
    });
  });

  test('strips Discord markdown before posting to Steam', () => {
    expect(
      normalizeSteamProfileComment(
        '# Title\n**bold** and `code` with ||spoiler||\n```ts\nconst x = 1;\n```',
      ),
    ).toEqual({
      comment: 'Title\nbold and code with spoiler\nconst x = 1;',
      truncated: false,
      removedUnsupportedFormatting: false,
      convertedAlignmentSpaces: false,
    });
  });

  test('removes unsupported Steam tags while preserving readable text', () => {
    expect(
      normalizeSteamProfileComment(
        '[h1]Title[/h1]\n[quote=Yi]Quoted[/quote]\n[code]fixed[/code]\n[table][tr][td]cell[/td][/tr][/table]\n[img]https://example.com/image.png[/img]',
      ),
    ).toEqual({
      comment: 'Title\nQuoted\nfixed\ncell\nhttps://example.com/image.png',
      truncated: false,
      removedUnsupportedFormatting: true,
      convertedAlignmentSpaces: false,
    });
  });

  test('degrades unsupported Steam list tags to plain readable bullets', () => {
    expect(
      normalizeSteamProfileComment('[list][*]one[*]two[/list]\n[olist][*]first[/olist]'),
    ).toEqual({
      comment: '- one\n- two\n- first',
      truncated: false,
      removedUnsupportedFormatting: true,
      convertedAlignmentSpaces: false,
    });
  });

  test('strips noparse wrappers so visible BBCode tags are not posted', () => {
    expect(normalizeSteamProfileComment('[noparse][b]safe[/b][/noparse]')).toEqual({
      comment: '[b]safe[/b]',
      truncated: false,
      removedUnsupportedFormatting: true,
      convertedAlignmentSpaces: false,
    });
  });

  test('removes unsupported Steam media preview wrappers', () => {
    expect(
      normalizeSteamProfileComment(
        '[previewimg]https://example.com/a.png[/previewimg]\n[previewicon]https://example.com/b.png[/previewicon]\n[video]https://youtu.be/test[/video]\n[previewyoutube=abc][/previewyoutube]\n[screenshot]123[/screenshot]',
      ),
    ).toEqual({
      comment:
        'https://example.com/a.png\nhttps://example.com/b.png\nhttps://youtu.be/test\n\n123',
      truncated: false,
      removedUnsupportedFormatting: true,
      convertedAlignmentSpaces: false,
    });
  });

  test('keeps literal bracketed text that is not a BBCode pair', () => {
    expect(normalizeSteamProfileComment('[Tails] is a sweet tag')).toEqual({
      comment: '[Tails] is a sweet tag',
      truncated: false,
      removedUnsupportedFormatting: false,
      convertedAlignmentSpaces: false,
    });
  });

  test('protects ASCII-art and alignment spaces for Steam comments', () => {
    const result = normalizeSteamProfileComment('  /\\_/\\\\\nA  B');

    expect(result).toEqual({
      comment: '\u00A0\u00A0/\\_/\\\\\nA\u00A0\u00A0B',
      truncated: false,
      removedUnsupportedFormatting: false,
      convertedAlignmentSpaces: true,
    });
  });

  test('truncates overlong comments to Steam\'s configured limit', () => {
    const result = normalizeSteamProfileComment(
      'x'.repeat(STEAM_PROFILE_COMMENT_MAX_LENGTH + 50),
    );

    expect(result.truncated).toBe(true);
    expect(result.comment).toHaveLength(STEAM_PROFILE_COMMENT_MAX_LENGTH);
    expect(result.comment.endsWith('...')).toBe(true);
  });
});
