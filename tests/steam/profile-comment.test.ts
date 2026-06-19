import type { SteamProfileComment } from '../../src/steam/client';
import type { ToolContext } from '../../src/utils/types';
import { beforeAll, describe, expect, mock, test } from 'bun:test';

Bun.env.DISCORD_TOKEN ??= 'test-discord-token';
Bun.env.OPENAI_API_KEY ??= 'sk-test-openai-key';
Bun.env.STEAM_REFRESH_TOKEN ??= 'test-refresh-token';
Bun.env.STEAM_BOT_STEAM_ID64 ??= '76561198000000002';
Bun.env.STEAM_OWNER_STEAM_ID64 ??= '76561198000000001';
Bun.env.OWNER_DISCORD_USER_ID ??= '123456789012345678';

function requireTestEnv(name: 'STEAM_BOT_STEAM_ID64' | 'STEAM_OWNER_STEAM_ID64'): string {
  const value = Bun.env[name];
  if (!value) { throw new Error(`${name} is required for Steam tests`); }
  return value;
}

const TEST_STEAM_BOT_STEAM_ID64 = requireTestEnv('STEAM_BOT_STEAM_ID64');
const TEST_STEAM_OWNER_STEAM_ID64 = requireTestEnv('STEAM_OWNER_STEAM_ID64');

let mockProfileComments: SteamProfileComment[] = [];
let mockDeletedProfileComments: Array<{
  commentId: string;
  profileId: string;
}> = [];
let mockOwnedGamesError: Error | null = null;
const mockSteamProfileCalls = {
  equippedItems: 0,
  inventoryContexts: 0,
  inventoryItems: 0,
  ownedGames: 0,
  profile: 0,
};

function resetSteamProfileCalls(): void {
  mockSteamProfileCalls.equippedItems = 0;
  mockSteamProfileCalls.inventoryContexts = 0;
  mockSteamProfileCalls.inventoryItems = 0;
  mockSteamProfileCalls.ownedGames = 0;
  mockSteamProfileCalls.profile = 0;
}

