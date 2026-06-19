const TOKEN_REGEX = /[a-z0-9']+/g;

export interface MessageEditAssessment {
  meaningful: boolean;
  shouldRegenerate: boolean;
  reason: string;
}

function normalizeLoose(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

function tokenize(value: string): string[] {
  return normalizeLoose(value).match(TOKEN_REGEX) ?? [];
}

function sameValues(first: string[], second: string[]): boolean {
  if (first.length !== second.length) {
    return false;
  }
  return first.every((value, index) => value === second[index]);
}

function tokenCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function tokenDifference(
  beforeTokens: string[],
  afterTokens: string[],
): { removed: string[]; added: string[] } {
  const beforeCounts = tokenCounts(beforeTokens);
  const afterCounts = tokenCounts(afterTokens);
  const removed: string[] = [];
  const added: string[] = [];

  for (const [token, count] of beforeCounts) {
    const diff = count - (afterCounts.get(token) ?? 0);
    for (let index = 0; index < diff; index += 1) {
      removed.push(token);
    }
  }

  for (const [token, count] of afterCounts) {
    const diff = count - (beforeCounts.get(token) ?? 0);
    for (let index = 0; index < diff; index += 1) {
      added.push(token);
    }
  }

  return { removed, added };
}

function levenshteinDistance(first: string, second: string): number {
  const previous = Array.from(
    { length: second.length + 1 },
    (_, index) => index,
  );
  const current: number[] = Array.from(
    { length: second.length + 1 },
    () => 0,
  );

  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    current[0] = firstIndex;
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      const cost = first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1;
      const insertion = (current[secondIndex - 1] ?? 0) + 1;
      const deletion = (previous[secondIndex] ?? 0) + 1;
      const substitution = (previous[secondIndex - 1] ?? 0) + cost;
      current[secondIndex] = Math.min(insertion, deletion, substitution);
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[second.length] ?? 0;
}

function looksLikeTypoCorrection(before: string, after: string): boolean {
  const maxLength = Math.max(before.length, after.length);
  if (maxLength < 3) {
    return before === after;
  }
  if (isAdjacentTransposition(before, after)) {
    return true;
  }

  const distance = levenshteinDistance(before, after);
  const threshold = Math.max(1, Math.floor(maxLength * 0.35));
  return distance <= threshold;
}

function isAdjacentTransposition(before: string, after: string): boolean {
  if (before.length !== after.length) {
    return false;
  }

  const differingIndexes: number[] = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) {
      differingIndexes.push(index);
    }
  }

  if (differingIndexes.length !== 2) {
    return false;
  }
  const [firstIndex, secondIndex] = differingIndexes;
  if (
    firstIndex === undefined
    || secondIndex === undefined
    || secondIndex !== firstIndex + 1
  ) {
    return false;
  }

  return (
    before[firstIndex] === after[secondIndex]
    && before[secondIndex] === after[firstIndex]
  );
}

function allTokenChangesLookLikeTypos(
  removed: string[],
  added: string[],
): boolean {
  if (removed.length !== added.length || removed.length > 4) {
    return false;
  }

  const remainingAdded = [...added];
  for (const removedToken of removed) {
    const matchIndex = remainingAdded.findIndex(addedToken =>
      looksLikeTypoCorrection(removedToken, addedToken),
    );
    if (matchIndex === -1) {
      return false;
    }
    remainingAdded.splice(matchIndex, 1);
  }

  return true;
}

export function assessMessageEdit(
  before: string,
  after: string,
): MessageEditAssessment {
  const normalizedBefore = normalizeLoose(before);
  const normalizedAfter = normalizeLoose(after);
  if (normalizedBefore === normalizedAfter) {
    return {
      meaningful: false,
      shouldRegenerate: false,
      reason: 'formatting_only',
    };
  }

  const beforeTokens = tokenize(before);
  const afterTokens = tokenize(after);
  if (sameValues(beforeTokens, afterTokens)) {
    return {
      meaningful: false,
      shouldRegenerate: false,
      reason: 'punctuation_or_case_only',
    };
  }

  const { removed, added } = tokenDifference(beforeTokens, afterTokens);
  if (allTokenChangesLookLikeTypos(removed, added)) {
    return {
      meaningful: false,
      shouldRegenerate: false,
      reason: 'typo_only',
    };
  }

  return {
    meaningful: true,
    shouldRegenerate: true,
    reason: 'needs_semantic_classification',
  };
}
