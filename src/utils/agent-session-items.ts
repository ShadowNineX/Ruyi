import type { AgentInputItem } from '@openai/agents';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function itemType(item: AgentInputItem): string | null {
  const type = asRecord(item)?.type;
  return typeof type === 'string' ? type : null;
}

function callIdForItem(item: AgentInputItem): string | null {
  const record = asRecord(item);
  const callId = record?.callId ?? record?.call_id;
  return typeof callId === 'string' && callId.length > 0 ? callId : null;
}

function isFunctionCall(item: AgentInputItem): boolean {
  return itemType(item) === 'function_call';
}

function isFunctionCallResult(item: AgentInputItem): boolean {
  return itemType(item) === 'function_call_result';
}

function isReasoningItem(item: AgentInputItem | undefined): boolean {
  return item !== undefined && itemType(item) === 'reasoning';
}

function isAssistantMessageItem(item: AgentInputItem | undefined): boolean {
  const record = asRecord(item);
  return record?.type === 'message' && record.role === 'assistant';
}

function callIdsForItems(
  items: AgentInputItem[],
  predicate: (item: AgentInputItem) => boolean,
): Set<string> {
  const callIds = new Set<string>();

  for (const item of items) {
    const callId = callIdForItem(item);
    if (callId && predicate(item)) { callIds.add(callId); }
  }

  return callIds;
}

function missingFunctionCallIds(
  items: AgentInputItem[],
  knownCallIds: Set<string>,
): Set<string> {
  const missingCallIds = new Set<string>();

  for (const item of items) {
    const callId = callIdForItem(item);
    if (callId && isFunctionCallResult(item) && !knownCallIds.has(callId)) {
      missingCallIds.add(callId);
    }
  }

  return missingCallIds;
}

function moveStartBeforeMissingCalls(
  items: AgentInputItem[],
  start: number,
  missingCallIds: Set<string>,
): number {
  let safeStart = start;

  while (missingCallIds.size > 0 && safeStart > 0) {
    safeStart -= 1;
    const item = items[safeStart];
    if (!item) { continue; }

    const callId = callIdForItem(item);
    if (!callId) { continue; }
    if (isFunctionCall(item)) { missingCallIds.delete(callId); }
    if (isFunctionCallResult(item)) { missingCallIds.add(callId); }
  }

  return safeStart;
}

function moveStartBeforeReasoningItems(
  items: AgentInputItem[],
  start: number,
): number {
  let safeStart = start;

  for (let index = start; index < items.length; index += 1) {
    const previousIndex = index - 1;
    if (
      previousIndex >= 0
      && previousIndex < safeStart
      && isAssistantMessageItem(items[index])
      && isReasoningItem(items[previousIndex])
    ) {
      safeStart = previousIndex;
    }
  }

  while (safeStart > 0 && isReasoningItem(items[safeStart - 1])) {
    safeStart -= 1;
  }

  return safeStart;
}

export function findReplaySafeStartIndex(
  items: AgentInputItem[],
  desiredStart: number,
): number {
  const start = Math.min(Math.max(0, desiredStart), items.length);
  const retainedItems = items.slice(start);
  const retainedCallIds = callIdsForItems(retainedItems, isFunctionCall);
  const missingCallIds = missingFunctionCallIds(retainedItems, retainedCallIds);
  const callSafeStart = moveStartBeforeMissingCalls(
    items,
    start,
    missingCallIds,
  );

  return moveStartBeforeReasoningItems(items, callSafeStart);
}

export function retainReplaySafeItems(
  items: AgentInputItem[],
  maxItems: number,
): AgentInputItem[] {
  const desiredStart = Math.max(0, items.length - maxItems);
  return items.slice(findReplaySafeStartIndex(items, desiredStart));
}
