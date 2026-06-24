import type { SteamOwnedGamesSort } from '../client';
import { tool } from '@openai/agents';
import { z } from 'zod';
import {
  STEAM_INVENTORY_ITEM_LIMIT_MAX,
  STEAM_PROFILE_TOOL_LIMIT_MAX,
} from '../../constants';
import { toolLogger } from '../../logger';
import { toolContextManager } from '../../utils/types';
import {
  resolveSteamProfileTarget,
  steamIntegrationEnabled,
} from '../../utils/user-identity';
import {
  normalizeSteamProfileLookup,
  steamCommunityClient,
} from '../client';

const steamProfileIncludeSchema = z.enum([
  'profile',
  'games',
  'recent_games',
  'equipped_items',
  'inventory_contexts',
  'inventory_items',
]);

type SteamProfileInclude = z.infer<typeof steamProfileIncludeSchema>;

const steamProfileTargetSchema = z.enum([
  'owner',
  'bot',
  'current_steam_user',
  'lookup',
]);

interface SteamProfileSectionContext {
  accountId: string | null;
  fresh: boolean;
  gameSort: SteamOwnedGamesSort;
  include: SteamProfileInclude[];
  inventoryAppId: number | null;
  inventoryContextId: string | null;
  limitations: string[];
  limit: number;
  lookup: string;
  sections: Record<string, unknown>;
  tradableOnly: boolean;
}

function resolveLookup(
  target: z.infer<typeof steamProfileTargetSchema>,
  lookup: string | null,
  accountId: string | null,
): { lookup: string; target_label: string } | { error: string } {
  if (target === 'lookup') {
    const normalized = lookup ? normalizeSteamProfileLookup(lookup) : '';
    return normalized
      ? { lookup: normalized, target_label: 'lookup' }
      : { error: 'Steam profile lookup requires a SteamID64, vanity name, or profile URL.' };
  }

  if (target === 'current_steam_user') {
    const identity = toolContextManager.get().identity;
    if (identity?.surface === 'steam') {
      return {
        lookup: identity.surfaceUserId,
        target_label: 'current_steam_user',
      };
    }
    return {
      error:
        'current_steam_user is only available while replying to a Steam profile comment.',
    };
  }

  const resolved = resolveSteamProfileTarget(target, accountId);
  return resolved
    ? { lookup: resolved, target_label: target }
    : { error: `Steam ${target} profile is not configured.` };
}

function shouldFetchGames(includes: SteamProfileInclude[]): boolean {
  return includes.includes('games') || includes.includes('recent_games');
}

