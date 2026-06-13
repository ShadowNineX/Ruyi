import { tool } from "@openai/agents";
import { z } from "zod";
import { env } from "../env";
import { toolLogger } from "../logger";
import { formatError } from "../utils/types";

const SCRAPECREATORS_BASE_URL = "https://api.scrapecreators.com";
const PINTEREST_BASE_URL = "https://www.pinterest.com";
const SCRAPECREATORS_TIMEOUT_MS = 20_000;
const MAX_PINTEREST_RESULTS = 20;
const DEFAULT_PINTEREST_RESULTS = 10;

type PinterestAction = "user_boards" | "board_pins" | "pin" | "search";

type UnknownRecord = Record<string, unknown>;

interface ScrapeCreatorsRequest {
  path: string;
  params: Record<string, string | boolean | undefined>;
}

function clampMaxResults(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return DEFAULT_PINTEREST_RESULTS;
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PINTEREST_RESULTS);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function getNumber(record: UnknownRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getRecord(record: UnknownRecord, key: string): UnknownRecord | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function getArray(record: UnknownRecord, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function toPinterestUrl(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("/")) return `${PINTEREST_BASE_URL}${value}`;
  return value;
}

function normalizePinterestHandle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("http")) return trimmed.replace(/^@/, "");

  const url = new URL(trimmed);
  const [handle] = url.pathname.split("/").filter(Boolean);
  if (!handle) {
    throw new Error("Pinterest profile URL did not include a username.");
  }
  return handle.replace(/^@/, "");
}

function normalizePinUrl(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return `${PINTEREST_BASE_URL}/pin/${trimmed}/`;
  return toPinterestUrl(trimmed) ?? trimmed;
}

function getImageUrlFromImageRecord(images: UnknownRecord | null): string | null {
  if (!images) return null;

  for (const key of ["orig", "originals", "736x", "564x", "474x", "236x", "170x"]) {
    const image = images[key];
    if (isRecord(image)) {
      const url = getString(image, "url");
      if (url) return url;
    }
    if (Array.isArray(image)) {
      const firstImage = image.find(isRecord);
      const url = firstImage ? getString(firstImage, "url") : null;
      if (url) return url;
    }
  }

  return null;
}

function getPinImageUrl(record: UnknownRecord): string | null {
  const imagesUrl = getImageUrlFromImageRecord(getRecord(record, "images"));
  if (imagesUrl) return imagesUrl;

  for (const key of [
    "imageSpec_orig",
    "imageSpec_736x",
    "imageSpec_564x",
    "imageSpec_474x",
    "imageSpec_236x",
    "image736x",
    "image564x",
    "image474x",
    "image236x",
  ]) {
    const image = getRecord(record, key);
    const url = image ? getString(image, "url") : null;
    if (url) return url;
  }

  return null;
}

function getBoardCoverUrl(record: UnknownRecord): string | null {
  return (
    getString(record, "image_cover_hd_url") ??
    getString(record, "image_cover_url") ??
    getImageUrlFromImageRecord(getRecord(record, "cover_images")) ??
    getImageUrlFromImageRecord(getRecord(record, "images"))
  );
}

function summarizeUser(record: UnknownRecord | null) {
  if (!record) return null;
  return {
    id: getString(record, "id") ?? getString(record, "entityId"),
    username: getString(record, "username"),
    fullName: getString(record, "full_name") ?? getString(record, "fullName"),
    followerCount:
      getNumber(record, "follower_count") ?? getNumber(record, "followerCount"),
    imageUrl:
      getString(record, "image_large_url") ??
      getString(record, "imageLargeUrl") ??
      getString(record, "image_medium_url") ??
      getString(record, "imageMediumUrl"),
    profileUrl: getString(record, "profileUrl"),
  };
}

function summarizeBoard(value: unknown) {
  if (!isRecord(value)) return null;

  return {
    id: getString(value, "id"),
    name: getString(value, "name"),
    description: getString(value, "description"),
    url: toPinterestUrl(getString(value, "url")),
    pinCount: getNumber(value, "pin_count") ?? getNumber(value, "pinCount"),
    followerCount:
      getNumber(value, "follower_count") ?? getNumber(value, "followerCount"),
    sectionCount:
      getNumber(value, "section_count") ?? getNumber(value, "sectionCount"),
    privacy: getString(value, "privacy"),
    isCollaborative: value.is_collaborative ?? value.isCollaborative ?? null,
    coverImageUrl: getBoardCoverUrl(value),
    owner: summarizeUser(getRecord(value, "owner")),
    createdAt: getString(value, "created_at") ?? getString(value, "createdAt"),
    updatedAt:
      getString(value, "board_order_modified_at") ??
      getString(value, "boardOrderModifiedAt"),
  };
}

function summarizePin(value: unknown) {
  if (!isRecord(value)) return null;

  return {
    id: getString(value, "id") ?? getString(value, "entityId"),
    title:
      getString(value, "title") ??
      getString(value, "grid_title") ??
      getString(value, "seoTitle"),
    description:
      getString(value, "description") ??
      getString(value, "closeupDescription") ??
      getString(value, "seoDescription"),
    url: toPinterestUrl(getString(value, "url") ?? getString(value, "seoUrl")),
    imageUrl: getPinImageUrl(value),
    sourceUrl: getString(value, "link") ?? getString(value, "richPinUrl"),
    domain: getString(value, "domain") ?? getString(value, "seoCanonicalDomain"),
    altText:
      getString(value, "auto_alt_text") ??
      getString(value, "seo_alt_text") ??
      getString(value, "seoAltText"),
    createdAt: getString(value, "created_at") ?? getString(value, "createdAt"),
    repinCount: getNumber(value, "repinCount"),
    shareCount: getNumber(value, "shareCount"),
    board: summarizeBoard(getRecord(value, "board")),
    pinner:
      summarizeUser(getRecord(value, "pinner")) ??
      summarizeUser(getRecord(value, "originPinner")),
  };
}

