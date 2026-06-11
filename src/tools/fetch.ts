import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { tool } from "@openai/agents";
import { JSDOM, VirtualConsole } from "jsdom";
import { z } from "zod";
import { toolLogger } from "../logger";
import { formatError } from "../utils/types";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TEXT_CHARS = 8_000;
const MAX_TEXT_CHARS = 12_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const HTML_FALLBACK_REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "nav",
  "aside",
  "form",
  "button",
  "select",
  "textarea",
  "header",
  "footer",
].join(",");

interface FetchResponse {
  response: Response;
  finalUrl: string;
  redirectCount: number;
}

interface ReadTextResult {
  text: string;
  bytesRead: number;
  byteTruncated: boolean;
}

interface PreparedTextResult {
  text: string;
  charTruncated: boolean;
  extractionMethod: "raw" | "readability" | "dom_text" | "plain_text";
  title?: string | null;
  excerpt?: string | null;
  byline?: string | null;
  siteName?: string | null;
  lang?: string | null;
  publishedTime?: string | null;
}

function clampMaxChars(value: number | null): number {
  return Math.min(
    Math.max(Math.round(value ?? DEFAULT_TEXT_CHARS), 1),
    MAX_TEXT_CHARS,
  );
}

function parseHttpUrl(value: string): URL {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be fetched");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  return url;
}

function parseIPv4(value: string): number[] | null {
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return parts;
}

function isBlockedIPv4(value: string): boolean {
  const parts = parseIPv4(value);
  if (!parts) return true;

  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIPv6(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    return isBlockedIp(normalized.slice("::ffff:".length));
  }

  const firstSegment = normalized.split(":")[0] ?? "";
  const first = Number.parseInt(firstSegment || "0", 16);
  if (Number.isNaN(first)) return true;

  return (
    normalized.startsWith("2001:db8") ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  );
}

function isBlockedIp(value: string): boolean {
  const ipVersion = isIP(value);
  if (ipVersion === 4) return isBlockedIPv4(value);
  if (ipVersion === 6) return isBlockedIPv6(value);
  return true;
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "ip6-localhost"
  ) {
    throw new Error("Localhost URLs are not allowed");
  }

  if (isIP(normalized) !== 0) {
    if (isBlockedIp(normalized)) {
      throw new Error("Private, local, or reserved IP URLs are not allowed");
    }
    return;
  }

  const addresses = await lookup(normalized, { all: true });
  if (addresses.length === 0) {
    throw new Error("Could not resolve URL hostname");
  }

  const blocked = addresses.find((address) => isBlockedIp(address.address));
  if (blocked) {
    throw new Error("URL resolves to a private, local, or reserved address");
  }
}

async function validateFetchUrl(value: string): Promise<URL> {
  const url = parseHttpUrl(value);
  await assertPublicHostname(url.hostname);
  return url;
}

