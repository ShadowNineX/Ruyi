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
const MAX_PINTEREST_RECOMMENDED_FOLLOW_UPS = 10;

type PinterestAction = "user_boards" | "board_pins" | "pin" | "search";

type PinterestPinSummary = NonNullable<ReturnType<typeof summarizePin>>;
type PinterestResponseSummary =
  | { boards: PinterestBoardSummary[] }
  | { pin: PinterestPinSummary }
  | { pins: PinterestPinSummary[] };
type PinterestBoardSummary = ReturnType<typeof summarizeBoard>;

interface ScrapeCreatorsRequest {
  path: string;
  params: Record<string, string | boolean | undefined>;
}

const maybeStringSchema = z.string().nullish();
const maybeNumberSchema = z.number().nullish();
const maybeBooleanSchema = z.boolean().nullish();

const pinterestImageAssetSchema = z.looseObject({
    url: maybeStringSchema,
    width: maybeNumberSchema,
    height: maybeNumberSchema,
});

const pinterestImageValueSchema = z.union([
  z.string(),
  pinterestImageAssetSchema,
  z.array(pinterestImageAssetSchema),
]);
const pinterestImageMapSchema = z.record(z.string(), pinterestImageValueSchema);
const maybePinterestImageValueSchema = pinterestImageValueSchema.nullish();

const pinterestUserSchema = z.looseObject({
    id: maybeStringSchema,
    entityId: maybeStringSchema,
    username: maybeStringSchema,
    full_name: maybeStringSchema,
    fullName: maybeStringSchema,
    follower_count: maybeNumberSchema,
    followerCount: maybeNumberSchema,
    image_large_url: maybeStringSchema,
    imageLargeUrl: maybeStringSchema,
    image_medium_url: maybeStringSchema,
    imageMediumUrl: maybeStringSchema,
    profileUrl: maybeStringSchema,
});

const pinterestBoardSchema = z.looseObject({
    id: maybeStringSchema,
    name: maybeStringSchema,
    description: maybeStringSchema,
    url: maybeStringSchema,
    pin_count: maybeNumberSchema,
    pinCount: maybeNumberSchema,
    follower_count: maybeNumberSchema,
    followerCount: maybeNumberSchema,
    section_count: maybeNumberSchema,
    sectionCount: maybeNumberSchema,
    privacy: maybeStringSchema,
    is_collaborative: maybeBooleanSchema,
    isCollaborative: maybeBooleanSchema,
    image_cover_hd_url: maybeStringSchema,
    image_cover_url: maybeStringSchema,
    cover_images: pinterestImageMapSchema.nullish(),
    images: pinterestImageMapSchema.nullish(),
    owner: pinterestUserSchema.nullish(),
    created_at: maybeStringSchema,
    createdAt: maybeStringSchema,
    board_order_modified_at: maybeStringSchema,
    boardOrderModifiedAt: maybeStringSchema,
});

const pinterestPinSchema = z.looseObject({
    id: maybeStringSchema,
    entityId: maybeStringSchema,
    title: maybeStringSchema,
    grid_title: maybeStringSchema,
    seoTitle: maybeStringSchema,
    description: maybeStringSchema,
    closeupDescription: maybeStringSchema,
    seoDescription: maybeStringSchema,
    url: maybeStringSchema,
    seoUrl: maybeStringSchema,
    images: pinterestImageMapSchema.nullish(),
    imageSpec_orig: maybePinterestImageValueSchema,
    imageSpec_original: maybePinterestImageValueSchema,
    imageSpec_736x: maybePinterestImageValueSchema,
    imageSpec_600x315: maybePinterestImageValueSchema,
    imageSpec_564x: maybePinterestImageValueSchema,
    imageSpec_474x: maybePinterestImageValueSchema,
    imageSpec_236x: maybePinterestImageValueSchema,
    imageSpec_170x: maybePinterestImageValueSchema,
    image736x: maybePinterestImageValueSchema,
    image564x: maybePinterestImageValueSchema,
    image474x: maybePinterestImageValueSchema,
    image236x: maybePinterestImageValueSchema,
    image_url: maybeStringSchema,
    imageUrl: maybeStringSchema,
    image: maybePinterestImageValueSchema,
    thumbnail: maybePinterestImageValueSchema,
    thumbnailUrl: maybeStringSchema,
    thumbnail_url: maybeStringSchema,
    link: maybeStringSchema,
    richPinUrl: maybeStringSchema,
    domain: maybeStringSchema,
    seoCanonicalDomain: maybeStringSchema,
    auto_alt_text: maybeStringSchema,
    seo_alt_text: maybeStringSchema,
    seoAltText: maybeStringSchema,
    created_at: maybeStringSchema,
    createdAt: maybeStringSchema,
    repinCount: maybeNumberSchema,
    shareCount: maybeNumberSchema,
    board: pinterestBoardSchema.nullish(),
    pinner: pinterestUserSchema.nullish(),
    originPinner: pinterestUserSchema.nullish(),
});

