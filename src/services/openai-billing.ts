import { z } from 'zod';
import { env } from '../env';

const OPENAI_COSTS_ENDPOINT = 'https://api.openai.com/v1/organization/costs';
const COSTS_PAGE_LIMIT = 31;
const MAX_COSTS_PAGES = 6;
export const OPENAI_BILLING_OVERVIEW_URL
  = 'https://platform.openai.com/settings/organization/billing/overview';

export interface OpenAICostTotal {
  currency: string;
  value: number;
}

export interface OpenAICostSummary {
  startTime: number;
  endTime: number;
  totals: OpenAICostTotal[];
  bucketCount: number;
  resultCount: number;
  skippedResultCount: number;
}

export class OpenAIBillingError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OpenAIBillingError';
    this.status = status;
  }
}

export function hasOpenAIBillingKey(): boolean {
  return Boolean(env.OPENAI_ADMIN_KEY);
}

const openAIErrorBodySchema = z.looseObject({
  message: z.string().optional(),
  error: z
    .looseObject({
      message: z.string().optional(),
    })
    .optional(),
});

interface CostCollection {
  totals: OpenAICostTotal[];
  bucketCount: number;
  resultCount: number;
  skippedResultCount: number;
}

interface CostsPage {
  buckets: unknown[];
  nextPage: string | null;
  hasMore: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function parseAmountValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) { return value; }
  if (typeof value !== 'string') { return null; }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCostResult(result: unknown): OpenAICostTotal | null {
  if (!isRecord(result) || !isRecord(result.amount)) { return null; }

  const value = parseAmountValue(result.amount.value);
  const currency = asString(result.amount.currency)?.trim().toUpperCase();
  if (value === null || !currency) { return null; }

  return { currency, value };
}

function parseCostsPage(body: unknown): CostsPage {
  if (!isRecord(body)) {
    throw new OpenAIBillingError('OpenAI billing response was not an object');
  }

  const buckets = asArray(body.data);
  if (!Array.isArray(body.data)) {
    throw new OpenAIBillingError('OpenAI billing response did not include a data array');
  }

  return {
    buckets,
    nextPage: asString(body.next_page),
    hasMore: asBoolean(body.has_more),
  };
}

function collectTotals(buckets: unknown[]): CostCollection {
  const totals = new Map<string, number>();
  let resultCount = 0;
  let skippedResultCount = 0;

  for (const bucket of buckets) {
    if (!isRecord(bucket)) {
      skippedResultCount += 1;
      continue;
    }

    for (const result of asArray(bucket.results)) {
      resultCount += 1;
      const parsed = parseCostResult(result);
      if (!parsed) {
        skippedResultCount += 1;
        continue;
      }

      totals.set(
        parsed.currency,
        (totals.get(parsed.currency) ?? 0) + parsed.value,
      );
    }
  }

  return {
    totals: [...totals.entries()].map(([currency, value]) => ({
      currency,
      value,
    })),
    bucketCount: buckets.length,
    resultCount,
    skippedResultCount,
  };
}

async function fetchCostsPage(url: URL): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${env.OPENAI_ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new OpenAIBillingError(
      getErrorMessage(body) ?? 'OpenAI billing request failed',
      response.status,
    );
  }

  return body;
}

function getErrorMessage(body: unknown): string | null {
  const parsed = openAIErrorBodySchema.safeParse(body);
  if (!parsed.success) { return null; }
  return parsed.data.message ?? parsed.data.error?.message ?? null;
}

function getMonthStartUnixSeconds(now: Date): number {
  return Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000,
  );
}

export async function fetchOpenAIMonthToDateCosts(
  now = new Date(),
): Promise<OpenAICostSummary> {
  if (!env.OPENAI_ADMIN_KEY) {
    throw new OpenAIBillingError('OPENAI_ADMIN_KEY is not configured');
  }

  const startTime = getMonthStartUnixSeconds(now);
  const endTime = Math.floor(now.getTime() / 1000);
  const url = new URL(OPENAI_COSTS_ENDPOINT);
  url.searchParams.set('start_time', String(startTime));
  url.searchParams.set('end_time', String(endTime));
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.set('limit', String(COSTS_PAGE_LIMIT));

  const buckets: unknown[] = [];
  let nextPage: string | null = null;
  let pageCount = 0;

  do {
    if (nextPage) { url.searchParams.set('page', nextPage); }
    const page = parseCostsPage(await fetchCostsPage(url));
    buckets.push(...page.buckets);
    nextPage = page.hasMore ? page.nextPage : null;
    pageCount += 1;
  } while (nextPage && pageCount < MAX_COSTS_PAGES);

  const collection = collectTotals(buckets);

  return {
    startTime,
    endTime,
    ...collection,
  };
}
