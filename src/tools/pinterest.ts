import { tool } from '@openai/agents';
import { z } from 'zod';
import {
  PINTEREST_DATA_CACHE_MAX_ENTRIES,
  PINTEREST_DATA_CACHE_TTL_MS,
} from '../constants';
import { toolLogger } from '../logger';
import {
  fetchScrapeCreatorsJson,
  parseScrapeCreatorsSchema,
} from '../services/scrapecreators-client';
import { getOrCreateCachedExternalData } from '../stores/data-cache-store';
import { formatError } from '../utils/types';

const PINTEREST_BASE_URL = 'https://www.pinterest.com';
const MAX_PINTEREST_RESULTS = 20;
const DEFAULT_PINTEREST_RESULTS = 10;
const MAX_PINTEREST_RECOMMENDED_FOLLOW_UPS = 10;
const TRIM_PINTEREST_RESPONSE = false;
const PINTEREST_CACHE_NAMESPACE = 'pinterest';

type PinterestAction = 'user_boards' | 'board_pins' | 'pin' | 'search';
type ApiRecord = Record<string, unknown>;

type PinterestPinSummary = NonNullable<ReturnType<typeof summarizePin>>;
type PinterestResponseSummary
  = | { boards: PinterestBoardSummary[] }
    | { pin: PinterestPinSummary }
    | { pins: PinterestPinSummary[] };
type PinterestBoardSummary = ReturnType<typeof summarizeBoard>;

interface ScrapeCreatorsRequest {
  path: string;
  params: Record<string, string | boolean | undefined>;
}

const maybeNumberSchema = z.number().nullish();
const maybeBooleanSchema = z.boolean().nullish();

const TEXT_VALUE_KEYS = [
  'text',
  'title',
  'name',
  'value',
  'label',
  'content',
  'description',
  'display_name',
  'full_name',
] as const;

function isApiRecord(value: unknown): value is ApiRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeApiText(value: unknown, depth = 0): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = normalizeApiText(entry, depth + 1);
      if (text) { return text; }
    }
    return null;
  }

  if (!isApiRecord(value) || depth > 2) { return null; }

  for (const key of TEXT_VALUE_KEYS) {
    const text = normalizeApiText(value[key], depth + 1);
    if (text) { return text; }
  }

  return null;
}

const maybeApiTextSchema = z
  .union([
    z.string(),
    z.number(),
    z.array(z.unknown()),
    z.record(z.string(), z.unknown()),
  ])
  .nullish()
  .transform(value => normalizeApiText(value));

const pinterestImageAssetSchema = z.looseObject({
  url: maybeApiTextSchema,
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
  id: maybeApiTextSchema,
  entityId: maybeApiTextSchema,
  username: maybeApiTextSchema,
  full_name: maybeApiTextSchema,
  fullName: maybeApiTextSchema,
  follower_count: maybeNumberSchema,
  followerCount: maybeNumberSchema,
  image_large_url: maybeApiTextSchema,
  imageLargeUrl: maybeApiTextSchema,
  image_medium_url: maybeApiTextSchema,
  imageMediumUrl: maybeApiTextSchema,
  profileUrl: maybeApiTextSchema,
});

const pinterestBoardSchema = z.looseObject({
  id: maybeApiTextSchema,
  name: maybeApiTextSchema,
  description: maybeApiTextSchema,
  url: maybeApiTextSchema,
  pin_count: maybeNumberSchema,
  pinCount: maybeNumberSchema,
  follower_count: maybeNumberSchema,
  followerCount: maybeNumberSchema,
  section_count: maybeNumberSchema,
  sectionCount: maybeNumberSchema,
  privacy: maybeApiTextSchema,
  is_collaborative: maybeBooleanSchema,
  isCollaborative: maybeBooleanSchema,
  image_cover_hd_url: maybeApiTextSchema,
  image_cover_url: maybeApiTextSchema,
  cover_images: pinterestImageMapSchema.nullish(),
  images: pinterestImageMapSchema.nullish(),
  owner: pinterestUserSchema.nullish(),
  created_at: maybeApiTextSchema,
  createdAt: maybeApiTextSchema,
  board_order_modified_at: maybeApiTextSchema,
  boardOrderModifiedAt: maybeApiTextSchema,
});

