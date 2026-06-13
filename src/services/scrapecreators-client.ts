import { z } from "zod";
import { env } from "../env";
import { formatError } from "../utils/types";

const SCRAPECREATORS_BASE_URL = "https://api.scrapecreators.com";
const SCRAPECREATORS_TIMEOUT_MS = 20_000;

export const SCRAPECREATORS_DASHBOARD_URL = "https://app.scrapecreators.com/";

type ScrapeCreatorsParamValue = string | number | boolean | undefined;

interface ScrapeCreatorsFetchOptions {
  path: string;
  params?: Record<string, ScrapeCreatorsParamValue>;
  notConfiguredMessage: string;
  requestFailedMessage: string;
  nonJsonLogMessage: string;
  logDebug?: (context: Record<string, unknown>, message: string) => void;
}

const scrapeCreatorsErrorSchema = z.looseObject({
  message: z.string().optional(),
  error: z.string().optional(),
});

export class ScrapeCreatorsApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ScrapeCreatorsApiError";
    this.status = status;
  }
}

export function hasScrapeCreatorsApiKey(): boolean {
  return Boolean(env.SCRAPECREATORS_API_KEY);
}

function buildScrapeCreatorsUrl(
  path: string,
  params: Record<string, ScrapeCreatorsParamValue> = {},
): URL {
  const url = new URL(path, SCRAPECREATORS_BASE_URL);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  return url;
}

function getScrapeCreatorsErrorMessage(body: unknown): string | null {
  const parsed = scrapeCreatorsErrorSchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.message ?? parsed.data.error ?? null;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseScrapeCreatorsSchema<T>(
  schema: z.ZodType<T>,
  body: unknown,
  context: string,
): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;

  throw new ScrapeCreatorsApiError(
    `ScrapeCreators ${context} response had an unexpected shape: ${formatZodIssues(parsed.error)}`,
  );
}

async function parseJsonResponse(
  response: Response,
  options: Pick<ScrapeCreatorsFetchOptions, "logDebug" | "nonJsonLogMessage">,
): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    options.logDebug?.(
      { status: response.status, error: formatError(error) },
      options.nonJsonLogMessage,
    );
    return null;
  }
}

export async function fetchScrapeCreatorsJson(
  options: ScrapeCreatorsFetchOptions,
): Promise<unknown> {
  if (!env.SCRAPECREATORS_API_KEY) {
    throw new ScrapeCreatorsApiError(options.notConfiguredMessage);
  }

  const response = await fetch(
    buildScrapeCreatorsUrl(options.path, options.params),
    {
      headers: {
        Accept: "application/json",
        "x-api-key": env.SCRAPECREATORS_API_KEY,
      },
      signal: AbortSignal.timeout(SCRAPECREATORS_TIMEOUT_MS),
    },
  );
  const body = await parseJsonResponse(response, options);

  if (!response.ok) {
    throw new ScrapeCreatorsApiError(
      getScrapeCreatorsErrorMessage(body) ?? options.requestFailedMessage,
      response.status,
    );
  }

  return body;
}

export async function fetchScrapeCreatorsParsed<T>(
  schema: z.ZodType<T>,
  options: ScrapeCreatorsFetchOptions,
): Promise<T> {
  const body = await fetchScrapeCreatorsJson(options);
  return parseScrapeCreatorsSchema(schema, body, options.path);
}
