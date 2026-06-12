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
}

interface ResolvedImage {
  url: string;
  source: string;
}

const SERVICE_ORDER: readonly ReverseImageService[] = [
  "google_lens",
  "bing_visual_search",
  "yandex_images",
  "tineye",
  "saucenao",
];

const MODE_SERVICES: Record<ReverseSearchMode, readonly ReverseImageService[]> = {
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
    bestFor: "general matches, products, landmarks, text, and broad visual search",
    buildUrl: (imageUrl) =>
      withQuery("https://lens.google.com/uploadbyurl", { url: imageUrl }),
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
    bestFor: "exact matches, older copies, modified versions, and source hunting",
    buildUrl: (imageUrl) =>
      withQuery("https://tineye.com/search", { url: imageUrl }),
  },
  yandex_images: {
    service: "yandex_images",
    label: "Yandex Images",
    bestFor: "similar images, source pages, and visual matches outside Google/Bing",
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
    throw new Error("No image attachment or embed image was found on that message.");
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
    "Create reverse image search links for a public image URL or a Discord image attachment/embed from the current or replied message. Let the AI choose Google Lens, Bing Visual Search, TinEye, Yandex Images, or SauceNAO based on the user's goal. This returns search links, not scraped search results.",
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
      .describe("1-based image index if a message has multiple images. Defaults to 1."),
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
        return {
          service: provider.service,
          label: provider.label,
          url: provider.buildUrl(image.url),
          best_for: provider.bestFor,
        };
      });

      toolLogger.info(
        {
          mode: searchMode,
          services: selectedServices,
          imageSource: image.source,
        },
        "Prepared reverse image search links",
      );

      return {
        success: true,
        mode: searchMode,
        image_url: image.url,
        image_source: image.source,
        searches,
        note: "These providers expose interactive reverse-search pages. Open the returned links to inspect matches; do not claim exact matches unless the user or a later tool result confirms them.",
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
