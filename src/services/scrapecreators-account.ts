import { z } from 'zod';
import { botLogger } from '../logger';
import {
  fetchScrapeCreatorsParsed,
  hasScrapeCreatorsApiKey,
} from './scrapecreators-client';

export {
  SCRAPECREATORS_DASHBOARD_URL,
  ScrapeCreatorsApiError,
} from './scrapecreators-client';

const DEFAULT_PINTEREST_ENDPOINT_FILTER = '/v1/pinterest';

const creditBalanceSchema = z.looseObject({
  creditCount: z.coerce.number(),
});

const apiUsageEntrySchema = z.looseObject({
  id: z.string().optional(),
  endpoint: z.string(),
  status_code: z.coerce.number().optional(),
  duration_ms: z.coerce.number().optional(),
  duration_secs: z.coerce.number().optional(),
  success: z.boolean().optional(),
  response_time: z.string().optional(),
  request_time: z.string().optional(),
  http_method: z.string().optional(),
  created_at: z.string().optional(),
  credits: z.coerce.number().optional(),
  request_payload: z.unknown().optional(),
});

const dailyUsageEntrySchema = z.looseObject({
  usage_date: z.string(),
  total_credits: z.coerce.number(),
  request_count: z.coerce.number(),
});

const apiUsageSchema = z.array(apiUsageEntrySchema);
const dailyUsageSchema = z.array(dailyUsageEntrySchema);

export interface ScrapeCreatorsApiUsageFilters {
  page?: number;
  endpoint?: string;
  statusCode?: number;
}

export interface ScrapeCreatorsCreditBalance {
  creditCount: number;
}

export type ScrapeCreatorsApiUsageEntry = z.infer<typeof apiUsageEntrySchema>;
export type ScrapeCreatorsDailyUsageEntry = z.infer<
  typeof dailyUsageEntrySchema
>;

export function hasScrapeCreatorsAccountKey(): boolean {
  return hasScrapeCreatorsApiKey();
}

async function fetchAccountEndpoint<T>(
  path: string,
  schema: z.ZodType<T>,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  return fetchScrapeCreatorsParsed(schema, {
    path,
    params,
    notConfiguredMessage: 'SCRAPECREATORS_API_KEY is not configured',
    requestFailedMessage: 'ScrapeCreators account request failed',
    nonJsonLogMessage: 'ScrapeCreators account response body was not JSON',
    logDebug: (context, message) => botLogger.debug(context, message),
  });
}

export async function fetchScrapeCreatorsCreditBalance(): Promise<ScrapeCreatorsCreditBalance> {
  return fetchAccountEndpoint(
    '/v1/account/credit-balance',
    creditBalanceSchema,
  );
}

export async function fetchScrapeCreatorsApiUsage(
  filters: ScrapeCreatorsApiUsageFilters = {},
): Promise<ScrapeCreatorsApiUsageEntry[]> {
  return fetchAccountEndpoint('/v1/account/get-api-usage', apiUsageSchema, {
    page: filters.page,
    endpoint: filters.endpoint ?? DEFAULT_PINTEREST_ENDPOINT_FILTER,
    statusCode: filters.statusCode,
  });
}

export async function fetchScrapeCreatorsDailyUsage(): Promise<
  ScrapeCreatorsDailyUsageEntry[]
> {
  return fetchAccountEndpoint(
    '/v1/account/get-daily-usage-count',
    dailyUsageSchema,
  );
}
