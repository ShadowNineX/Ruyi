import { tool } from "@openai/agents";
import { PermissionFlagsBits, type Message } from "discord.js";
import { z } from "zod";
import { toolLogger } from "../../logger";
import { getMessageImageInputs } from "../utils/messages";
import { formatError, toolContextManager } from "../../utils/types";
import { requesterHasChannelPermission } from "../utils/discord-permissions";

type ReverseImageService =
  | "google_lens"
  | "bing_visual_search"
  | "tineye"
  | "yandex_images"
  | "saucenao";

type ReverseSearchMode = "broad" | "source" | "product" | "art";

interface ReverseImageProvider {
  service: ReverseImageService;
  label: string;
  bestFor: string;
  buildUrl: (imageUrl: string) => string;
  variants?: readonly ReverseImageProviderVariant[];
}

interface ResolvedImage {
  url: string;
  source: string;
  resolvedFrom: string;
  messageId: string | null;
  attempts: ImageResolutionAttempt[];
}

interface ImageResolutionAttempt {
  target: string;
  message_id: string | null;
  image_count?: number;
  selected?: boolean;
  error?: string;
}

interface ReverseImageProviderVariant {
  label: string;
  url: string;
  bestFor: string;
}

interface ReverseImageLinkVariant {
  label: string;
  url: string;
  best_for: string;
}

interface ReverseImageSearchLink {
  service: ReverseImageService;
  label: string;
  url: string;
  best_for: string;
  variants: ReverseImageLinkVariant[];
}

const SERVICE_ORDER: readonly ReverseImageService[] = [
  "google_lens",
  "bing_visual_search",
  "yandex_images",
  "tineye",
  "saucenao",
];

const MODE_SERVICES: Record<ReverseSearchMode, readonly ReverseImageService[]> =
  {
    broad: ["google_lens", "bing_visual_search", "yandex_images", "tineye"],
    source: ["tineye", "google_lens", "yandex_images", "bing_visual_search"],
    product: ["google_lens", "bing_visual_search", "yandex_images"],
    art: ["saucenao", "google_lens", "yandex_images", "tineye"],
  };

function withQuery(baseUrl: string, params: Record<string, string>): string {
  return `${baseUrl}?${new URLSearchParams(params).toString()}`;
}

const PROVIDERS: Record<ReverseImageService, ReverseImageProvider> = {
  google_lens: {
    service: "google_lens",
    label: "Google Lens",
    bestFor:
      "general matches, products, landmarks, text, and broad visual search",
    buildUrl: (imageUrl) =>
      withQuery("https://lens.google.com/uploadbyurl", { url: imageUrl }),
    variants: [
      {
        label: "Google Search by Image",
        bestFor: "older Google image-search flow; may redirect into Lens",
        url: "https://www.google.com/searchbyimage",
      },
    ],
  },
  bing_visual_search: {
    service: "bing_visual_search",
    label: "Bing Visual Search",
    bestFor: "general visual matches, shopping, and web pages using the image",
    buildUrl: (imageUrl) =>
      withQuery("https://www.bing.com/images/search", {
        view: "detailv2",
        iss: "sbi",
        form: "SBIIRP",
        sbisrc: "UrlPaste",
        q: `imgurl:${imageUrl}`,
      }),
  },
  tineye: {
    service: "tineye",
    label: "TinEye",
    bestFor:
      "exact matches, older copies, modified versions, and source hunting",
    buildUrl: (imageUrl) =>
      withQuery("https://tineye.com/search", { url: imageUrl }),
  },
  yandex_images: {
    service: "yandex_images",
    label: "Yandex Images",
    bestFor:
      "similar images, source pages, and visual matches outside Google/Bing",
    buildUrl: (imageUrl) =>
      withQuery("https://yandex.com/images/search", {
        rpt: "imageview",
        url: imageUrl,
      }),
  },
  saucenao: {
    service: "saucenao",
    label: "SauceNAO",
    bestFor: "anime, manga, illustrations, fanart, and art source lookup",
    buildUrl: (imageUrl) =>
      withQuery("https://saucenao.com/search.php", { url: imageUrl }),
  },
};

function normalizePublicImageUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Reverse image search needs a public http(s) image URL.");
  }
  if (url.username || url.password) {
    throw new Error("Image URLs with embedded credentials are not allowed.");
  }

  return url.toString();
}

function imageResolutionAttempt(
  target: string,
  messageId: string | null,
  details: Omit<ImageResolutionAttempt, "target" | "message_id">,
): ImageResolutionAttempt {
  return {
    target,
    message_id: messageId,
    ...details,
  };
}

function selectMessageImage(
  message: Message,
  target: string,
  imageIndex: number | null,
): { image: ResolvedImage; attempt: ImageResolutionAttempt } | {
  image: null;
  attempt: ImageResolutionAttempt;
} {
  const images = getMessageImageInputs(message, target);
  const selectedIndex = Math.max((imageIndex ?? 1) - 1, 0);
  const rawImage = images[selectedIndex];

  if (!rawImage) {
    return {
      image: null,
      attempt: imageResolutionAttempt(target, message.id, {
        image_count: images.length,
        error:
          images.length === 0
            ? "No image attachment, pasted upload, or embed image found."
            : `Image ${selectedIndex + 1} was requested, but only ${images.length} image(s) exist.`,
      }),
    };
  }

  return {
    image: {
      url: normalizePublicImageUrl(rawImage.url),
      source: rawImage.source,
      resolvedFrom: target,
      messageId: message.id,
      attempts: [],
    },
    attempt: imageResolutionAttempt(target, message.id, {
      image_count: images.length,
      selected: true,
    }),
  };
}

function getUrlFileName(imageUrl: string): string | null {
  try {
    const url = new URL(imageUrl);
    const lastSegment = url.pathname.split("/").findLast(Boolean);
    return lastSegment ? decodeURIComponent(lastSegment) : null;
  } catch {
    return null;
  }
}

function getSourceFileName(source: string): string | null {
  const separatorIndex = source.lastIndexOf(":");
  if (separatorIndex < 0) return null;

  const fileName = source.slice(separatorIndex + 1).trim();
  return fileName || null;
}

function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{2,5}$/i, "");
}

function getImageClues(image: ResolvedImage): string[] {
  const fileNames = [getSourceFileName(image.source), getUrlFileName(image.url)]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim())
    .filter(Boolean);
  const clues = new Set<string>();

  for (const fileName of fileNames) {
    clues.add(fileName);
    clues.add(stripFileExtension(fileName));
  }

  return [...clues].filter((clue) => clue.length > 2);
}

function buildFollowUpQueries(
  mode: ReverseSearchMode,
  image: ResolvedImage,
): string[] {
  const clues = getImageClues(image);
  const queries = new Set<string>();

  for (const clue of clues.slice(0, 3)) {
    queries.add(`"${clue}"`);
    if (mode === "art") {
      queries.add(`"${clue}" artist`);
      queries.add(`"${clue}" tumblr OR furbooru OR "fur affinity"`);
    } else if (mode === "source") {
      queries.add(`"${clue}" source OR original`);
    }
  }

  if (mode === "art") {
    queries.add('"Furbooru" "artist:"');
  }

  return [...queries].slice(0, 1);
}

function buildNextToolCalls(
  mode: ReverseSearchMode,
  image: ResolvedImage,
): Array<{ tool: "web_search"; query: string; mode: "research" }> {
  return buildFollowUpQueries(mode, image).map((query) => ({
    tool: "web_search",
    query,
    mode: "research",
  }));
}

function buildManualReverseSearchMarkdown(
  searches: ReverseImageSearchLink[],
): string {
  return searches
    .map((search) => {
      const variantLinks =
        search.variants.length > 0
          ? ` (${search.variants
              .map((variant) => `[${variant.label}](${variant.url})`)
              .join(", ")})`
          : "";
      return `- [${search.label}](${search.url}) - ${search.best_for}${variantLinks}`;
    })
    .join("\n");
}

function dedupeServices(
  services: readonly ReverseImageService[],
): ReverseImageService[] {
  const selected = new Set(services);
  return SERVICE_ORDER.filter((service) => selected.has(service));
}