const pinterestPinSchema = z.looseObject({
  id: maybeApiTextSchema,
  entityId: maybeApiTextSchema,
  title: maybeApiTextSchema,
  grid_title: maybeApiTextSchema,
  seoTitle: maybeApiTextSchema,
  description: maybeApiTextSchema,
  closeupDescription: maybeApiTextSchema,
  seoDescription: maybeApiTextSchema,
  url: maybeApiTextSchema,
  seoUrl: maybeApiTextSchema,
  seo_url: maybeApiTextSchema,
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
  image_url: maybeApiTextSchema,
  imageUrl: maybeApiTextSchema,
  image: maybePinterestImageValueSchema,
  thumbnail: maybePinterestImageValueSchema,
  thumbnailUrl: maybeApiTextSchema,
  thumbnail_url: maybeApiTextSchema,
  link: maybeApiTextSchema,
  richPinUrl: maybeApiTextSchema,
  domain: maybeApiTextSchema,
  link_domain: maybeApiTextSchema,
  seoCanonicalDomain: maybeApiTextSchema,
  alt_text: maybeApiTextSchema,
  auto_alt_text: maybeApiTextSchema,
  seo_alt_text: maybeApiTextSchema,
  seoAltText: maybeApiTextSchema,
  created_at: maybeApiTextSchema,
  createdAt: maybeApiTextSchema,
  repin_count: maybeNumberSchema,
  repinCount: maybeNumberSchema,
  share_count: maybeNumberSchema,
  shareCount: maybeNumberSchema,
  board: pinterestBoardSchema.nullish(),
  pinner: pinterestUserSchema.nullish(),
  originPinner: pinterestUserSchema.nullish(),
  native_creator: pinterestUserSchema.nullish(),
});

const pinterestBoardsResponseSchema = z.looseObject({
  success: z.boolean().optional(),
  boards: z.array(pinterestBoardSchema).default([]),
});

const pinterestPinsResponseSchema = z.looseObject({
  success: z.boolean().optional(),
  pins: z.array(pinterestPinSchema).default([]),
  cursor: maybeApiTextSchema,
});

type PinterestImageValue = z.infer<typeof pinterestImageValueSchema>;
type PinterestImageMap = z.infer<typeof pinterestImageMapSchema>;
type PinterestUser = z.infer<typeof pinterestUserSchema>;
type PinterestBoard = z.infer<typeof pinterestBoardSchema>;
type PinterestPin = z.infer<typeof pinterestPinSchema>;
type PinterestParsedResponse
  = | {
    action: 'user_boards';
    boards: PinterestBoard[];
    cursor: null;
  }
  | {
    action: 'board_pins' | 'search';
    pins: PinterestPin[];
    cursor: string | null;
  }
  | {
    action: 'pin';
    pin: PinterestPin;
    cursor: null;
  };

const PINTEREST_IMAGE_KEYS = [
  'orig',
  'original',
  'originals',
  '1200x',
  '736x',
  '600x315',
  '564x',
  '474x',
  '236x',
  '222x',
  '170x',
] as const;

function clampMaxResults(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return DEFAULT_PINTEREST_RESULTS;
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PINTEREST_RESULTS);
}

function getImageHttpUrl(value: string | null | undefined): string | null {
  if (!value) { return null; }
  if (!URL.canParse(value)) { return null; }
  const url = new URL(value);
  return url.protocol === 'http:' || url.protocol === 'https:'
    ? url.toString()
    : null;
}

function toPinterestUrl(value: string | null | undefined): string | null {
  if (!value) { return null; }
  if (value.startsWith('http://') || value.startsWith('https://')) { return value; }
  if (value.startsWith('/')) { return `${PINTEREST_BASE_URL}${value}`; }
  return value;
}

