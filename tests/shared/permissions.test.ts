import type { RunToolApprovalItem } from '@openai/agents';
import { describe, expect, test } from 'bun:test';
import { getPermissionSummary } from '../../src/utils/permission-summary';

function approvalItem(value: Partial<RunToolApprovalItem>): RunToolApprovalItem {
  return value as RunToolApprovalItem;
}

describe('permission prompt summaries', () => {
  test('shows local tool arguments from SDK arguments', () => {
    const summary = getPermissionSummary(
      approvalItem({
        name: 'delete_messages',
        arguments: JSON.stringify({
          count: 3,
          reason: 'User requested cleanup.',
        }),
      }),
    );

    expect(summary.displayName).toBe('delete_messages');
    expect(summary.description).toContain('Tool: `delete_messages`');
    expect(summary.description).toContain('- `count`: 3');
    expect(summary.description).toContain('- `reason`: User requested cleanup.');
  });

  test('shows hosted MCP tool arguments from provider data', () => {
    const summary = getPermissionSummary(
      approvalItem({
        name: 'record_create',
        rawItem: {
          type: 'hosted_tool_call',
          name: 'mcp_approval_request',
          providerData: {
            type: 'mcp_approval_request',
            server_label: 'source_control',
            name: 'record_create',
            arguments: JSON.stringify({
              workspace: 'ShadowNineX/Ruyi',
              title: 'Fix permission prompt UI',
              body: 'Show the actual arguments before approval.',
            }),
          },
        },
      }),
    );

    expect(summary.displayName).toBe('Source Control record_create');
    expect(summary.description).toContain('Service: **Source Control**');
    expect(summary.description).toContain('MCP tool: `record_create`');
    expect(summary.description).toContain('- `workspace`: ShadowNineX/Ruyi');
    expect(summary.description).toContain('- `title`: Fix permission prompt UI');
  });

  test('shows wrapped MCP tool arguments consistently', () => {
    const summary = getPermissionSummary(
      approvalItem({
        name: 'mcp_call_tool',
        toolName: 'mcp_call_tool',
        arguments: JSON.stringify({
          server_id: 'video_service',
          tool_name: 'search',
          tool_arguments: [
            { name: 'query', value: 'Tails Sonic' },
            { name: 'max_results', value: 3 },
          ],
        }),
        rawItem: {
          type: 'function_call',
          callId: 'call_wrapped_mcp',
          name: 'mcp_call_tool',
          arguments: '{}',
        },
      }),
    );

    expect(summary.displayName).toBe('Video Service search');
    expect(summary.description).toContain('Service: **Video Service**');
    expect(summary.description).toContain('MCP tool: `search`');
    expect(summary.description).toContain('- `query`: Tails Sonic');
    expect(summary.description).toContain('- `max_results`: 3');
  });
});
