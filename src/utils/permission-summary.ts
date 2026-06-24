import type { RunToolApprovalItem } from '@openai/agents';
import {
  extractToolArgumentsFromRecord,
  formatToolArgumentLines,
  parseNullableToolArguments,
  parseToolArguments,
} from './tool-arguments';

const ARGUMENT_LINE_LIMIT = 8;

export interface PermissionSummary {
  displayName: string;
  description: string;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) { return value; }
  return `${value.slice(0, maxLength - 3)}...`;
}

export function getApprovalToolName(
  approvalItem: RunToolApprovalItem,
): string {
  return approvalItem.name ?? approvalItem.toolName ?? 'unknown_tool';
}

function parseApprovalArguments(
  rawArguments: string | undefined,
): Record<string, unknown> | null {
  return parseNullableToolArguments(rawArguments);
}

function getStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function hasToolArguments(args: Record<string, unknown>): boolean {
  return Object.keys(args).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatServiceName(serviceId: string): string {
  const formatted = serviceId
    .split(/[_-]+/u)
    .filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
  return formatted || serviceId;
}

function getApprovalRawItem(
  approvalItem: RunToolApprovalItem,
): Record<string, unknown> {
  return isRecord(approvalItem.rawItem) ? approvalItem.rawItem : {};
}

function getApprovalProviderData(
  approvalItem: RunToolApprovalItem,
): Record<string, unknown> | null {
  const providerData = getApprovalRawItem(approvalItem).providerData;
  return isRecord(providerData) ? providerData : null;
}

function getApprovalArgumentRecord(
  approvalItem: RunToolApprovalItem,
): Record<string, unknown> {
  const directArguments = parseToolArguments(approvalItem.arguments);
  if (hasToolArguments(directArguments)) { return directArguments; }

  const providerData = getApprovalProviderData(approvalItem);
  if (providerData) {
    const providerArguments = extractToolArgumentsFromRecord(providerData);
    if (hasToolArguments(providerArguments)) { return providerArguments; }
  }

  return extractToolArgumentsFromRecord(getApprovalRawItem(approvalItem));
}

function formatPermissionArgumentLines(args: Record<string, unknown>): string[] {
  return formatToolArgumentLines(args, {
    lineLimit: ARGUMENT_LINE_LIMIT,
    valueMaxLength: 700,
  });
}

function formatRawArgumentLine(rawArguments: string | undefined): string | null {
  if (!rawArguments?.trim()) { return null; }

  return `- input: ${truncate(rawArguments.replace(/\s+/g, ' '), 700)}`;
}

function appendArgumentLines(
  lines: string[],
  argumentLines: string[],
): void {
  if (argumentLines.length === 0) { return; }
  lines.push('', 'Request details:', ...argumentLines);
}

function buildGenericPermissionSummary(
  approvalItem: RunToolApprovalItem,
  approvalArgs: Record<string, unknown> | null,
): PermissionSummary {
  const toolName = getApprovalToolName(approvalItem);
  const lines = [`Tool: \`${toolName}\``];
  const args = approvalArgs
    ? extractToolArgumentsFromRecord(approvalArgs, approvalArgs)
    : getApprovalArgumentRecord(approvalItem);
  const argumentLines = formatPermissionArgumentLines(args);

  appendArgumentLines(lines, argumentLines);
  if (argumentLines.length === 0) {
    const rawArgumentLine = formatRawArgumentLine(approvalItem.arguments);
    if (rawArgumentLine) { appendArgumentLines(lines, [rawArgumentLine]); }
  }

  return {
    displayName: toolName,
    description: truncate(lines.join('\n'), 3900),
  };
}

function buildWrappedMcpPermissionSummary(
  approvalArgs: Record<string, unknown>,
): PermissionSummary | null {
  const serverId = getStringField(approvalArgs, 'server_id');
  const toolName = getStringField(approvalArgs, 'tool_name');
  if (!serverId || !toolName) { return null; }

  const serviceName = formatServiceName(serverId);
  const mcpArgs = extractToolArgumentsFromRecord(approvalArgs);
  const lines = [
    `Service: **${serviceName}**`,
    `MCP tool: \`${toolName}\``,
  ];

  appendArgumentLines(lines, formatPermissionArgumentLines(mcpArgs));

  return {
    displayName: `${serviceName} ${toolName}`,
    description: truncate(lines.join('\n'), 3900),
  };
}

function buildHostedMcpPermissionSummary(
  approvalItem: RunToolApprovalItem,
): PermissionSummary | null {
  const providerData = getApprovalProviderData(approvalItem);
  if (!providerData) { return null; }

  const providerType = getStringField(providerData, 'type');
  const rawItemName = getStringField(getApprovalRawItem(approvalItem), 'name');
  if (
    providerType !== 'mcp_approval_request'
    && rawItemName !== 'mcp_approval_request'
  ) {
    return null;
  }

  const serverId = getStringField(providerData, 'server_label') ?? 'MCP';
  const serviceName = formatServiceName(serverId);
  const toolName = getStringField(providerData, 'name')
    ?? getApprovalToolName(approvalItem);
  const mcpArgs = extractToolArgumentsFromRecord(providerData);
  const lines = [
    `Service: **${serviceName}**`,
    `MCP tool: \`${toolName}\``,
  ];
  appendArgumentLines(lines, formatPermissionArgumentLines(mcpArgs));

  return {
    displayName: `${serviceName} ${toolName}`,
    description: truncate(lines.join('\n'), 3900),
  };
}

export function getPermissionSummary(
  approvalItem: RunToolApprovalItem,
): PermissionSummary {
  const hostedMcpSummary = buildHostedMcpPermissionSummary(approvalItem);
  if (hostedMcpSummary) { return hostedMcpSummary; }

  const approvalArgs = parseApprovalArguments(approvalItem.arguments);
  if (approvalArgs) {
    const wrappedMcpSummary = buildWrappedMcpPermissionSummary(approvalArgs);
    if (wrappedMcpSummary) { return wrappedMcpSummary; }
  }

  return buildGenericPermissionSummary(approvalItem, approvalArgs);
}