function normalizePinterestHandle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('http')) { return trimmed.replace(/^@/, ''); }

  const url = new URL(trimmed);
  const handle = url.pathname.split('/').find(Boolean);
  if (!handle) {
    throw new Error('Pinterest profile URL did not include a username.');
  }
  return handle.replace(/^@/, '');
}

function normalizePinUrl(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) { return `${PINTEREST_BASE_URL}/pin/${trimmed}/`; }
  return toPinterestUrl(trimmed) ?? trimmed;
}

function getImageUrlFromImageValue(
  value: PinterestImageValue | null | undefined,
): string | null {
  if (!value) { return null; }
  if (typeof value === 'string') { return getImageHttpUrl(value); }

  if (Array.isArray(value)) {
    for (const image of value) {
      const url = getImageHttpUrl(image.url);
      if (url) { return url; }
    }
    return null;
  }

  return getImageHttpUrl(value.url);
}

function getImageUrlFromImageRecord(
  images: PinterestImageMap | null | undefined,
): string | null {
  if (!images) { return null; }

  for (const key of PINTEREST_IMAGE_KEYS) {
    const url = getImageUrlFromImageValue(images[key]);
    if (url) { return url; }
  }

  for (const image of Object.values(images)) {
    const url = getImageUrlFromImageValue(image);
    if (url) { return url; }
  }

  return null;
}

function getPinImageUrl(pin: PinterestPin): string | null {
  const imagesUrl = getImageUrlFromImageRecord(pin.images);
  if (imagesUrl) { return imagesUrl; }

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
    if (url) { return url; }
  }

  return null;
}

function getBoardCoverUrl(board: PinterestBoard): string | null {
  return (
    getImageHttpUrl(board.image_cover_hd_url)
    ?? getImageHttpUrl(board.image_cover_url)
    ?? getImageUrlFromImageRecord(board.cover_images)
    ?? getImageUrlFromImageRecord(board.images)
  );
}