function chooseServices(
  services: ReverseImageService[] | null,
  mode: ReverseSearchMode,
): ReverseImageService[] {
  if (services && services.length > 0) return dedupeServices(services);
  return dedupeServices(MODE_SERVICES[mode]);
}

async function resolveMessageById(
  messageId: string,
): Promise<Message | null> {
  const result = await toolContextManager.resolveTargetMessage(
    messageId,
    "reverse_image_search",
  );
  if (!result.success) return null;
  if (
    !requesterHasChannelPermission(result.message.channel, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
    ])
  ) {
    return null;
  }
  return result.message;
}

function addCandidate(
  candidates: Array<{ target: string; message: Message }>,
  seen: Set<string>,
  target: string,
  message: Message | null,
): void {
  if (!message || seen.has(message.id)) return;
  seen.add(message.id);
  candidates.push({ target, message });
}

async function collectRecentImageCandidates(
  seen: Set<string>,
): Promise<Array<{ target: string; message: Message }>> {
  const ctx = toolContextManager.get();
  const channel = ctx.channel;
  if (!channel || !("messages" in channel)) return [];
  if (
    !requesterHasChannelPermission(channel, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
    ])
  ) {
    return [];
  }

  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    return [...messages.values()]
      .sort((left, right) => right.createdTimestamp - left.createdTimestamp)
      .filter((message) => !seen.has(message.id))
      .filter((message) => getMessageImageInputs(message).length > 0)
      .slice(0, 3)
      .map((message, index) => ({
        target: `recent channel image ${index + 1}`,
        message,
      }));
  } catch (error) {
    toolLogger.debug(
      { error: formatError(error) },
      "Could not collect recent image candidates",
    );
    return [];
  }
}

async function collectImageCandidates(
  messageId: string | null,
): Promise<Array<{ target: string; message: Message }>> {
  const ctx = toolContextManager.get();
  const candidates: Array<{ target: string; message: Message }> = [];
  const seen = new Set<string>();
  const exactMessageId =
    messageId && messageId !== "replied" ? messageId.trim() : null;

  if (exactMessageId) {
    addCandidate(
      candidates,
      seen,
      "requested message",
      await resolveMessageById(exactMessageId),
    );
  }

  if (messageId === "replied") {
    addCandidate(candidates, seen, "replied message", ctx.referencedMessage);
    addCandidate(candidates, seen, "current message", ctx.message);
  } else {
    addCandidate(candidates, seen, "current message", ctx.message);
    addCandidate(candidates, seen, "replied message", ctx.referencedMessage);
  }

  candidates.push(...(await collectRecentImageCandidates(seen)));
  return candidates;
}

async function resolveMessageImage(
  messageId: string | null,
  imageIndex: number | null,
): Promise<ResolvedImage> {
  const candidates = await collectImageCandidates(messageId);
  const attempts: ImageResolutionAttempt[] = [];

  for (const candidate of candidates) {
    const result = selectMessageImage(
      candidate.message,
      candidate.target,
      imageIndex,
    );
    attempts.push(result.attempt);
    if (result.image) {
      return {
        ...result.image,
        attempts,
      };
    }
  }

  throw new Error(
    `No usable image found. Tried: ${
      attempts.length > 0
        ? attempts
            .map((attempt) => `${attempt.target} (${attempt.error ?? "no image"})`)
            .join("; ")
        : "current, replied, and recent channel messages"
    }.`,
  );
}

async function resolveImage(
  imageUrl: string | null,
  messageId: string | null,
  imageIndex: number | null,
): Promise<ResolvedImage> {
  if (imageUrl?.trim()) {
    return {
      url: normalizePublicImageUrl(imageUrl),
      source: "provided image_url",
      resolvedFrom: "provided image_url",
      messageId: null,
      attempts: [
        imageResolutionAttempt("provided image_url", null, {
          selected: true,
        }),
      ],
    };
  }

  return resolveMessageImage(messageId, imageIndex);
}

