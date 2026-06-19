import { z } from 'zod';
import { aiLogger } from '../logger';

const DEFAULT_VALUE_MAX_LENGTH = 180;
const DEFAULT_FIELD_MAX_LENGTH = 1000;
const DEFAULT_LINE_LIMIT = 8;

const ToolArgumentRecordSchema = z.record(z.string(), z.unknown());
const JsonStringSchema = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: `Value was not valid JSON: ${(error as Error).message}`,
    });
    return z.NEVER;
  }
});
const ToolArgumentsJsonSchema = JsonStringSchema.pipe(ToolArgumentRecordSchema);
const ToolArgumentsSchema = z.preprocess(
  value => value ?? {},
  z.union([ToolArgumentRecordSchema, ToolArgumentsJsonSchema]),
);

export interface ToolArgumentFormatOptions {
  lineLimit?: number;
  fieldMaxLength?: number;
  valueMaxLength?: number;
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
  const result = ToolArgumentsSchema.safeParse(value);
  if (result.success) { return result.data; }

  aiLogger.debug(
    {
      issues: result.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
    'Tool arguments did not match expected SDK shape',
  );
  return {};
}

export function parseNullableToolArguments(
  value: unknown,
): Record<string, unknown> | null {
  if (value === null || value === undefined) { return null; }
  return parseToolArguments(value);
}

function parseJsonArgumentValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) { return null; }

  const result = JsonStringSchema.safeParse(value);
  return result.success ? result.data : value;
}

function isToolArgumentRecord(
  value: unknown,
): value is Record<string, unknown> {
  return ToolArgumentRecordSchema.safeParse(value).success;
}

function isMeaningfulToolArgumentValue(value: unknown): boolean {
  if (value === null || value === undefined) { return false; }
  if (typeof value === 'string') { return value.trim().length > 0; }
  if (Array.isArray(value)) { return value.length > 0; }
  if (isToolArgumentRecord(value)) { return Object.keys(value).length > 0; }
  return true;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) { return value; }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function isPrimitiveValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  );
}

function formatPrimitiveValue(value: string | number | boolean): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ') : String(value);
}

function formatReadableArray(values: unknown[]): string {
  if (values.length === 0) { return 'none'; }
  if (values.length <= 3 && values.every(isPrimitiveValue)) {
    return values.map(value => formatToolArgumentValue(value)).join(', ');
  }
  return `${values.length} item(s)`;
}

function formatReadableRecord(record: Record<string, unknown>): string {
  const entries = Object.entries(record).filter(entry =>
    isMeaningfulToolArgumentValue(entry[1]),
  );
  if (entries.length === 0) { return 'fields: none'; }

  const simpleEntries = entries.filter(entry => isPrimitiveValue(entry[1]));
  if (simpleEntries.length > 0) {
    const preview = simpleEntries
      .slice(0, 4)
      .map(([key, value]) => `${key}: ${formatToolArgumentValue(value)}`)
      .join('; ');
    return simpleEntries.length > 4 ? `${preview}; ...` : preview;
  }

  return `fields: ${entries
    .slice(0, 6)
    .map(([key]) => key)
    .join(', ')}${entries.length > 6 ? ', ...' : ''}`;
}

function formatToolArgumentValue(
  value: unknown,
  maxLength = DEFAULT_VALUE_MAX_LENGTH,
): string {
  if (value === null) { return '`null`'; }
  if (value === undefined) { return '`undefined`'; }
  if (isPrimitiveValue(value)) {
    return truncate(formatPrimitiveValue(value), maxLength);
  }
  if (Array.isArray(value)) { return truncate(formatReadableArray(value), maxLength); }
  if (isToolArgumentRecord(value)) {
    return truncate(formatReadableRecord(value), maxLength);
  }

  return truncate(String(value), maxLength);
}

export function formatToolArgumentLines(
  args: Record<string, unknown>,
  options: ToolArgumentFormatOptions = {},
): string[] {
  const lineLimit = options.lineLimit ?? DEFAULT_LINE_LIMIT;
  const entries = Object.entries(args).filter(entry =>
    isMeaningfulToolArgumentValue(entry[1]),
  );
  const lines = entries
    .slice(0, lineLimit)
    .map(
      ([key, value]) =>
        `- \`${key}\`: ${formatToolArgumentValue(value, options.valueMaxLength)}`,
    );

  if (entries.length > lineLimit) {
    lines.push(`- ...and ${entries.length - lineLimit} more`);
  }

  return lines;
}

export function formatToolArgumentsMarkdown(
  args: Record<string, unknown>,
  options: ToolArgumentFormatOptions = {},
): string | null {
  const lines = formatToolArgumentLines(args, options);
  if (lines.length === 0) { return null; }

  const fieldMaxLength = options.fieldMaxLength ?? DEFAULT_FIELD_MAX_LENGTH;
  const keptLines: string[] = [];
  let length = 0;

  for (const line of lines) {
    const nextLength = length + line.length + 1;
    if (nextLength > fieldMaxLength) {
      keptLines.push('- ...');
      break;
    }
    keptLines.push(line);
    length = nextLength;
  }

  return keptLines.join('\n');
}

function getStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function argumentEntriesToRecord(
  entries: unknown,
): Record<string, unknown> | null {
  if (!Array.isArray(entries)) { return null; }

  const record: Record<string, unknown> = {};
  for (const entry of entries) {
    if (!isToolArgumentRecord(entry)) { continue; }

    const name = getStringField(entry, 'name');
    if (!name) { continue; }

    const jsonValue = entry.json_value;
    record[name]
      = jsonValue !== null && jsonValue !== undefined
        ? parseJsonArgumentValue(jsonValue)
        : entry.value;
  }

  return record;
}
