import { tool } from "@openai/agents";
import { z } from "zod";
import { toolLogger } from "../logger";
import { getMessageImageInputs } from "../utils/messages";
import { formatError, toolContextManager } from "../utils/types";

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
  variants?: readonly ReverseImageLinkVariant[];
}

interface ResolvedImage {
  url: string;
  source: string;
}

interface ReverseImageLinkVariant {
  label: string;
  url: string;
  bestFor: string;
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
  const match = /:\s*([^:]+)$/.exec(source);
  return match?.[1]?.trim() || null;
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
    queries.add('"furry" "artist" "tumblr"');
    queries.add('"Furbooru" "artist:" "canine"');
  }

  return [...queries].slice(0, 6);
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

async function resolveMessageImage(
  messageId: string | null,
  imageIndex: number | null,
): Promise<ResolvedImage> {
  const result = await toolContextManager.resolveTargetMessage(
    messageId,
    "reverse_image_search",
  );
  if (!result.success) throw new Error(result.error);

  const images = getMessageImageInputs(result.message);
  if (images.length === 0) {
    throw new Error(
      "No image attachment or embed image was found on that message.",
    );
  }

  const index = Math.max((imageIndex ?? 1) - 1, 0);
  const image = images[index];
  if (!image) {
    throw new Error(
      `Image ${index + 1} was requested, but the message only has ${images.length} image(s).`,
    );
  }

  return {
    url: normalizePublicImageUrl(image.url),
    source: image.source,
  };
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
    };
  }

  return resolveMessageImage(messageId, imageIndex);
}

export const reverseImageSearchTool = tool({
  name: "reverse_image_search",
  description:
    "Prepare reverse-image-search provider links and follow-up web-search queries for a public image URL or Discord image attachment/embed from the current or replied message. Let the main agent continue with web_search/fetch_url before answering origin/source requests.",
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
        "Discord message to take the image from. Use null for the current message, 'replied' for the message the user replied to, or an exact message ID.",
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
    const searchMode = mode ?? "broad";

    try {
      const image = await resolveImage(image_url, message_id, image_index);
      const selectedServices = chooseServices(services, searchMode);
      const searches = selectedServices.map((service) => {
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
        searches,
        follow_up_search_queries: followUpQueries,
        recommended_next_tool_calls: nextToolCalls,
        should_continue_with_web_search:
          searchMode === "source" || searchMode === "art",
        note: "Provider pages are interactive and may show visual/exact matches the bot cannot directly scrape. If the user asked for the image source/origin, do not stop here: call web_search with the recommended queries or visible result titles from the user's screenshot, then fetch likely candidate pages before answering.",
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