function summarizeUser(user: PinterestUser | null | undefined) {
  if (!user) { return null; }
  return {
    id: user.id ?? user.entityId ?? null,
    username: user.username ?? null,
    fullName: user.full_name ?? user.fullName ?? null,
    followerCount: user.follower_count ?? user.followerCount ?? null,
    imageUrl:
      getImageHttpUrl(user.image_large_url)
      ?? getImageHttpUrl(user.imageLargeUrl)
      ?? getImageHttpUrl(user.image_medium_url)
      ?? getImageHttpUrl(user.imageMediumUrl),
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
    url: toPinterestUrl(pin.url ?? pin.seoUrl ?? pin.seo_url),
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

async function callScrapeCreators(
  request: ScrapeCreatorsRequest,
  forceRefresh: boolean,
): Promise<unknown> {
  return getOrCreateCachedExternalData({
    forceRefresh,
    key: getScrapeCreatorsCacheKey(request),
    maxEntries: PINTEREST_DATA_CACHE_MAX_ENTRIES,
    namespace: PINTEREST_CACHE_NAMESPACE,
    read: () => fetchScrapeCreatorsJson({
      path: request.path,
      params: request.params,
      notConfiguredMessage:
        'ScrapeCreators is not configured. Set SCRAPECREATORS_API_KEY to use Pinterest tools.',
      requestFailedMessage: 'ScrapeCreators request failed',
      nonJsonLogMessage: 'ScrapeCreators response body was not JSON',
      logDebug: (context, message) => toolLogger.debug(context, message),
    }),
    ttlMs: PINTEREST_DATA_CACHE_TTL_MS,
  });
}

function getScrapeCreatorsCacheKey(request: ScrapeCreatorsRequest): string {
  const params = Object.entries(request.params)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return JSON.stringify([request.path, params]);
}

function parsePinterestResponse(
  action: PinterestAction,
  body: unknown,
): PinterestParsedResponse {
  if (action === 'user_boards') {
    const data = parseScrapeCreatorsSchema(
      pinterestBoardsResponseSchema,
      body,
      `${action} Pinterest`,
    );
    return { action, boards: data.boards, cursor: null };
  }

  if (action === 'pin') {
    const pin = parseScrapeCreatorsSchema(
      pinterestPinSchema,
      body,
      `${action} Pinterest`,
    );
    return { action, pin, cursor: null };
  }

  const data = parseScrapeCreatorsSchema(
    pinterestPinsResponseSchema,
    body,
    `${action} Pinterest`,
  );
  return { action, pins: data.pins, cursor: data.cursor ?? null };
}

function requireValue(value: string | null, message: string): string {
  const trimmed = value?.trim();
  if (!trimmed) { throw new Error(message); }
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
    trim: TRIM_PINTEREST_RESPONSE,
  };

  switch (input.action) {
    case 'user_boards':
      return {
        path: '/v1/pinterest/user/boards',
        params: {
          handle: normalizePinterestHandle(
            requireValue(input.handle, 'handle is required for user_boards.'),
          ),
          trim: true,
        },
      };
    case 'board_pins':
      return {
        path: '/v1/pinterest/board',
        params: {
          ...common,
          url: requireValue(
            input.boardUrl,
            'board_url is required for board_pins.',
          ),
        },
      };
    case 'pin':
      return {
        path: '/v1/pinterest/pin',
        params: {
          url: normalizePinUrl(
            requireValue(input.pinUrl, 'pin_url is required for pin.'),
          ),
          trim: TRIM_PINTEREST_RESPONSE,
        },
      };
    case 'search':
      return {
        path: '/v1/pinterest/search',
        params: {
          ...common,
          query: requireValue(input.query, 'query is required for search.'),
        },
      };
  }
}

function summarizeResponse(
  parsed: PinterestParsedResponse,
  maxResults: number,
): PinterestResponseSummary {
  if (parsed.action === 'user_boards') {
    return {
      boards: parsed.boards.slice(0, maxResults).map(summarizeBoard),
    };
  }

  if (parsed.action === 'pin') {
    return {
      pin: summarizePin(parsed.pin),
    };
  }

  return {
    pins: parsed.pins.slice(0, maxResults).map(summarizePin),
  };
}

function getPinsFromSummary(summary: PinterestResponseSummary): PinterestPinSummary[] {
  if ('pins' in summary) { return summary.pins; }
  if ('pin' in summary) { return [summary.pin]; }
  return [];
}

function getPinLabel(pin: PinterestPinSummary): string {
  return pin.title ?? pin.description ?? pin.url ?? pin.id ?? 'Pinterest pin';
}

function hasImageUrl(
  pin: PinterestPinSummary,
): pin is PinterestPinSummary & { imageUrl: string } {
  return typeof pin.imageUrl === 'string' && pin.imageUrl.trim().length > 0;
}

function hasPinUrl(
  pin: PinterestPinSummary,
): pin is PinterestPinSummary & { url: string } {
  return typeof pin.url === 'string' && pin.url.trim().length > 0;
}

function buildDescribeImageCall(
  pin: PinterestPinSummary & { imageUrl: string },
) {
  return {
    tool: 'describe_image',
    image_url: pin.imageUrl,
    question:
      `Visually inspect this Pinterest pin image. First transcribe any visible `
      + `text exactly if present, then give only the style/content details needed `
      + `to rate or compare the board. Keep this compact; do not write the final `
      + `board review here. Pin: ${getPinLabel(pin)}`,
    detail: 'high',
    reason:
      'The user asked to view the Pinterest image itself, not just metadata.',
  };
}

function buildPinDetailCall(pin: PinterestPinSummary & { url: string }) {
  return {
    tool: 'pinterest',
    action: 'pin',
    handle: null,
    board_url: null,
    pin_url: pin.url,
    query: null,
    cursor: null,
    max_results: 1,
    reason:
      'Fetch individual pin details to look for a direct image URL before visual inspection.',
  };
}

function recommendedPinterestFollowUpCount(candidateCount: number): number {
  if (candidateCount <= 0) { return 0; }
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

  if (describeImageCalls.length > 0) { return describeImageCalls; }
  if (action === 'pin') { return []; }

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
  const recommendedImageInspectionCount
    = recommendedPinterestFollowUpCount(directImageCount);
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
  if ('boards' in summary) { return summary.boards.length; }
  if ('pins' in summary) { return summary.pins.length; }
  return 1;
}

export const pinterestTool = tool({
  name: 'pinterest',
  description:
    'Read public Pinterest data through ScrapeCreators: list a user\'s boards, inspect board pins, fetch a pin, or search pins. Use this when the user asks about Pinterest boards/pins.',
  parameters: z.object({
    action: z
      .enum(['user_boards', 'board_pins', 'pin', 'search'])
      .describe('Pinterest lookup to perform.'),
    handle: z
      .string()
      .nullable()
      .describe(
        'Pinterest username or profile URL for user_boards, such as \'broadstbullycom\' or a pinterest.com profile URL.',
      ),
    board_url: z
      .string()
      .nullable()
      .describe('Pinterest board URL for board_pins.'),
    pin_url: z
      .string()
      .nullable()
      .describe('Pinterest pin URL or numeric pin ID for pin details.'),
    query: z.string().nullable().describe('Search query for search.'),
    cursor: z
      .string()
      .nullable()
      .describe(
        'Pagination cursor returned by a previous board_pins/search call.',
      ),
    max_results: z
      .number()
      .nullable()
      .describe('Maximum boards or pins to return, 1-20. Defaults to 10.'),
    fresh: z
      .boolean()
      .default(false)
      .describe(
        'Bypass the short cache and refetch from ScrapeCreators. Use only when the user asks to refresh or wants current board/pin data.',
      ),
  }),
  execute: async ({
    action,
    handle,
    board_url,
    pin_url,
    query,
    cursor,
    max_results,
    fresh,
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
      const data = await callScrapeCreators(request, fresh);
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
          fresh,
        },
        'Pinterest lookup complete',
      );

      return {
        provider: 'scrapecreators',
        action,
        cache: {
          fresh,
          ttl_seconds: 300,
        },
        nextCursor,
        ...summary,
        returned_pin_count: imageStats.returnedPinCount,
        direct_image_count: imageStats.directImageCount,
        pin_detail_candidate_count: imageStats.pinDetailCandidateCount,
        recommended_image_inspection_count:
          imageStats.recommendedImageInspectionCount,
        recommended_pin_detail_count: imageStats.recommendedPinDetailCount,
        visual_sampling_policy: {
          strategy: 'bounded_representative_sample',
          max_recommended_follow_ups: MAX_PINTEREST_RECOMMENDED_FOLLOW_UPS,
          explanation:
            'Pinterest boards can contain hundreds of pins. Do not try to inspect every image. Use the recommended sample count, then mention the sample size briefly in the final answer only when relevant.',
        },
        recommended_next_tool_calls: recommendedNextToolCalls,
        image_inspection_note:
          'For visual questions, ratings, or requests to view the images themselves, follow recommended_next_tool_calls. In the final answer, lead with the user\'s answer/rating instead of API counts. Mention counts compactly, such as \'I sampled 4 of 10 visible pins.\' Do not dump every OCR result unless the user explicitly asks for a full transcript. Do not use fetch_url/web_search as a substitute for visual inspection.',
        final_answer_guidance:
          'Pinterest board ratings should feel like a natural opinion, not a tool report: rating first, 2-4 concise reasons, a few sampled quote/text examples only if useful, and any limitation/sample-size note at the end.',
        note: 'Results are public Pinterest data from ScrapeCreators. Use nextCursor for the next page when present.',
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { action, error: errorMessage },
        'Pinterest lookup failed',
      );
      return { error: 'Pinterest lookup failed', details: errorMessage };
    }
  },
});
