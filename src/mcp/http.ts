import { z } from "zod";

export type AuthenticatedFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

const HeaderTupleSchema = z.tuple([z.string(), z.string()]);
const HeaderEntriesSchema = z.array(HeaderTupleSchema);
const HeaderRecordSchema = z.record(z.string(), z.string());

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers) return {};

  if (headers instanceof Headers) {
    const normalized: Record<string, string> = {};
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }

  const entries = HeaderEntriesSchema.safeParse(headers);
  if (entries.success) return Object.fromEntries(entries.data);

  const record = HeaderRecordSchema.safeParse(headers);
  if (record.success) return record.data;

  return {};
}

export function createAuthenticatedFetch(
  headers: Record<string, string>,
): AuthenticatedFetch {
  return async (input, init) =>
    fetch(input, {
      ...init,
      headers: {
        ...headers,
        ...normalizeHeaders(init?.headers),
      },
    });
}