mock.module('../../src/steam/client', () => ({
  normalizeSteamProfileLookup: (value: string) => {
    const trimmed = value.trim();
    try {
      const url = new URL(trimmed);
      const [kind, identifier] = url.pathname.split('/').filter(Boolean);
      return kind === 'profiles' || kind === 'id'
        ? decodeURIComponent(identifier ?? trimmed)
        : trimmed;
    } catch {
      return trimmed;
    }
  },
  steamCommunityClient: {
    getEquippedProfileItems: async () => {
      mockSteamProfileCalls.equippedItems += 1;
      return {
        animatedAvatar: null,
        avatarFrame: {
          appId: 753,
          communityItemId: 11,
          description: 'A warm frame',
          imageLarge: 'https://steam.example/frame-large.png',
          imageSmall: 'https://steam.example/frame-small.png',
          itemClass: null,
          movieMp4: null,
          movieWebm: null,
          name: 'Fox Frame',
          title: 'Fox Frame',
          type: 'Avatar Frame',
        },
        limitations: [],
        miniProfileBackground: null,
        profileBackground: null,
        profileModifier: null,
      };
    },
    getInventoryContexts: async () => {
      mockSteamProfileCalls.inventoryContexts += 1;
      return [
        {
          appId: 753,
          assetCount: 2,
          contexts: [{ assetCount: 2, id: '6', name: 'Community' }],
          iconUrl: null,
          inventoryUrl: 'https://steamcommunity.com/profiles/owner/inventory/#753',
          name: 'Steam',
        },
      ];
    },
    getInventoryItems: async () => {
      mockSteamProfileCalls.inventoryItems += 1;
      return {
        appId: 753,
        contextId: '6',
        currencyCount: 0,
        items: [
          {
            amount: 1,
            appId: 753,
            classId: 'class-1',
            contextId: '6',
            id: 'asset-1',
            imageUrl: 'https://steam.example/item.png',
            instanceId: '0',
            largeImageUrl: 'https://steam.example/item-large.png',
            marketHashName: 'Fox Card',
            marketable: true,
            name: 'Fox Card',
            tags: [],
            tradable: true,
            type: 'Trading Card',
          },
        ],
        limitations: [],
        returnedCount: 1,
        totalCount: 1,
        tradableOnly: false,
      };
    },
    getOwnedGames: async () => {
      mockSteamProfileCalls.ownedGames += 1;
      if (mockOwnedGamesError) { throw mockOwnedGamesError; }
      return {
        appCount: 3,
        games: [
          {
            appId: 620,
            hasCommunityVisibleStats: true,
            iconUrl: 'https://steam.example/portal2-icon.jpg',
            logoUrl: null,
            name: 'Portal 2',
            playtimeForeverMinutes: 500,
            playtimeLinuxForeverMinutes: 0,
            playtimeMacForeverMinutes: 0,
            playtimeRecentMinutes: 80,
            playtimeWindowsForeverMinutes: 500,
          },
          {
            appId: 4000,
            hasCommunityVisibleStats: false,
            iconUrl: null,
            logoUrl: null,
            name: 'Garry\'s Mod',
            playtimeForeverMinutes: 1200,
            playtimeLinuxForeverMinutes: 0,
            playtimeMacForeverMinutes: 0,
            playtimeRecentMinutes: null,
            playtimeWindowsForeverMinutes: 1200,
          },
        ],
        limitations: ['Returned 2 of 3 visible games.'],
        recentGames: [
          {
            appId: 620,
            hasCommunityVisibleStats: true,
            iconUrl: 'https://steam.example/portal2-icon.jpg',
            logoUrl: null,
            name: 'Portal 2',
            playtimeForeverMinutes: 500,
            playtimeLinuxForeverMinutes: 0,
            playtimeMacForeverMinutes: 0,
            playtimeRecentMinutes: 80,
            playtimeWindowsForeverMinutes: 500,
          },
        ],
        returnedCount: 2,
        sort: 'recent',
      };
    },
    getPublicProfileSummary: async (lookup: string) => {
      mockSteamProfileCalls.profile += 1;
      return {
        avatarUrl: 'https://steam.example/avatar.jpg',
        backgroundUrl: 'https://steam.example/background.jpg',
        groupSteamId64s: [],
        isPublic: true,
        limited: false,
        limitations: [],
        location: 'Sweden',
        memberSince: '2024-05-12T00:00:00.000Z',
        name: lookup === '76561198000009999' ? 'Commenter' : 'Shadow',
        onlineState: 'online',
        persona: { gameName: 'Portal 2', gamePlayedAppId: 620 },
        primaryGroupSteamId64: null,
        privacyState: 'public',
        profileUrl: `https://steamcommunity.com/profiles/${lookup}`,
        realName: 'Alex',
        stateMessage: 'Online',
        steamId64: lookup,
        summary: 'Public profile summary',
        tradeBanState: 'None',
        vacBanned: false,
        vanityUrl: 'https://steamcommunity.com/id/ShadowNineX',
        visibilityState: 3,
      };
    },
    getProfileComments: async (_profileId: string, limit: number) =>
      mockProfileComments.slice(0, limit),
    deleteProfileComment: async (profileId: string, commentId: string) => {
      mockDeletedProfileComments.push({ profileId, commentId });
    },
    onCommentNotification: () => () => undefined,
    postProfileComment: async () => 'mock-comment-id',
    start: async () => undefined,
    stop: () => undefined,
  },
}));

interface ApprovalCapableTool {
  invoke: (runContext: unknown, input: string) => Promise<unknown>;
  name: string;
  needsApproval: (
    runContext: unknown,
    input: unknown,
    callId?: string,
  ) => Promise<boolean>;
}

interface InvokableTool {
  name: string;
  invoke: (runContext: unknown, input: string) => Promise<unknown>;
}

let runWithToolContext: typeof import('../../src/utils/types').runWithToolContext;
let steamProfileCommentTool: ApprovalCapableTool;
let steamProfileCommentsTool: InvokableTool;
let steamProfileTool: InvokableTool;
let getToolNamesForSurface: typeof import('../../src/tools').getToolNamesForSurface;
let searchSteamProfileComments: typeof import('../../src/steam/comment-search').searchSteamProfileComments;

function buildSteamComment(
  id: string,
  authorSteamId: string,
): SteamProfileComment {
  return {
    id,
    authorSteamId,
    authorName:
      authorSteamId === TEST_STEAM_BOT_STEAM_ID64 ? 'Ruyi' : 'Visitor',
    date: new Date('2026-06-19T10:00:00Z'),
    text: `Comment ${id}`,
    html: '',
  };
}

