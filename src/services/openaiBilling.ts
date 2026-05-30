import { z } from "zod";
import { env } from "../env";

const OPENAI_COSTS_ENDPOINT = "https://api.openai.com/v1/organization/costs";
export const OPENAI_BILLING_OVERVIEW_URL =
  "https://platform.openai.com/settings/organization/billing/overview";

export interface OpenAICostTotal {
  currency: string;
  value: number;
}

export interface OpenAICostSummary {
  startTime: number;
  endTime: number;
  totals: OpenAICostTotal[];
}

export class OpenAIBillingError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenAIBillingError";
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

const openAICostsResponseSchema = z.looseObject({
    data: z.array(
      z
        .looseObject({
          results: z.array(
            z
              .looseObject({
                amount: z.object({
                  value: z.number(),
                  currency: z.string(),
                }),
              }),
          ),
        }),
    ),
  });

type OpenAICostsResponse = z.infer<typeof openAICostsResponseSchema>;

function getErrorMessage(body: unknown): string | null {
  const parsed = openAIErrorBodySchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.message ?? parsed.data.error?.message ?? null;
}

function getMonthStartUnixSeconds(now: Date): number {
  return Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000,
  );
}

function collectTotals(body: OpenAICostsResponse): OpenAICostTotal[] {
  const totals = new Map<string, number>();

  for (const bucket of body.data) {
    for (const result of bucket.results) {
      const amount = {
        value: result.amount.value,
        currency: result.amount.currency.toUpperCase(),
      };
      totals.set(
        amount.currency,
        (totals.get(amount.currency) ?? 0) + amount.value,
      );
    }
  }

  return [...totals.entries()].map(([currency, value]) => ({
    currency,
    value,
  }));
}

export async function fetchOpenAIMonthToDateCosts(
  now = new Date(),
): Promise<OpenAICostSummary> {
  if (!env.OPENAI_ADMIN_KEY) {
    throw new OpenAIBillingError("OPENAI_ADMIN_KEY is not configured");
  }

  const startTime = getMonthStartUnixSeconds(now);
  const endTime = Math.floor(now.getTime() / 1000);
  const url = new URL(OPENAI_COSTS_ENDPOINT);
  url.searchParams.set("start_time", String(startTime));
  url.searchParams.set("end_time", String(endTime));
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "31");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.OPENAI_ADMIN_KEY}`,
      "Content-Type": "application/json",
    },
  });

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new OpenAIBillingError(
      getErrorMessage(body) ?? `OpenAI billing request failed`,
      response.status,
    );
  }

  const parsed = openAICostsResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new OpenAIBillingError(
      "OpenAI billing response had an unexpected shape",
    );
  }

  return {
    startTime,
    endTime,
    totals: collectTotals(parsed.data),
  };
}