function buildApiUrl(request: ScrapeCreatorsRequest): URL {
  const url = new URL(request.path, SCRAPECREATORS_BASE_URL);
  for (const [key, value] of Object.entries(request.params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function callScrapeCreators(
  request: ScrapeCreatorsRequest,
): Promise<UnknownRecord> {
  if (!env.SCRAPECREATORS_API_KEY) {
    throw new Error(
      "ScrapeCreators is not configured. Set SCRAPECREATORS_API_KEY to use Pinterest tools.",
    );
  }

  const url = buildApiUrl(request);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "x-api-key": env.SCRAPECREATORS_API_KEY,
    },
    signal: AbortSignal.timeout(SCRAPECREATORS_TIMEOUT_MS),
  });

  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const detail = isRecord(body)
      ? (getString(body, "message") ?? getString(body, "error"))
      : null;
    throw new Error(
      `ScrapeCreators request failed with HTTP ${response.status}${
        detail ? `: ${detail}` : ""
      }`,
    );
  }

  if (!isRecord(body)) {
    throw new Error("ScrapeCreators returned an unexpected response shape.");
  }

  return body;
}

function requireValue(value: string | null, message: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function buildScrapeCreatorsRequest(input: {
  action: PinterestAction;
  handle: string | null;
  boardUrl: string | null;
  pinUrl: string | null;
  query: string | null;
  cursor: string | null;
}): ScrapeCreatorsRequest {
  const common = {
    cursor: input.cursor?.trim() || undefined,
    trim: true,
  };

  switch (input.action) {
    case "user_boards":
      return {
        path: "/v1/pinterest/user/boards",
        params: {
          handle: normalizePinterestHandle(
            requireValue(input.handle, "handle is required for user_boards."),
          ),
          trim: true,
        },
      };
    case "board_pins":
      return {
        path: "/v1/pinterest/board",
        params: {
          ...common,
          url: requireValue(input.boardUrl, "board_url is required for board_pins."),
        },
      };
    case "pin":
      return {
        path: "/v1/pinterest/pin",
        params: {
          url: normalizePinUrl(
            requireValue(input.pinUrl, "pin_url is required for pin."),
          ),
          trim: true,
        },
      };
    case "search":
      return {
        path: "/v1/pinterest/search",
        params: {
          ...common,
          query: requireValue(input.query, "query is required for search."),
        },
      };
  }
}

function summarizeResponse(
  action: PinterestAction,
  data: UnknownRecord,
  maxResults: number,
) {
  if (action === "user_boards") {
    return {
      boards: getArray(data, "boards")
        .map(summarizeBoard)
        .filter((board) => board !== null)
        .slice(0, maxResults),
    };
  }

  if (action === "pin") {
    return {
      pin: summarizePin(data),
    };
  }

  return {
    pins: getArray(data, "pins")
      .map(summarizePin)
      .filter((pin) => pin !== null)
      .slice(0, maxResults),
  };
}

function getSummaryResultCount(
  summary: ReturnType<typeof summarizeResponse>,
): number {
  if ("boards" in summary && Array.isArray(summary.boards)) {
    return summary.boards.length;
  }
  if ("pins" in summary && Array.isArray(summary.pins)) {
    return summary.pins.length;
  }
  return summary.pin ? 1 : 0;
}

export const pinterestTool = tool({
  name: "pinterest",
  description:
    "Read public Pinterest data through ScrapeCreators: list a user's boards, inspect board pins, fetch a pin, or search pins. Use this when the user asks about Pinterest boards/pins.",
  parameters: z.object({
    action: z
      .enum(["user_boards", "board_pins", "pin", "search"])
      .describe("Pinterest lookup to perform."),
    handle: z
      .string()
      .nullable()
      .describe(
        "Pinterest username or profile URL for user_boards, such as 'broadstbullycom' or a pinterest.com profile URL.",
      ),
    board_url: z
      .string()
      .nullable()
      .describe("Pinterest board URL for board_pins."),
    pin_url: z
      .string()
      .nullable()
      .describe("Pinterest pin URL or numeric pin ID for pin details."),
    query: z.string().nullable().describe("Search query for search."),
    cursor: z
      .string()
      .nullable()
      .describe("Pagination cursor returned by a previous board_pins/search call."),
    max_results: z
      .number()
      .nullable()
      .describe("Maximum boards or pins to return, 1-20. Defaults to 10."),
  }),
  execute: async ({
    action,
    handle,
    board_url,
    pin_url,
    query,
    cursor,
    max_results,
  }) => {
    try {
      const maxResults = clampMaxResults(max_results);
      const request = buildScrapeCreatorsRequest({
        action,
        handle,
        boardUrl: board_url,
        pinUrl: pin_url,
        query,
        cursor,
      });
      const data = await callScrapeCreators(request);
      const summary = summarizeResponse(action, data, maxResults);
      const nextCursor = getString(data, "cursor");

      toolLogger.info(
        {
          action,
          returned: getSummaryResultCount(summary),
          hasCursor: Boolean(nextCursor),
        },
        "Pinterest lookup complete",
      );

      return {
        provider: "scrapecreators",
        action,
        nextCursor,
        ...summary,
        note:
          "Results are public Pinterest data from ScrapeCreators. Use nextCursor for the next page when present.",
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error({ action, error: errorMessage }, "Pinterest lookup failed");
      return { error: "Pinterest lookup failed", details: errorMessage };
    }
  },
});
