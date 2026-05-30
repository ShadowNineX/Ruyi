import OpenAI from "openai";
import { z } from "zod";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { tool } from "@openai/agents";
import { toolLogger } from "../logger";
import { toolContextManager } from "../utils/types";
import { env } from "../env";

type OpenAIImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";
type OpenAIImageQuality = "auto" | "low" | "medium" | "high";
type OpenAIImageBackground = "auto" | "transparent" | "opaque";
type OpenAIImageFormat = "png" | "jpeg" | "webp";

interface ImageSizeChoice {
  size: OpenAIImageSize;
  requested: string | null;
  source: "image_size" | "aspect_ratio" | "default";
}

const openai = new OpenAI({ apiKey: env.MODEL_TOKEN });
const SUPPORTED_NATIVE_SIZES = new Set<OpenAIImageSize>([
  "auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
]);

const SIZE_ALIASES: Record<string, OpenAIImageSize> = {
  square: "1024x1024",
  avatar: "1024x1024",
  icon: "1024x1024",
  logo: "1024x1024",
  profile: "1024x1024",
  album_cover: "1024x1024",
  cover_art: "1024x1024",
  instagram_post: "1024x1024",
  social_post: "1024x1024",

  landscape: "1536x1024",
  wide: "1536x1024",
  desktop: "1536x1024",
  wallpaper: "1536x1024",
  desktop_wallpaper: "1536x1024",
  banner: "1536x1024",
  header: "1536x1024",
  cover_photo: "1536x1024",
  youtube_thumbnail: "1536x1024",
  presentation: "1536x1024",
  slide: "1536x1024",
  twitter_header: "1536x1024",
  x_header: "1536x1024",
  facebook_cover: "1536x1024",
  linkedin_banner: "1536x1024",

  portrait: "1024x1536",
  tall: "1024x1536",
  phone: "1024x1536",
  phone_wallpaper: "1024x1536",
  mobile_wallpaper: "1024x1536",
  story: "1024x1536",
  instagram_story: "1024x1536",
  reel: "1024x1536",
  shorts: "1024x1536",
  tiktok: "1024x1536",
  poster: "1024x1536",
  book_cover: "1024x1536",
  pinterest: "1024x1536",
};

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_").replaceAll("-", "_");
}

function parseDimensions(
  value: string,
): { width: number; height: number } | null {
  const match = /^(\d{2,5})\s*x\s*(\d{2,5})$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;

  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

function parseRatio(value: string): number | null {
  const ratioMatch = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(
    value.trim(),
  );
  if (ratioMatch?.[1] && ratioMatch[2]) {
    const width = Number.parseFloat(ratioMatch[1]);
    const height = Number.parseFloat(ratioMatch[2]);
    return height > 0 ? width / height : null;
  }

  const dimensions = parseDimensions(value);
  if (dimensions && dimensions.height > 0) {
    return dimensions.width / dimensions.height;
  }

  return null;
}

function sizeFromRatio(ratio: number | null): OpenAIImageSize {
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) return "auto";
  if (ratio >= 1.15) return "1536x1024";
  if (ratio <= 0.87) return "1024x1536";
  return "1024x1024";
}

function normalizeImageSize(
  aspectRatio: string | null,
  imageSize: string | null,
): ImageSizeChoice {
  if (imageSize) {
    const requested = imageSize.trim();
    const token = normalizeToken(requested);

    if (SUPPORTED_NATIVE_SIZES.has(token as OpenAIImageSize)) {
      return {
        size: token as OpenAIImageSize,
        requested,
        source: "image_size",
      };
    }

    const aliasSize = SIZE_ALIASES[token];
    if (aliasSize) {
      return { size: aliasSize, requested, source: "image_size" };
    }

    const ratioSize = sizeFromRatio(parseRatio(requested));
    if (ratioSize !== "auto") {
      return { size: ratioSize, requested, source: "image_size" };
    }
  }

  if (aspectRatio) {
    const requested = aspectRatio.trim();
    const token = normalizeToken(requested);
    const aliasSize = SIZE_ALIASES[token];
    if (aliasSize) {
      return { size: aliasSize, requested, source: "aspect_ratio" };
    }

    return {
      size: sizeFromRatio(parseRatio(requested)),
      requested,
      source: "aspect_ratio",
    };
  }

  return { size: "auto", requested: null, source: "default" };
}

function normalizeOutputFormat(
  outputFormat: OpenAIImageFormat | null,
  background: OpenAIImageBackground,
): OpenAIImageFormat {
  if (background === "transparent" && outputFormat === "jpeg") {
    return "png";
  }
  return outputFormat ?? "png";
}

function normalizeCompression(
  compression: number | null,
  outputFormat: OpenAIImageFormat,
): number | undefined {
  if (outputFormat === "png" || compression === null) return undefined;
  return Math.min(Math.max(Math.round(compression), 0), 100);
}

function extensionForFormat(outputFormat: OpenAIImageFormat): string {
  return outputFormat === "jpeg" ? "jpg" : outputFormat;
}

