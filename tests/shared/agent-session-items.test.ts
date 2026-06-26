import type { AgentInputItem } from '@openai/agents';
import { describe, expect, test } from 'bun:test';
import { retainReplaySafeItems } from '../../src/utils/agent-session-items';

function item(value: Record<string, unknown>): AgentInputItem {
  return value as AgentInputItem;
}

describe('agent session item retention', () => {
  test('keeps reasoning items paired with retained assistant messages', () => {
    const items = [
      item({ type: 'reasoning', id: 'rs_old' }),
      item({ type: 'message', id: 'msg_old', role: 'assistant' }),
      item({ type: 'message', id: 'msg_user', role: 'user' }),
      item({ type: 'reasoning', id: 'rs_new' }),
      item({ type: 'message', id: 'msg_new', role: 'assistant' }),
    ];

    expect(retainReplaySafeItems(items, 1)).toEqual([
      item({ type: 'reasoning', id: 'rs_new' }),
      item({ type: 'message', id: 'msg_new', role: 'assistant' }),
    ]);
  });

  test('keeps function calls paired with retained function call results', () => {
    const items = [
      item({ type: 'function_call', call_id: 'call_1', name: 'lookup' }),
      item({ type: 'function_call_result', call_id: 'call_1', output: 'ok' }),
    ];

    expect(retainReplaySafeItems(items, 1)).toEqual(items);
  });
});