function baseContext(surface: ToolContext['surface']): ToolContext {
  return {
    surface,
    identity: null,
    message: null,
    channel: null,
    guild: null,
    referencedMessage: null,
    steam:
      surface === 'steam'
        ? { profileId: '76561198000000002', sourceCommentId: 'comment-1' }
        : undefined,
  };
}

beforeAll(async () => {
  ({ runWithToolContext } = await import('../../src/utils/types'));
  ({ steamProfileCommentTool, steamProfileCommentsTool } = await import(
    '../../src/steam/tools/profile-comment',
  ) as unknown as {
    steamProfileCommentTool: ApprovalCapableTool;
    steamProfileCommentsTool: InvokableTool;
  });
  ({ steamProfileTool } = await import('../../src/steam/tools/profile') as unknown as {
    steamProfileTool: InvokableTool;
  });
  ({ getToolNamesForSurface } = await import('../../src/tools'));
  ({ searchSteamProfileComments } = await import(
    '../../src/steam/comment-search',
  ));
}, 30_000);

describe('steam_profile_comment approval', () => {
  test('requires approval in Discord-origin turns', async () => {
    const needsApproval = await runWithToolContext(
      baseContext('discord'),
      () =>
        steamProfileCommentTool.needsApproval(
          null,
          { target: 'bot', message: 'hello' },
          'call-1',
        ),
    );

    expect(needsApproval).toBe(true);
  });

  test('auto-approves in Steam-origin turns', async () => {
    const needsApproval = await runWithToolContext(
      baseContext('steam'),
      () =>
        steamProfileCommentTool.needsApproval(
          null,
          { target: 'bot', message: 'hello' },
          'call-2',
        ),
    );

    expect(needsApproval).toBe(false);
  });
});

describe('steam_profile_comment deletion', () => {
  test('allows deleting any comment from Ruyi bot profile', async () => {
    mockDeletedProfileComments = [];
    mockProfileComments = [
      buildSteamComment('visitor-comment', '76561198000000099'),
    ];

    const result = (await runWithToolContext(
      baseContext('steam'),
      () =>
        steamProfileCommentTool.invoke(
          null,
          JSON.stringify({
            action: 'delete',
            target: 'bot',
            comment_id: 'visitor-comment',
          }),
        ),
    )) as { action?: string; success?: boolean };

    expect(result.success).toBe(true);
    expect(result.action).toBe('delete');
    expect(mockDeletedProfileComments).toEqual([
      {
        profileId: TEST_STEAM_BOT_STEAM_ID64,
        commentId: 'visitor-comment',
      },
    ]);
  });

  test('uses the current Steam comment id when deleting from the bot profile', async () => {
    mockDeletedProfileComments = [];
    mockProfileComments = [
      buildSteamComment('comment-1', '76561198000000099'),
    ];

    const result = (await runWithToolContext(
      baseContext('steam'),
      () =>
        steamProfileCommentTool.invoke(
          null,
          JSON.stringify({
            action: 'delete',
            target: 'bot',
          }),
        ),
    )) as { action?: string; commentId?: string; success?: boolean };

    expect(result.success).toBe(true);
    expect(result.action).toBe('delete');
    expect(result.commentId).toBe('comment-1');
    expect(mockDeletedProfileComments).toEqual([
      {
        profileId: TEST_STEAM_BOT_STEAM_ID64,
        commentId: 'comment-1',
      },
    ]);
  });

  test('refuses deleting user comments from owner profile', async () => {
    mockDeletedProfileComments = [];
    mockProfileComments = [
      buildSteamComment('owner-visitor-comment', '76561198000000099'),
    ];

    const result = (await steamProfileCommentTool.invoke(
      null,
      JSON.stringify({
        action: 'delete',
        target: 'owner',
        comment_id: 'owner-visitor-comment',
      }),
    )) as { details?: string; error?: string };

    expect(result.error).toBe('Steam profile comment deletion is not allowed.');
    expect(result.details).toContain('only delete my own');
    expect(mockDeletedProfileComments).toHaveLength(0);
  });

  test('allows deleting Ruyi-authored comments from owner profile', async () => {
    mockDeletedProfileComments = [];
    mockProfileComments = [
      buildSteamComment('ruyi-owner-comment', TEST_STEAM_BOT_STEAM_ID64),
    ];

    const result = (await steamProfileCommentTool.invoke(
      null,
      JSON.stringify({
        action: 'delete',
        target: 'owner',
        comment_id: 'ruyi-owner-comment',
      }),
    )) as { action?: string; success?: boolean };

    expect(result.success).toBe(true);
    expect(result.action).toBe('delete');
    expect(mockDeletedProfileComments).toEqual([
      {
        profileId: TEST_STEAM_OWNER_STEAM_ID64,
        commentId: 'ruyi-owner-comment',
      },
    ]);
  });
});