export const reverseImageSearchTool = tool({
  name: "reverse_image_search",
  description:
    "Prepare reverse-image-search provider links and a small number of follow-up web-search queries for a public image URL or a Discord pasted/uploaded image attachment/embed from the current or replied message. Use this once per image; if follow-up search cannot confirm the source quickly, answer with the manual provider links.",
  parameters: z.object({
    image_url: z
      .string()
      .min(1)
      .max(8192)
      .nullable()
      .describe(
        "Public http(s) image URL to reverse-search. Use null to use a Discord image from message_id.",
      ),
    message_id: z
      .string()
      .nullable()
      .describe(
        "Discord message to take the image from. Use null for the current message, including when the user pasted/uploaded an image in the same message; use 'replied' for the message the user replied to, or an exact message ID.",
      ),
    image_index: z
      .number()
      .int()
      .nullable()
      .describe(
        "1-based image index if a message has multiple images. Defaults to 1.",
      ),
    mode: z
      .enum(["broad", "source", "product", "art"])
      .nullable()
      .describe(
        "Search intent. Use broad for general lookup, source for origin/exact matches, product for shopping/items, art for anime/fanart/illustrations.",
      ),
    services: z
      .array(
        z.enum([
          "google_lens",
          "bing_visual_search",
          "tineye",
          "yandex_images",
          "saucenao",
        ]),
      )
      .nullable()
      .describe(
        "Specific services to include. Use null to let mode choose the best set.",
      ),
  }),
  execute: async ({ image_url, message_id, image_index, mode, services }) => {
    const budgetDecision =
      toolContextManager.consumeToolCall("reverse_image_search");
    if (!budgetDecision.allowed) {
      return toolContextManager.budgetDeniedResult(budgetDecision);
    }

    const searchMode = mode ?? "broad";

    try {
      const image = await resolveImage(image_url, message_id, image_index);
      const selectedServices = chooseServices(services, searchMode);
      const searches: ReverseImageSearchLink[] = selectedServices.map((service) => {
        const provider = PROVIDERS[service];
        const primaryUrl = provider.buildUrl(image.url);
        const variants =
          provider.variants?.map((variant) => ({
            label: variant.label,
            url:
              provider.service === "google_lens"
                ? withQuery(variant.url, { image_url: image.url })
                : variant.url,
            best_for: variant.bestFor,
          })) ?? [];

        return {
          service: provider.service,
          label: provider.label,
          url: primaryUrl,
          best_for: provider.bestFor,
          variants,
        };
      });
      const followUpQueries = buildFollowUpQueries(searchMode, image);
      const nextToolCalls = buildNextToolCalls(searchMode, image);
      const manualReverseSearchMarkdown =
        buildManualReverseSearchMarkdown(searches);

      toolLogger.info(
        {
          mode: searchMode,
          services: selectedServices,
          imageSource: image.source,
          followUpQueryCount: followUpQueries.length,
        },
        "Prepared reverse image search links",
      );

      return {
        success: true,
        mode: searchMode,
        image_url: image.url,
        image_source: image.source,
        image_message_id: image.messageId,
        image_resolved_from: image.resolvedFrom,
        image_resolution_attempts: image.attempts,
        searches,
        manual_reverse_search_markdown: manualReverseSearchMarkdown,
        follow_up_search_queries: followUpQueries,
        recommended_next_tool_calls: nextToolCalls,
        should_continue_with_web_search:
          searchMode === "source" || searchMode === "art",
        follow_up_budget: {
          web_search: 1,
          fetch_url: 1,
          describe_image: 1,
        },
        note: "Provider pages are interactive and may show visual/exact matches the bot cannot directly scrape. For source/origin requests, use at most the listed follow-up budget: no more than one web_search call, one fetch_url call, and one describe_image call if a visual description would materially help. If describe_image fails because OpenAI cannot download the image URL, that URL is poisoned for this turn and must not be retried; use a different already-available image URL only if describe_image says the budget was refunded. If the follow-up budget does not confirm the source, stop searching and include manual_reverse_search_markdown in the final answer so the user can open Google Lens/Bing/Yandex/TinEye/SauceNAO directly.",
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { error: errorMessage, mode: searchMode },
        "Reverse image search link generation failed",
      );
      return { error: "Reverse image search failed", details: errorMessage };
    }
  },
});