const pinterestBoardsResponseSchema = z.looseObject({
    success: z.boolean().optional(),
    boards: z.array(pinterestBoardSchema).default([]),
});

const pinterestPinsResponseSchema = z.looseObject({
    success: z.boolean().optional(),
    pins: z.array(pinterestPinSchema).default([]),
    cursor: maybeStringSchema,
});

const scrapeCreatorsErrorSchema = z.looseObject({
    message: maybeStringSchema,
    error: maybeStringSchema,
});

type PinterestImageValue = z.infer<typeof pinterestImageValueSchema>;
type PinterestImageMap = z.infer<typeof pinterestImageMapSchema>;
type PinterestUser = z.infer<typeof pinterestUserSchema>;
type PinterestBoard = z.infer<typeof pinterestBoardSchema>;
type PinterestPin = z.infer<typeof pinterestPinSchema>;
type PinterestParsedResponse =
  | {
      action: "user_boards";
      boards: PinterestBoard[];
      cursor: null;
    }
  | {
      action: "board_pins" | "search";
      pins: PinterestPin[];
      cursor: string | null;
    }
  | {
      action: "pin";
      pin: PinterestPin;
      cursor: null;
    };

const PINTEREST_IMAGE_KEYS = [
  "orig",
  "original",
  "originals",
  "1200x",
  "736x",
  "600x315",
  "564x",
  "474x",
  "236x",
  "222x",
  "170x",
] as const;

function clampMaxResults(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return DEFAULT_PINTEREST_RESULTS;
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PINTEREST_RESULTS);
}

function getImageHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:"
    ? url.toString()
    : null;
}

function toPinterestUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("/")) return `${PINTEREST_BASE_URL}${value}`;
  return value;
}

function normalizePinterestHandle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("http")) return trimmed.replace(/^@/, "");

  const url = new URL(trimmed);
  const handle = url.pathname.split("/").find(Boolean);
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

function getImageUrlFromImageValue(
  value: PinterestImageValue | null | undefined,
): string | null {
  if (!value) return null;
  if (typeof value === "string") return getImageHttpUrl(value);

  if (Array.isArray(value)) {
    for (const image of value) {
      const url = getImageHttpUrl(image.url);
      if (url) return url;
    }
    return null;
  }

  return getImageHttpUrl(value.url);
}

function getImageUrlFromImageRecord(
  images: PinterestImageMap | null | undefined,
): string | null {
  if (!images) return null;

  for (const key of PINTEREST_IMAGE_KEYS) {
    const url = getImageUrlFromImageValue(images[key]);
    if (url) return url;
  }

  for (const image of Object.values(images)) {
    const url = getImageUrlFromImageValue(image);
    if (url) return url;
  }

  return null;
}