describe('surface-aware Steam tools', () => {
  test('Steam turns get Steam-safe shared tools but not Discord-only tools', () => {
    const steamTools = getToolNamesForSurface('steam');

    expect(steamTools.has('steam_profile_comment')).toBe(true);
    expect(steamTools.has('steam_profile')).toBe(true);
    expect(steamTools.has('search_conversation')).toBe(true);
    expect(steamTools.has('steam_profile_comments')).toBe(false);
    expect(steamTools.has('memory_recall')).toBe(true);
    expect(steamTools.has('web_search')).toBe(true);
    expect(steamTools.has('get_user_info')).toBe(false);
    expect(steamTools.has('manage_role')).toBe(false);
    expect(steamTools.has('send_embed')).toBe(false);
  });

  test('Discord turns keep Discord tools and can still explicitly post Steam comments', () => {
    const discordTools = getToolNamesForSurface('discord');

    expect(discordTools.has('get_user_info')).toBe(true);
    expect(discordTools.has('manage_role')).toBe(true);
    expect(discordTools.has('search_conversation')).toBe(true);
    expect(discordTools.has('steam_profile_comment')).toBe(true);
    expect(discordTools.has('steam_profile')).toBe(true);
    expect(discordTools.has('steam_profile_comments')).toBe(true);
  });
});

describe('steam_profile tool', () => {
  test('reads owner profile, visible games, recent games, cosmetics, and inventory contexts', async () => {
    resetSteamProfileCalls();
    mockOwnedGamesError = null;

    const result = (await steamProfileTool.invoke(
      null,
      JSON.stringify({
        target: 'owner',
        include: [
          'profile',
          'games',
          'recent_games',
          'equipped_items',
          'inventory_contexts',
        ],
        limit: 2,
      }),
    )) as {
      equipped_items?: { avatarFrame?: { name?: string } | null };
      games?: { games?: Array<{ name: string }> };
      inventory_contexts?: Array<{ appId: number }>;
      profile?: { name: string; persona?: { gameName?: string } };
      recent_games?: { games?: Array<{ name: string }> };
      success?: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.profile?.name).toBe('Shadow');
    expect(result.profile?.persona?.gameName).toBe('Portal 2');
    expect(result.games?.games?.[0]?.name).toBe('Portal 2');
    expect(result.recent_games?.games?.[0]?.name).toBe('Portal 2');
    expect(result.equipped_items?.avatarFrame?.name).toBe('Fox Frame');
    expect(result.inventory_contexts?.[0]?.appId).toBe(753);
    expect(mockSteamProfileCalls).toMatchObject({
      equippedItems: 1,
      inventoryContexts: 1,
      inventoryItems: 0,
      ownedGames: 1,
      profile: 1,
    });
  });

  test('uses the current Steam commenter in Steam turns', async () => {
    resetSteamProfileCalls();
    const context = {
      ...baseContext('steam'),
      identity: {
        canWriteMemory: false,
        personId: 'steam:76561198000009999',
        surface: 'steam',
        surfaceUserId: '76561198000009999',
        username: 'Commenter',
      },
    } satisfies ToolContext;

    const result = (await runWithToolContext(
      context,
      () =>
        steamProfileTool.invoke(
          null,
          JSON.stringify({
            target: 'current_steam_user',
            include: ['profile'],
          }),
        ),
    )) as { lookup?: string; profile?: { name: string } };

    expect(result.lookup).toBe('76561198000009999');
    expect(result.profile?.name).toBe('Commenter');
    expect(mockSteamProfileCalls).toMatchObject({
      equippedItems: 0,
      inventoryContexts: 0,
      inventoryItems: 0,
      ownedGames: 0,
      profile: 1,
    });
  });

  test('keeps public profile data when games are private or hidden', async () => {
    resetSteamProfileCalls();
    mockOwnedGamesError = new Error('Private games');

    const result = (await steamProfileTool.invoke(
      null,
      JSON.stringify({
        target: 'owner',
        include: ['profile', 'games'],
      }),
    )) as {
      games?: unknown;
      limitations?: string[];
      profile?: { name: string };
      success?: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.profile?.name).toBe('Shadow');
    expect(result.games).toBeUndefined();
    expect(result.limitations?.[0]).toContain('Private games');
    mockOwnedGamesError = null;
  });

  test('only reads the requested Steam sections', async () => {
    resetSteamProfileCalls();

    const result = (await steamProfileTool.invoke(
      null,
      JSON.stringify({
        target: 'owner',
        include: ['recent_games'],
        limit: 2,
      }),
    )) as {
      profile?: unknown;
      recent_games?: { games?: Array<{ name: string }> };
      success?: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.profile).toBeUndefined();
    expect(result.recent_games?.games?.[0]?.name).toBe('Portal 2');
    expect(mockSteamProfileCalls).toMatchObject({
      equippedItems: 0,
      inventoryContexts: 0,
      inventoryItems: 0,
      ownedGames: 1,
      profile: 0,
    });
  });
});

