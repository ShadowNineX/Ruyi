import OpenAI from "openai";
import type {
  Response,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputText,
} from "openai/resources/responses/responses";
import { tool } from "@openai/agents";
import { z } from "zod";
import { env } from "../env";
import { toolLogger } from "../logger";
import { formatError, toolContextManager } from "../utils/types";
import { getCurrentToolConfigScope } from "../utils/discord-scope";
import {
  configManager,
  type ConfigScope,
  type SearchProvider,
} from "../config";

const OPENAI_PROVIDER = "openai" satisfies SearchProvider;
const TAVILY_PROVIDER = "tavily" satisfies SearchProvider;
const OPENAI_SOURCE_MINIMUM = 1;
const OPENAI_ANSWER_MIN_LENGTH = 40;
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

type SearchMode = "answer" | "research";

interface SearchSource {
  provider: SearchProvider;
  title?: string;
  url: string;
  snippet?: string;
  score?: number;
}

interface SearchImage {
  url: string;
  description?: string;
}

interface WebSearchResult {
  provider: SearchProvider;
  query: string;
  mode: SearchMode;
  answer: string | null;
  sources: SearchSource[];
  images?: SearchImage[];
  fallbackReason?: string;
  attempts: string[];
}

interface TavilyResult {
  title?: string;
  url: string;
  content?: string;
  score?: number;
  images?: SearchImage[];
}

interface TavilyResponse {
  query?: string;
  answer?: string | null;
  results?: TavilyResult[];
  images?: SearchImage[];
  response_time?: string;
  request_id?: string;
}

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

function clampMaxResults(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 5;
  return Math.min(Math.max(Math.trunc(value), 1), 10);
}

function uniqueProviders(providers: readonly SearchProvider[]): SearchProvider[] {
  return [...new Set(providers)];
}

function getProviderOrder(
  mode: SearchMode,
  scope: ConfigScope | null,
): SearchProvider[] {
  const preferredProvider = configManager.getSearchProvider(scope);
  if (mode === "research") {
    return uniqueProviders([
      TAVILY_PROVIDER,
      preferredProvider,
      OPENAI_PROVIDER,
    ]);
  }
  return uniqueProviders([
    preferredProvider,
    TAVILY_PROVIDER,
    OPENAI_PROVIDER,
  ]);
}

function resultHasGoodSources(result: WebSearchResult): boolean {
  if (result.provider !== "openai") return result.sources.length > 0;
  return (
    result.sources.length >= OPENAI_SOURCE_MINIMUM &&
    (result.answer?.trim().length ?? 0) >= OPENAI_ANSWER_MIN_LENGTH
  );
}

function isOutputMessage(item: ResponseOutputItem): item is ResponseOutputMessage {
  return item.type === "message";
}

function isOutputText(content: ResponseOutputMessage["content"][number]): content is ResponseOutputText {
  return content.type === "output_text";
}

function sourceKey(source: SearchSource): string {
  return source.url.toLowerCase();
}

function dedupeSources(sources: SearchSource[]): SearchSource[] {
  const seen = new Set<string>();
  const deduped: SearchSource[] = [];
  for (const source of sources) {
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(source);
  }
  return deduped;
}

function collectOpenAICitations(response: Response): SearchSource[] {
  const sources: SearchSource[] = [];

  for (const item of response.output) {
    if (!isOutputMessage(item)) continue;
    for (const content of item.content) {
      if (!isOutputText(content)) continue;
      for (const annotation of content.annotations) {
        if (annotation.type !== "url_citation") continue;
        sources.push({
          provider: "openai",
          title: annotation.title || undefined,
          url: annotation.url,
        });
      }
    }
  }

  return sources;
}

function collectOpenAIWebSearchSources(response: Response): SearchSource[] {
  const sources: SearchSource[] = [];
  for (const item of response.output) {
    if (item.type !== "web_search_call") continue;
    if (item.action.type !== "search") continue;
    for (const source of item.action.sources ?? []) {
      sources.push({ provider: "openai", url: source.url });
    }
  }
  return sources;
}

async function openAIWebSearch(
  query: string,
  mode: SearchMode,
  scope: ConfigScope | null,
): Promise<Omit<WebSearchResult, "attempts">> {
  const response = await openai.responses.create({
    model: configManager.getChatModel(scope),
    instructions:
      "Answer using current web information. Include concise citations in the response when sources are available.",
    input: query,
    include: ["web_search_call.action.sources"],
    tools: [
      {
        type: "web_search",
        search_context_size: mode === "research" ? "high" : "medium",
        user_location: {
          type: "approximate",
          country: "US",
        },
      },
    ],
    max_output_tokens: mode === "research" ? 1200 : 700,
    store: false,
  });

  const sources = dedupeSources([
    ...collectOpenAICitations(response),
    ...collectOpenAIWebSearchSources(response),
  ]);

  return {
    provider: "openai",
    query,
    mode,
    answer: response.output_text.trim() || null,
    sources,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTavilyImage(value: unknown): SearchImage | null {
  if (typeof value === "string" && value.trim()) return { url: value };
  if (!isRecord(value)) return null;
  const url = asOptionalString(value.url);
  if (!url) return null;
  return {
    url,
    description: asOptionalString(value.description),
  };
}

function parseTavilyImages(value: unknown): SearchImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const image = parseTavilyImage(item);
    return image ? [image] : [];
  });
}