function getPinImageUrl(pin: PinterestPin): string | null {
  const imagesUrl = getImageUrlFromImageRecord(pin.images);
  if (imagesUrl) return imagesUrl;

  const imageValues: Array<PinterestImageValue | null | undefined> = [
    pin.imageSpec_orig,
    pin.imageSpec_original,
    pin.imageSpec_736x,
    pin.imageSpec_600x315,
    pin.imageSpec_564x,
    pin.imageSpec_474x,
    pin.imageSpec_236x,
    pin.imageSpec_170x,
    pin.image736x,
    pin.image564x,
    pin.image474x,
    pin.image236x,
    pin.image_url,
    pin.imageUrl,
    pin.image,
    pin.thumbnail,
    pin.thumbnailUrl,
    pin.thumbnail_url,
  ];

  for (const imageValue of imageValues) {
    const url = getImageUrlFromImageValue(imageValue);
    if (url) return url;
  }

  return null;
}

function getBoardCoverUrl(board: PinterestBoard): string | null {
  return (
    getImageHttpUrl(board.image_cover_hd_url) ??
    getImageHttpUrl(board.image_cover_url) ??
    getImageUrlFromImageRecord(board.cover_images) ??
    getImageUrlFromImageRecord(board.images)
  );
}

function summarizeUser(user: PinterestUser | null | undefined) {
  if (!user) return null;
  return {
    id: user.id ?? user.entityId ?? null,
    username: user.username ?? null,
    fullName: user.full_name ?? user.fullName ?? null,
    followerCount: user.follower_count ?? user.followerCount ?? null,
    imageUrl:
      getImageHttpUrl(user.image_large_url) ??
      getImageHttpUrl(user.imageLargeUrl) ??
      getImageHttpUrl(user.image_medium_url) ??
      getImageHttpUrl(user.imageMediumUrl),
    profileUrl: toPinterestUrl(user.profileUrl),
  };
}

function summarizeBoard(board: PinterestBoard) {
  return {
    id: board.id ?? null,
    name: board.name ?? null,
    description: board.description ?? null,
    url: toPinterestUrl(board.url),
    pinCount: board.pin_count ?? board.pinCount ?? null,
    followerCount: board.follower_count ?? board.followerCount ?? null,
    sectionCount: board.section_count ?? board.sectionCount ?? null,
    privacy: board.privacy ?? null,
    isCollaborative: board.is_collaborative ?? board.isCollaborative ?? null,
    coverImageUrl: getBoardCoverUrl(board),
    owner: summarizeUser(board.owner),
    createdAt: board.created_at ?? board.createdAt ?? null,
    updatedAt: board.board_order_modified_at ?? board.boardOrderModifiedAt ?? null,
  };
}

function summarizePin(pin: PinterestPin) {
  return {
    id: pin.id ?? pin.entityId ?? null,
    title: pin.title ?? pin.grid_title ?? pin.seoTitle ?? null,
    description:
      pin.description ?? pin.closeupDescription ?? pin.seoDescription ?? null,
    url: toPinterestUrl(pin.url ?? pin.seoUrl),
    imageUrl: getPinImageUrl(pin),
    sourceUrl: pin.link ?? pin.richPinUrl ?? null,
    domain: pin.domain ?? pin.seoCanonicalDomain ?? null,
    altText: pin.auto_alt_text ?? pin.seo_alt_text ?? pin.seoAltText ?? null,
    createdAt: pin.created_at ?? pin.createdAt ?? null,
    repinCount: pin.repinCount ?? null,
    shareCount: pin.shareCount ?? null,
    board: pin.board ? summarizeBoard(pin.board) : null,
    pinner: summarizeUser(pin.pinner) ?? summarizeUser(pin.originPinner),
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
): Promise<unknown> {
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

  const body = await parseJsonResponse(response);
  if (!response.ok) {
    const detail = getScrapeCreatorsErrorDetail(body);
    throw new Error(
      `ScrapeCreators request failed with HTTP ${response.status}${
        detail ? `: ${detail}` : ""
      }`,
    );
  }

  return body;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    toolLogger.debug(
      { status: response.status, error: formatError(error) },
      "ScrapeCreators response body was not JSON",
    );
    return null;
  }
}