async function imageUrlToBuffer(imageUrl: string): Promise<Buffer> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Image download failed with status ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function sendImageToChannel(
  channel: { send: (options: unknown) => Promise<unknown> },
  imageBuffer: Buffer,
  prompt: string,
  outputFormat: OpenAIImageFormat,
): Promise<void> {
  const fileName = `generated-image.${extensionForFormat(outputFormat)}`;
  const attachment = new AttachmentBuilder(imageBuffer, { name: fileName });

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("Generated Image")
    .setDescription(prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt)
    .setImage(`attachment://${fileName}`)
    .setTimestamp();

  await channel.send({ embeds: [embed], files: [attachment] });
}

export const generateImageTool = tool({
  name: "generate_image",
  description:
    "Generate an image using AI. ONLY use when user EXPLICITLY requests image creation with words like 'draw', 'generate image', 'create a picture', 'make art', 'illustrate'. Do NOT use for descriptions, explanations, or when user is just discussing images/art conceptually.",
  parameters: z.object({
    prompt: z
      .string()
      .describe("A detailed description of the image to generate."),
    aspect_ratio: z
      .string()
      .nullable()
      .describe("Aspect ratio: '1:1', '16:9', '9:16', '4:3', etc."),
    image_size: z
      .string()
      .nullable()
      .describe(
        "Native size or common preset. Accepts 'auto', '1024x1024', '1536x1024', '1024x1536', common pixel sizes like '1920x1080' or '1080x1920' (mapped to nearest native size), or presets like 'wallpaper', 'phone wallpaper', 'youtube thumbnail', 'banner', 'poster', 'book cover', 'album cover', 'avatar'.",
      ),
    quality: z
      .enum(["auto", "low", "medium", "high"])
      .nullable()
      .describe(
        "Image quality. Use 'auto' unless the user asks for high detail or faster/lower quality.",
      ),
    background: z
      .enum(["auto", "opaque", "transparent"])
      .nullable()
      .describe(
        "Background mode. Use transparent for logos/stickers/icons when requested.",
      ),
    output_format: z
      .enum(["png", "jpeg", "webp"])
      .nullable()
      .describe(
        "Output file format. Defaults to png. Use jpeg/webp for smaller files if requested.",
      ),
    compression: z
      .number()
      .nullable()
      .describe(
        "Compression from 0-100 for jpeg/webp outputs. Leave null for default.",
      ),
  }),
  execute: async ({
    prompt,
    aspect_ratio,
    image_size,
    quality,
    background,
    output_format,
    compression,
  }) => {
    const ctx = toolContextManager.get();

    if (!ctx.channel || !("send" in ctx.channel)) {
      return { error: "No valid channel context available" };
    }

    const channel = ctx.channel as {
      send: (options: unknown) => Promise<unknown>;
    };
    const sizeChoice = normalizeImageSize(aspect_ratio, image_size);
    const effectiveBackground = background ?? "auto";
    const outputFormat = normalizeOutputFormat(
      output_format,
      effectiveBackground,
    );
    const compressionValue = normalizeCompression(compression, outputFormat);
    const effectiveQuality: OpenAIImageQuality = quality ?? "auto";

    toolLogger.info(
      {
        prompt,
        aspect_ratio,
        image_size,
        mapped_size: sizeChoice.size,
        quality: effectiveQuality,
        background: effectiveBackground,
        outputFormat,
      },
      "Generating image",
    );

    try {
      const response = await openai.images.generate({
        model: "gpt-image-1.5",
        prompt,
        n: 1,
        background: effectiveBackground,
        output_compression: compressionValue,
        output_format: outputFormat,
        quality: effectiveQuality,
        size: sizeChoice.size,
      });

      const image = response.data?.[0];
      let imageBuffer: Buffer | null = null;

      if (image?.b64_json) {
        imageBuffer = Buffer.from(image.b64_json, "base64");
      } else if (image?.url) {
        imageBuffer = await imageUrlToBuffer(image.url);
      }

      if (!imageBuffer) {
        return { error: "The image model did not return image data" };
      }

      await sendImageToChannel(channel, imageBuffer, prompt, outputFormat);

      toolLogger.info(
        {
          prompt: prompt.slice(0, 50),
          size: sizeChoice.size,
          requestedSize: sizeChoice.requested,
          bytes: imageBuffer.length,
        },
        "Image generated and sent",
      );

      return {
        success: true,
        format: outputFormat,
        size: sizeChoice.size,
        requested_size: sizeChoice.requested,
        size_source: sizeChoice.source,
        quality: effectiveQuality,
        background: effectiveBackground,
        compression: compressionValue ?? null,
        revised_prompt: image?.revised_prompt ?? null,
      };
    } catch (error) {
      const err = error as Error & { status?: number };
      toolLogger.error(
        {
          error: err.message,
          stack: err.stack,
          name: err.name,
          status: err.status,
        },
        "Failed to generate image",
      );
      return { error: "Failed to generate image", details: err.message };
    }
  },
});