describe('Steam comment fuzzy search', () => {
  test('finds exact and fuzzy comment matches with context', async () => {
    mockProfileComments = [
      {
        id: 'comment-1',
        authorSteamId: '76561198000000001',
        authorName: 'Alex',
        date: new Date('2026-06-19T10:00:00Z'),
        text: 'Hey Ruyi, remember the blue fox quote for later.',
        html: '',
      },
      {
        id: 'comment-2',
        authorSteamId: '76561198000000002',
        authorName: 'Ruyi',
        date: new Date('2026-06-19T10:01:00Z'),
        text: 'Of course, your humble servant will keep it close.',
        html: '',
      },
      {
        id: 'comment-3',
        authorSteamId: '76561198000000001',
        authorName: 'Alex',
        date: new Date('2026-06-19T10:02:00Z'),
        text: 'Also I meant the bright fox quotation, not the old one.',
        html: '',
      },
    ];

    const result = await searchSteamProfileComments(
      '76561198000000003',
      'blue fox quote',
      null,
      5,
    );

    expect(result.matches[0]?.id).toBe('comment-1');
    expect(result.matches[0]?.matchType).toBe('exact_phrase');
    expect(result.matches[0]?.contextAfter[0]?.id).toBe('comment-2');
    expect(result.summary.bestMatchType).toBe('exact_phrase');
    expect(result.searchedCommentCount).toBe(3);
  });

  test('keeps author filtering inside Steam comment search', async () => {
    mockProfileComments = [
      {
        id: 'comment-1',
        authorSteamId: '76561198000000001',
        authorName: 'Alex',
        date: new Date('2026-06-19T10:00:00Z'),
        text: 'Tails quote',
        html: '',
      },
      {
        id: 'comment-2',
        authorSteamId: '76561198000000002',
        authorName: 'Ruyi',
        date: new Date('2026-06-19T10:01:00Z'),
        text: 'Tails quote',
        html: '',
      },
    ];

    const result = await searchSteamProfileComments(
      '76561198000000003',
      'Tails quote',
      'Ruyi',
      5,
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.author).toBe('Ruyi');
  });

  test('returns snake_case search summary from the Discord Steam bridge', async () => {
    mockProfileComments = [
      {
        id: 'comment-1',
        authorSteamId: '76561198000000001',
        authorName: 'Alex',
        date: new Date('2026-06-19T10:00:00Z'),
        text: 'Remember the Tails quote.',
        html: '',
      },
    ];

    const result = (await steamProfileCommentsTool.invoke(
      null,
      JSON.stringify({
        target: 'bot',
        query: 'Tails quote',
        author: null,
        limit: 5,
      }),
    )) as { search_summary?: Record<string, unknown> };

    expect(result.search_summary?.exact_phrase_found).toBe(true);
    expect(result.search_summary?.best_match_type).toBe('exact_phrase');
    expect(result.search_summary?.exactPhraseFound).toBeUndefined();
  });
});