function getScrapeCreatorsErrorDetail(body: unknown): string | null {
  const result = scrapeCreatorsErrorSchema.safeParse(body);
  if (!result.success) return null;
  return result.data.message ?? result.data.error ?? null;
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

function parseWithSchema<T>(
  schema: z.ZodType<T>,
  body: unknown,
  action: PinterestAction,
): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  throw new Error(
    `ScrapeCreators ${action} response did not match the documented Pinterest schema: ${formatZodIssues(result.error)}`,
  );
}

function parsePinterestResponse(
  action: PinterestAction,
  body: unknown,
): PinterestParsedResponse {
  if (action === "user_boards") {
    const data = parseWithSchema(pinterestBoardsResponseSchema, body, action);
    return { action, boards: data.boards, cursor: null };
  }

  if (action === "pin") {
    const pin = parseWithSchema(pinterestPinSchema, body, action);
    return { action, pin, cursor: null };
  }

  const data = parseWithSchema(pinterestPinsResponseSchema, body, action);
  return { action, pins: data.pins, cursor: data.cursor ?? null };
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
          url: requireValue(
            input.boardUrl,
            "board_url is required for board_pins.",
          ),
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
  parsed: PinterestParsedResponse,
  maxResults: number,
): PinterestResponseSummary {
  if (parsed.action === "user_boards") {
    return {
      boards: parsed.boards.slice(0, maxResults).map(summarizeBoard),
    };
  }

  if (parsed.action === "pin") {
    return {
      pin: summarizePin(parsed.pin),
    };
  }

  return {
    pins: parsed.pins.slice(0, maxResults).map(summarizePin),
  };
}

function getPinsFromSummary(summary: PinterestResponseSummary): PinterestPinSummary[] {
  if ("pins" in summary) return summary.pins;
  if ("pin" in summary) return [summary.pin];
  return [];
}

function getPinLabel(pin: PinterestPinSummary): string {
  return pin.title ?? pin.description ?? pin.url ?? pin.id ?? "Pinterest pin";
}

function hasImageUrl(
  pin: PinterestPinSummary,
): pin is PinterestPinSummary & { imageUrl: string } {
  return typeof pin.imageUrl === "string" && pin.imageUrl.trim().length > 0;
}

function hasPinUrl(
  pin: PinterestPinSummary,
): pin is PinterestPinSummary & { url: string } {
  return typeof pin.url === "string" && pin.url.trim().length > 0;
}

function buildDescribeImageCall(
  pin: PinterestPinSummary & { imageUrl: string },
) {
  return {
    tool: "describe_image",
    image_url: pin.imageUrl,
    question:
      `Visually inspect this Pinterest pin image. First transcribe any visible ` +
      `text exactly, then describe the visual style/content relevant to rating ` +
      `or comparing the pin. Pin: ${getPinLabel(pin)}`,
    detail: "high",
    reason:
      "The user asked to view the Pinterest image itself, not just metadata.",
  };
}

function buildPinDetailCall(pin: PinterestPinSummary & { url: string }) {
  return {
    tool: "pinterest",
    action: "pin",
    handle: null,
    board_url: null,
    pin_url: pin.url,
    query: null,
    cursor: null,
    max_results: 1,
    reason:
      "Fetch individual pin details to look for a direct image URL before visual inspection.",
  };
}

function recommendedPinterestFollowUpCount(candidateCount: number): number {
  if (candidateCount <= 0) return 0;
  return Math.min(
    Math.ceil(Math.sqrt(candidateCount)),
    MAX_PINTEREST_RECOMMENDED_FOLLOW_UPS,
  );
}