function timeoutSignal(timeoutMs: number): {
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

async function fetchOnce(url: URL): Promise<Response> {
  await validateFetchUrl(url.toString());
  const { controller, timeout } = timeoutSignal(FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8",
        "User-Agent": USER_AGENT,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRedirects(url: string): Promise<FetchResponse> {
  let currentUrl = await validateFetchUrl(url);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await fetchOnce(currentUrl);
    const location = response.headers.get("location");
    const isRedirect = response.status >= 300 && response.status < 400;

    if (!isRedirect || !location) {
      return {
        response,
        finalUrl: currentUrl.toString(),
        redirectCount,
      };
    }

    currentUrl = await validateFetchUrl(new URL(location, currentUrl).toString());
  }

  throw new Error(`Too many redirects; maximum is ${MAX_REDIRECTS}`);
}

function isTextualContentType(contentType: string): boolean {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mediaType) return true;
  if (mediaType.startsWith("text/")) return true;
  if (mediaType.endsWith("+json") || mediaType.endsWith("+xml")) return true;

  return [
    "application/json",
    "application/javascript",
    "application/x-javascript",
    "application/xml",
    "application/xhtml+xml",
    "application/rss+xml",
    "application/atom+xml",
    "image/svg+xml",
  ].includes(mediaType);
}

async function readResponseText(response: Response): Promise<ReadTextResult> {
  if (!response.body) {
    return { text: "", bytesRead: 0, byteTruncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let byteTruncated = false;

  while (bytesRead < MAX_RESPONSE_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    const remaining = MAX_RESPONSE_BYTES - bytesRead;
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      bytesRead += remaining;
      byteTruncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(value);
    bytesRead += value.byteLength;
  }

  if (bytesRead >= MAX_RESPONSE_BYTES && !byteTruncated) {
    byteTruncated = true;
    await reader.cancel();
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    bytesRead,
    byteTruncated,
  };
}

function normalizeWhitespace(value: string): string {
  let result = "";
  let pendingSpace = false;
  let pendingNewlines = 0;

  for (const char of value) {
    if (char === " " || char === "\t") {
      pendingSpace = true;
      continue;
    }

    if (char === "\n") {
      pendingSpace = false;
      pendingNewlines = Math.min(pendingNewlines + 1, 2);
      continue;
    }

    if (pendingNewlines > 0) {
      result = result.trimEnd();
      result += pendingNewlines === 1 ? "\n" : "\n\n";
      pendingNewlines = 0;
      pendingSpace = false;
    } else if (pendingSpace && result.length > 0) {
      result += " ";
      pendingSpace = false;
    }

    result += char;
  }

  return result.trim();
}

function normalizeText(value: string): string {
  return normalizeWhitespace(value.replaceAll("\r", ""));
}

function parseHtmlDocument(html: string, finalUrl: string): Document {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    url: finalUrl,
    contentType: "text/html",
    virtualConsole,
  });
  return dom.window.document;
}

function removeNoisyFallbackNodes(document: Document): void {
  document.querySelectorAll(HTML_FALLBACK_REMOVE_SELECTORS).forEach((node) => {
    node.remove();
  });
}

function getFallbackDocumentText(document: Document): string {
  removeNoisyFallbackNodes(document);
  return document.body?.textContent ?? document.documentElement.textContent ?? "";
}

function extractReadableHtmlText(
  html: string,
  finalUrl: string,
): Omit<PreparedTextResult, "charTruncated"> {
  const document = parseHtmlDocument(html, finalUrl);
  const readerable = isProbablyReaderable(document, {
    minContentLength: 80,
    minScore: 12,
  });
  const article = new Readability(document.cloneNode(true) as Document, {
    charThreshold: 200,
  }).parse();
  const articleText = normalizeText(article?.textContent ?? "");

  if (articleText && (readerable || articleText.length >= 200)) {
    return {
      text: articleText,
      extractionMethod: "readability",
      title: article?.title ?? null,
      excerpt: article?.excerpt ?? null,
      byline: article?.byline ?? null,
      siteName: article?.siteName ?? null,
      lang: article?.lang ?? null,
      publishedTime: article?.publishedTime ?? null,
    };
  }

  const fallbackText = normalizeText(getFallbackDocumentText(document));
  return {
    text: fallbackText,
    extractionMethod: "dom_text",
  };
}

function prepareText(
  text: string,
  contentType: string,
  raw: boolean,
  maxChars: number,
  finalUrl: string,
): PreparedTextResult {
  let prepared: Omit<PreparedTextResult, "charTruncated">;
  if (raw) {
    prepared = {
      text: text.trim(),
      extractionMethod: "raw",
    };
  } else if (contentType.includes("html")) {
    prepared = extractReadableHtmlText(text, finalUrl);
  } else {
    prepared = {
      text: normalizeText(text),
      extractionMethod: "plain_text",
    };
  }

  if (prepared.text.length <= maxChars) {
    return { ...prepared, charTruncated: false };
  }

  return {
    ...prepared,
    text: prepared.text.slice(0, maxChars),
    charTruncated: true,
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

export const fetchUrlTool = tool({
  name: "fetch_url",
  description:
    "Fetch text content from a specific public HTTP/HTTPS URL. Use this when the user gives a URL and asks you to read, summarize, inspect, or quote from that page. For finding URLs, use web search first.",
  parameters: z.object({
    url: z
      .string()
      .min(1)
      .max(2048)
      .describe("The public http or https URL to fetch."),
    max_chars: z
      .number()
      .nullable()
      .describe(
        `Maximum response text characters to return. Default ${DEFAULT_TEXT_CHARS}, max ${MAX_TEXT_CHARS}.`,
      ),
    raw: z
      .boolean()
      .nullable()
      .describe("If true, return raw text/HTML instead of cleaned page text."),
    include_headers: z
      .boolean()
      .nullable()
      .describe("Whether to include response headers. Defaults to false."),
  }),
  timeoutMs: FETCH_TIMEOUT_MS + 5_000,
  timeoutBehavior: "error_as_result",
  execute: async ({ url, max_chars, raw, include_headers }) => {
    const maxChars = clampMaxChars(max_chars);

    try {
      toolLogger.info({ url, maxChars }, "Fetching URL");

      const { response, finalUrl, redirectCount } = await fetchWithRedirects(url);
      const contentType = response.headers.get("content-type") ?? "";
      const contentLength = response.headers.get("content-length");
      const baseResult = {
        success: true,
        requestedUrl: url,
        finalUrl,
        status: response.status,
        ok: response.ok,
        redirected: redirectCount > 0,
        redirectCount,
        contentType: contentType || null,
        contentLength: contentLength ? Number.parseInt(contentLength, 10) : null,
        headers: include_headers ? headersToRecord(response.headers) : undefined,
      };

      if (!isTextualContentType(contentType)) {
        return {
          ...baseResult,
          text: null,
          note: "Response is not a recognized text content type, so the body was not returned.",
        };
      }

      const body = await readResponseText(response);
      const prepared = prepareText(
        body.text,
        contentType.toLowerCase(),
        raw === true,
        maxChars,
        finalUrl,
      );

      return {
        ...baseResult,
        bytesRead: body.bytesRead,
        byteTruncated: body.byteTruncated,
        charTruncated: prepared.charTruncated,
        extractionMethod: prepared.extractionMethod,
        title: prepared.title,
        excerpt: prepared.excerpt,
        byline: prepared.byline,
        siteName: prepared.siteName,
        lang: prepared.lang,
        publishedTime: prepared.publishedTime,
        text: prepared.text,
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error({ url, error: errorMessage }, "URL fetch failed");
      return { error: "Failed to fetch URL", details: errorMessage };
    }
  },
});