function parseTavilyResult(value: unknown): TavilyResult | null {
  if (!isRecord(value)) return null;
  const url = asOptionalString(value.url);
  if (!url) return null;
  return {
    title: asOptionalString(value.title),
    url,
    content: asOptionalString(value.content),
    score: asOptionalNumber(value.score),
    images: parseTavilyImages(value.images),
  };
}

function parseTavilyResponse(value: unknown): TavilyResponse {
  if (!isRecord(value)) return {};
  const rawResults = Array.isArray(value.results) ? value.results : [];
  return {
    query: asOptionalString(value.query),
    answer:
      typeof value.answer === "string" || value.answer === null
        ? value.answer
        : undefined,
    results: rawResults.flatMap((result) => {
      const parsed = parseTavilyResult(result);
      return parsed ? [parsed] : [];
    }),
    images: parseTavilyImages(value.images),
    response_time: asOptionalString(value.response_time),
    request_id: asOptionalString(value.request_id),
  };
}

async function tavilySearch(
  query: string,
  mode: SearchMode,
  maxResults: number,
): Promise<Omit<WebSearchResult, "attempts">> {
  if (!env.TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY is not configured.");
  }

  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TAVILY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: mode === "research" ? "advanced" : "basic",
      max_results: maxResults,
      include_answer: mode === "research" ? "advanced" : true,
      include_raw_content: false,
      include_images: mode === "research",
      include_image_descriptions: mode === "research",
      include_favicon: true,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Tavily search failed with HTTP ${response.status}: ${detail}`);
  }

  const data = parseTavilyResponse(await response.json());
  const results = data.results ?? [];

  return {
    provider: "tavily",
    query: data.query ?? query,
    mode,
    answer: data.answer?.trim() || null,
    sources: results.map((result) => ({
      provider: "tavily",
      title: result.title,
      url: result.url,
      snippet: result.content,
      score: result.score,
    })),
    images: [
      ...(data.images ?? []),
      ...results.flatMap((result) => result.images ?? []),
    ],
  };
}

async function runProvider(
  provider: SearchProvider,
  query: string,
  mode: SearchMode,
  maxResults: number,
  scope: ConfigScope | null,
): Promise<Omit<WebSearchResult, "attempts">> {
  return provider === "openai"
    ? openAIWebSearch(query, mode, scope)
    : tavilySearch(query, mode, maxResults);
}

async function searchWeb(
  query: string,
  mode: SearchMode,
  maxResults: number,
  scope: ConfigScope | null,
): Promise<WebSearchResult> {
  const attempts: string[] = [];
  let fallbackReason: string | undefined;
  let weakResult: Omit<WebSearchResult, "attempts"> | null = null;

  for (const provider of getProviderOrder(mode, scope)) {
    try {
      const result = await runProvider(
        provider,
        query,
        mode,
        maxResults,
        scope,
      );
      attempts.push(`${provider}:ok`);
      if (resultHasGoodSources({ ...result, attempts })) {
        return { ...result, attempts, fallbackReason };
      }

      weakResult = result;
      fallbackReason = `${provider} returned weak or missing sources`;
      attempts.push(`${provider}:weak_sources`);
    } catch (error) {
      const errorMessage = formatError(error);
      attempts.push(`${provider}:error:${errorMessage}`);
      fallbackReason = `${provider} failed: ${errorMessage}`;
      toolLogger.warn(
        { provider, mode, query, error: errorMessage },
        "Web search provider failed",
      );
    }
  }

  if (weakResult) {
    return { ...weakResult, attempts, fallbackReason };
  }

  throw new Error(`All web search providers failed. Attempts: ${attempts.join("; ")}`);
}

export const webSearchTool = tool({
  name: "web_search",
  description:
    "Search the web using OpenAI Web Search for direct current-information answers, with Tavily fallback. Use mode=research for sources, links, broad research, comparisons, or finding pages.",
  parameters: z.object({
    query: z.string().min(1).describe("The web search query."),
    mode: z
      .enum(["answer", "research"])
      .nullable()
      .describe(
        "Use answer for normal current-info questions. Use research when the user asks for sources, links, comparisons, broad research, or pages to inspect.",
      ),
    max_results: z
      .number()
      .int()
      .nullable()
      .describe("Maximum Tavily results to return when Tavily is used. Defaults to 5; capped at 10."),
  }),
  execute: async ({ query, mode, max_results }) => {
    const scope = getCurrentToolConfigScope();
    const budgetDecision = toolContextManager.consumeToolCall("web_search");
    if (!budgetDecision.allowed) {
      return toolContextManager.budgetDeniedResult(budgetDecision);
    }

    const searchMode = mode ?? "answer";
    const maxResults = toolContextManager.isReverseImageWorkflowActive()
      ? Math.min(clampMaxResults(max_results), 3)
      : clampMaxResults(max_results);

    try {
      const result = await searchWeb(
        query,
        searchMode,
        maxResults,
        scope,
      );
      toolLogger.info(
        {
          provider: result.provider,
          mode: searchMode,
          sourceCount: result.sources.length,
          fallbackReason: result.fallbackReason,
        },
        "Web search complete",
      );
      return {
        success: true,
        ...result,
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { query, mode: searchMode, error: errorMessage },
        "Web search failed",
      );
      return { error: "Web search failed", details: errorMessage };
    }
  },
});