function buildRecommendedNextToolCalls(
  action: PinterestAction,
  summary: PinterestResponseSummary,
) {
  const pins = getPinsFromSummary(summary);
  const imageCandidates = pins.filter(hasImageUrl);
  const imageInspectionCount = recommendedPinterestFollowUpCount(
    imageCandidates.length,
  );
  const describeImageCalls = imageCandidates
    .slice(0, imageInspectionCount)
    .map(buildDescribeImageCall);

  if (describeImageCalls.length > 0) return describeImageCalls;
  if (action === "pin") return [];

  const pinDetailCandidates = pins.filter(hasPinUrl);
  const pinDetailCount = recommendedPinterestFollowUpCount(
    pinDetailCandidates.length,
  );
  return pinDetailCandidates.slice(0, pinDetailCount).map(buildPinDetailCall);
}

function getPinterestImageStats(summary: PinterestResponseSummary) {
  const pins = getPinsFromSummary(summary);
  const directImageCount = pins.filter(hasImageUrl).length;
  const pinDetailCandidateCount = pins.filter(hasPinUrl).length;
  const recommendedImageInspectionCount =
    recommendedPinterestFollowUpCount(directImageCount);
  const recommendedPinDetailCount = recommendedPinterestFollowUpCount(
    pinDetailCandidateCount,
  );
  return {
    returnedPinCount: pins.length,
    directImageCount,
    pinDetailCandidateCount,
    recommendedImageInspectionCount,
    recommendedPinDetailCount,
  };
}

function getSummaryResultCount(summary: PinterestResponseSummary): number {
  if ("boards" in summary) return summary.boards.length;
  if ("pins" in summary) return summary.pins.length;
  return 1;
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
      .describe(
        "Pagination cursor returned by a previous board_pins/search call.",
      ),
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
      const parsed = parsePinterestResponse(action, data);
      const summary = summarizeResponse(parsed, maxResults);
      const nextCursor = parsed.cursor;
      const recommendedNextToolCalls = buildRecommendedNextToolCalls(
        action,
        summary,
      );
      const imageStats = getPinterestImageStats(summary);

      toolLogger.info(
        {
          action,
          returned: getSummaryResultCount(summary),
          returnedPinCount: imageStats.returnedPinCount,
          directImageCount: imageStats.directImageCount,
          recommendedImageInspectionCount:
            imageStats.recommendedImageInspectionCount,
          pinDetailCandidateCount: imageStats.pinDetailCandidateCount,
          recommendedPinDetailCount: imageStats.recommendedPinDetailCount,
          recommendedNextToolCallCount: recommendedNextToolCalls.length,
          hasCursor: Boolean(nextCursor),
        },
        "Pinterest lookup complete",
      );

      return {
        provider: "scrapecreators",
        action,
        nextCursor,
        ...summary,
        returned_pin_count: imageStats.returnedPinCount,
        direct_image_count: imageStats.directImageCount,
        pin_detail_candidate_count: imageStats.pinDetailCandidateCount,
        recommended_image_inspection_count:
          imageStats.recommendedImageInspectionCount,
        recommended_pin_detail_count: imageStats.recommendedPinDetailCount,
        visual_sampling_policy: {
          strategy: "bounded_representative_sample",
          max_recommended_follow_ups: MAX_PINTEREST_RECOMMENDED_FOLLOW_UPS,
          explanation:
            "Pinterest boards can contain hundreds of pins. Do not try to inspect every image. Use the recommended sample count, report how many images were actually inspected, and ask the user to narrow the board only if they need exhaustive review.",
        },
        recommended_next_tool_calls: recommendedNextToolCalls,
        image_inspection_note:
          "For visual questions, ratings, or requests to view the images themselves, use returned_pin_count/direct_image_count and visual_sampling_policy to explain the sample size, then follow recommended_next_tool_calls. Do not attempt exhaustive inspection of large boards. Do not use fetch_url/web_search as a substitute for visual inspection.",
        note: "Results are public Pinterest data from ScrapeCreators. Use nextCursor for the next page when present.",
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { action, error: errorMessage },
        "Pinterest lookup failed",
      );
      return { error: "Pinterest lookup failed", details: errorMessage };
    }
  },
});
