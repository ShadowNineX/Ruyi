export const DEFAULT_SESSION_LABEL = 'assistant';

function isSessionLabelCharacter(value: string): boolean {
  return (
    (value >= 'a' && value <= 'z')
    || (value >= '0' && value <= '9')
    || value === '_'
    || value === '-'
  );
}

function trimEdgeHyphens(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === '-') { start += 1; }
  while (end > start && value[end - 1] === '-') { end -= 1; }

  return value.slice(start, end);
}

export function normalizeSessionLabel(label: string): string {
  let normalized = '';
  let previousWasHyphen = false;

  for (const character of label.toLowerCase()) {
    if (isSessionLabelCharacter(character)) {
      normalized += character;
      previousWasHyphen = character === '-';
      continue;
    }

    if (!previousWasHyphen) {
      normalized += '-';
      previousWasHyphen = true;
    }
  }

  return trimEdgeHyphens(normalized) || DEFAULT_SESSION_LABEL;
}

export function buildAgentSessionId({
  conversationId,
  label,
  surface,
  timestamp = Date.now(),
}: {
  conversationId: string;
  label: string;
  surface: string;
  timestamp?: number | string;
}): string {
  return `${normalizeSessionLabel(label)}-${surface}-${conversationId}-${timestamp}`;
}