function buildPrivacyLimitation(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Steam did not return this section. It may be private, hidden, unavailable, or blocked by Steam permissions. Detail: ${message}`;
}

async function assignSteamSection(
  sections: Record<string, unknown>,
  limitations: string[],
  key: string,
  read: () => Promise<unknown>,
): Promise<void> {
  try {
    sections[key] = await read();
  } catch (error) {
    limitations.push(`${key}: ${buildPrivacyLimitation(error)}`);
  }
}

async function readProfileSection({
  accountId,
  fresh,
  include,
  limitations,
  lookup,
  sections,
}: SteamProfileSectionContext): Promise<void> {
  if (!include.includes('profile')) { return; }

  await assignSteamSection(
    sections,
    limitations,
    'profile',
    () =>
      steamCommunityClient.getPublicProfileSummary(
        lookup,
        { forceRefresh: fresh },
        accountId,
      ),
  );
}

async function readGameSections({
  fresh,
  gameSort,
  include,
  accountId,
  limitations,
  limit,
  lookup,
  sections,
}: SteamProfileSectionContext): Promise<void> {
  if (!shouldFetchGames(include)) { return; }

  try {
    const games = await steamCommunityClient.getOwnedGames(
      lookup,
      limit,
      gameSort,
      { forceRefresh: fresh },
      accountId,
    );
    if (include.includes('games')) { sections.games = games; }
    if (include.includes('recent_games')) {
      sections.recent_games = {
        app_count: games.appCount,
        returned_count: games.recentGames.length,
        games: games.recentGames,
        limitations: games.limitations,
      };
    }
  } catch (error) {
    limitations.push(`games: ${buildPrivacyLimitation(error)}`);
  }
}

async function readEquippedItemsSection({
  accountId,
  fresh,
  include,
  limitations,
  lookup,
  sections,
}: SteamProfileSectionContext): Promise<void> {
  if (!include.includes('equipped_items')) { return; }

  await assignSteamSection(
    sections,
    limitations,
    'equipped_items',
    () =>
      steamCommunityClient.getEquippedProfileItems(
        lookup,
        { forceRefresh: fresh },
        accountId,
      ),
  );
}

async function readInventoryContextsSection({
  accountId,
  fresh,
  include,
  limitations,
  lookup,
  sections,
}: SteamProfileSectionContext): Promise<void> {
  if (!include.includes('inventory_contexts')) { return; }

  await assignSteamSection(
    sections,
    limitations,
    'inventory_contexts',
    () =>
      steamCommunityClient.getInventoryContexts(
        lookup,
        { forceRefresh: fresh },
        accountId,
      ),
  );
}

async function readInventoryItemsSection({
  accountId,
  fresh,
  include,
  inventoryAppId,
  inventoryContextId,
  limitations,
  limit,
  lookup,
  sections,
  tradableOnly,
}: SteamProfileSectionContext): Promise<void> {
  if (!include.includes('inventory_items')) { return; }

  if (!inventoryAppId || !inventoryContextId) {
    limitations.push(
      'inventory_items requires inventory_app_id and inventory_context_id. Call steam_profile with include=["inventory_contexts"] first if you need valid contexts.',
    );
    return;
  }

  await assignSteamSection(
    sections,
    limitations,
    'inventory_items',
    () =>
      steamCommunityClient.getInventoryItems(
        lookup,
        inventoryAppId,
        inventoryContextId,
        tradableOnly,
        Math.min(limit, STEAM_INVENTORY_ITEM_LIMIT_MAX),
        { forceRefresh: fresh },
        accountId,
      ),
  );
}

async function readRequestedSteamSections(
  context: SteamProfileSectionContext,
): Promise<void> {
  await readProfileSection(context);
  await readGameSections(context);
  await readEquippedItemsSection(context);
  await readInventoryContextsSection(context);
  await readInventoryItemsSection(context);
}

export const steamProfileTool = tool({
  name: 'steam_profile',
  description:
    'Read only the requested public Steam Community profile sections: profile data, visible owned games/library, recently played games, equipped profile items, inventory contexts, or bounded inventory item samples. Keep include narrow and do not request every section unless the user explicitly asks for a full Steam profile audit. Respects Steam privacy limits. Read-only; posting comments uses steam_profile_comment.',
  parameters: z.object({
    target: steamProfileTargetSchema
      .default('owner')
      .describe(
        'Which Steam profile to inspect. Use owner for the configured owner Steam profile, bot for the active configured bot account, current_steam_user in Steam comment turns, or lookup with a public Steam profile URL/SteamID64/vanity name.',
      ),
    lookup: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .default(null)
      .describe(
        'Required only when target=lookup. Accepts SteamID64, vanity name, /id/... URL, or /profiles/... URL.',
      ),
    account_id: z
      .string()
      .min(1)
      .max(64)
      .nullable()
      .default(null)
      .describe(
        'Optional configured Steam account id, such as ruyi or tails. Used from Discord only; Steam comment turns use their active account automatically.',
      ),
    include: z
      .array(steamProfileIncludeSchema)
      .min(1)
      .max(6)
      .default(['profile'])
      .describe(
        'Sections to read. Use games for visible owned library, recent_games for recent playtime from visible games, equipped_items for profile cosmetics, inventory_contexts before inventory_items, and inventory_items only with app_id/context_id.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(STEAM_PROFILE_TOOL_LIMIT_MAX)
      .default(25)
      .describe('Maximum visible games or contexts to return.'),
    game_sort: z
      .enum(['recent', 'most_played', 'name'])
      .default('recent')
      .describe('How to sort visible owned games when include contains games.'),
    inventory_app_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe('Steam app ID for inventory_items. Use inventory_contexts first if unknown.'),
    inventory_context_id: z
      .string()
      .min(1)
      .max(32)
      .nullable()
      .default(null)
      .describe('Inventory context ID for inventory_items. Use inventory_contexts first if unknown.'),
    tradable_only: z
      .boolean()
      .default(false)
      .describe('For inventory_items, return only tradable items when true.'),
    fresh: z
      .boolean()
      .default(false)
      .describe(
        'Bypass the short cache and refetch from Steam. Use only when the user asks to refresh, wants current/live data, or cache freshness matters.',
      ),
  }),
  execute: async ({
    target,
    lookup,
    account_id: requestedAccountId,
    include,
    limit,
    game_sort: gameSort,
    inventory_app_id: inventoryAppId,
    inventory_context_id: inventoryContextId,
    tradable_only: tradableOnly,
    fresh,
  }) => {
    if (!steamIntegrationEnabled()) {
      return {
        error:
          'Steam integration is not configured. Set the Steam env vars before reading Steam profile data.',
      };
    }

    const accountId = toolContextManager.get().steam?.accountId ?? requestedAccountId;
    const resolved = resolveLookup(target, lookup, accountId);
    if ('error' in resolved) { return { error: resolved.error }; }

    const sections: Record<string, unknown> = {};
    const limitations: string[] = [];
    await readRequestedSteamSections({
      accountId,
      fresh,
      gameSort,
      include,
      inventoryAppId,
      inventoryContextId,
      limitations,
      limit,
      lookup: resolved.lookup,
      sections,
      tradableOnly,
    });

    toolLogger.info(
      {
        target,
        accountId,
        targetLabel: resolved.target_label,
        include,
        limit,
        fresh,
        hasLookup: Boolean(lookup),
        returnedSections: Object.keys(sections),
        limitationCount: limitations.length,
      },
      'Read Steam profile data',
    );

    return {
      success: Object.keys(sections).length > 0,
      target: resolved.target_label,
      account_id: accountId,
      lookup: resolved.lookup,
      include,
      cache: {
        fresh,
        ttl_seconds: 120,
      },
      ...sections,
      limitations,
      privacy_note:
        'Steam only exposes public or otherwise visible profile, game, and inventory data.',
    };
  },
});
