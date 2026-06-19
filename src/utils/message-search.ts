import type { FuseResult } from 'fuse.js';
import Fuse from 'fuse.js';

export type MessageMatchType
  = | 'recent'
    | 'exact_phrase'
    | 'all_terms'
    | 'partial_terms'
    | 'fuzzy';

export interface SearchableMessage {
  id: string;
  author: string;
  content: string;
  timestamp: Date | number;
}

export interface RankedMessageMatch<T extends SearchableMessage> {
  item: T;
  matchType: MessageMatchType;
  score: number;
  fuseScore: number | null;
  matchedTerms: string[];
  missingTerms: string[];
}

interface DeterministicMatch {
  matchType: Exclude<MessageMatchType, 'recent' | 'fuzzy'>;
  score: number;
  matchedTerms: string[];
  missingTerms: string[];
}

interface MutableRankedMatch<
  T extends SearchableMessage,
> extends RankedMessageMatch<T> {
  rank: number;
}

const FUSE_THRESHOLD = 0.45;
const FUSE_WEIGHT = 0.7;
const PARTIAL_BASE_SCORE = 0.55;

function isAsciiDigit(codePoint: number | undefined): boolean {
  return codePoint !== undefined && codePoint >= 48 && codePoint <= 57;
}

function isSearchWordCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (isAsciiDigit(codePoint)) { return true; }

  return (
    character.toLocaleLowerCase() !== character.toLocaleUpperCase()
  );
}

function normalizeSearchText(value: string): string {
  let output = '';
  let previousWasSpace = true;

  for (const character of value.toLowerCase()) {
    if (isSearchWordCharacter(character)) {
      output += character;
      previousWasSpace = false;
    } else if (!previousWasSpace) {
      output += ' ';
      previousWasSpace = true;
    }
  }

  return output.trim();
}

function tokenizeMessageSearchQuery(query: string): string[] {
  return [...new Set(normalizeSearchText(query).split(' ').filter(Boolean))];
}

function timestampMs(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

function sortRecentFirst<T extends SearchableMessage>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp),
  );
}

function buildRecentMatches<T extends SearchableMessage>(
  messages: T[],
  limit: number,
): RankedMessageMatch<T>[] {
  return sortRecentFirst(messages)
    .slice(0, limit)
    .map(item => ({
      item,
      matchType: 'recent',
      score: 1,
      fuseScore: null,
      matchedTerms: [],
      missingTerms: [],
    }));
}

function deterministicMatch<T extends SearchableMessage>(
  item: T,
  normalizedQuery: string,
  queryTerms: string[],
): DeterministicMatch | null {
  const normalizedContent = normalizeSearchText(item.content);
  const matchedTerms = queryTerms.filter(term =>
    normalizedContent.includes(term),
  );
  const missingTerms = queryTerms.filter(
    term => !matchedTerms.includes(term),
  );

  if (normalizedQuery && normalizedContent.includes(normalizedQuery)) {
    return {
      matchType: 'exact_phrase',
      score: 0,
      matchedTerms,
      missingTerms,
    };
  }

  if (queryTerms.length > 0 && missingTerms.length === 0) {
    return {
      matchType: 'all_terms',
      score: 0.15,
      matchedTerms,
      missingTerms,
    };
  }

  if (matchedTerms.length > 0) {
    const missingRatio = missingTerms.length / queryTerms.length;
    return {
      matchType: 'partial_terms',
      score: PARTIAL_BASE_SCORE + missingRatio * 0.2,
      matchedTerms,
      missingTerms,
    };
  }

  return null;
}

function addOrImproveMatch<T extends SearchableMessage>(
  matches: Map<string, MutableRankedMatch<T>>,
  candidate: MutableRankedMatch<T>,
): void {
  const existing = matches.get(candidate.item.id);
  if (!existing || candidate.score < existing.score) {
    matches.set(candidate.item.id, candidate);
    return;
  }

  if (existing.fuseScore === null && candidate.fuseScore !== null) {
    existing.fuseScore = candidate.fuseScore;
  }
}

function addDeterministicMatches<T extends SearchableMessage>(
  messages: T[],
  matches: Map<string, MutableRankedMatch<T>>,
  normalizedQuery: string,
  queryTerms: string[],
): void {
  messages.forEach((item, rank) => {
    const match = deterministicMatch(item, normalizedQuery, queryTerms);
    if (!match) { return; }

    addOrImproveMatch(matches, {
      item,
      matchType: match.matchType,
      score: match.score,
      fuseScore: null,
      matchedTerms: match.matchedTerms,
      missingTerms: match.missingTerms,
      rank,
    });
  });
}

function addFuseMatches<T extends SearchableMessage>(
  fuseResults: FuseResult<T>[],
  matches: Map<string, MutableRankedMatch<T>>,
  queryTerms: string[],
): void {
  fuseResults.forEach((result, rank) => {
    const fuseScore = result.score ?? FUSE_THRESHOLD;
    if (fuseScore > FUSE_THRESHOLD) { return; }

    const existing = matches.get(result.item.id);
    const score
      = existing?.score ?? PARTIAL_BASE_SCORE + fuseScore * FUSE_WEIGHT;

    addOrImproveMatch(matches, {
      item: result.item,
      matchType: existing?.matchType ?? 'fuzzy',
      score,
      fuseScore,
      matchedTerms: existing?.matchedTerms ?? [],
      missingTerms: existing?.missingTerms ?? queryTerms,
      rank,
    });
  });
}

function sortMatches<T extends SearchableMessage>(
  matches: Iterable<MutableRankedMatch<T>>,
): RankedMessageMatch<T>[] {
  return [...matches]
    .sort((a, b) => {
      const scoreDelta = a.score - b.score;
      if (scoreDelta !== 0) { return scoreDelta; }
      const timeDelta
        = timestampMs(b.item.timestamp) - timestampMs(a.item.timestamp);
      if (timeDelta !== 0) { return timeDelta; }
      return a.rank - b.rank;
    })
    .map(({ rank: _rank, ...match }) => match);
}

export function rankMessageMatches<T extends SearchableMessage>(
  messages: T[],
  query: string | null,
  limit: number,
): RankedMessageMatch<T>[] {
  const normalizedQuery = query ? normalizeSearchText(query) : '';
  if (!normalizedQuery) { return buildRecentMatches(messages, limit); }

  const queryTerms = tokenizeMessageSearchQuery(query ?? '');
  const matches = new Map<string, MutableRankedMatch<T>>();

  addDeterministicMatches(messages, matches, normalizedQuery, queryTerms);

  const fuse = new Fuse(messages, {
    keys: [
      { name: 'content', weight: 0.9 },
      { name: 'author', weight: 0.1 },
    ],
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 2,
    shouldSort: true,
    threshold: FUSE_THRESHOLD,
  });
  addFuseMatches(fuse.search(query ?? ''), matches, queryTerms);

  return sortMatches(matches.values()).slice(0, limit);
}

export function summarizeMessageSearchMatches<T extends SearchableMessage>(
  matches: RankedMessageMatch<T>[],
): {
  exactPhraseFound: boolean;
  bestMatchType: MessageMatchType | null;
  fuzzyMatchCount: number;
  partialMatchCount: number;
} {
  return {
    exactPhraseFound: matches.some(
      match => match.matchType === 'exact_phrase',
    ),
    bestMatchType: matches[0]?.matchType ?? null,
    fuzzyMatchCount: matches.filter(match => match.matchType === 'fuzzy')
      .length,
    partialMatchCount: matches.filter(
      match => match.matchType === 'partial_terms',
    ).length,
  };
}
