import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { toolLogger } from "../logger";
import { toolContextManager } from "../utils/types";
import { env } from "../env";

interface ImageGenerationResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      images?: Array<{
        type: string;
        image_url: { url: string };
      }>;
    };
  }>;
  error?: { message?: string; code?: string };
}

function buildRequestBody(
  prompt: string,
  aspectRatio: string | null,
  imageSize: string | null,
): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    model: "google/gemini-3-pro-image-preview",
    messages: [{ role: "user", content: prompt }],
    modalities: ["image", "text"],
  };

  if (aspectRatio || imageSize) {
    const imageConfig: Record<string, string> = {};
    if (aspectRatio) imageConfig.aspect_ratio = aspectRatio;
    if (imageSize) imageConfig.image_size = imageSize;
    requestBody.image_config = imageConfig;
  }

  return requestBody;
}

function extractImageData(data: ImageGenerationResponse): {
  error?: string;
  imageUrl?: string;
  content?: string | null;
} {
  if (data.error) {
    return { error: data.error.message ?? "Unknown error" };
  }

  const message = data.choices?.[0]?.message;
  const images = message?.images;

  if (!images || images.length === 0) {
    return { error: message?.content ?? "The model did not return an image" };
  }

  const imageUrl = images[0]?.image_url?.url;
  if (!imageUrl) {
    return { error: "Image URL missing from response" };
  }

  return { imageUrl, content: message?.content };
}

function parseBase64Image(imageUrl: string): {
  error?: string;
  format?: string;
  buffer?: Buffer;
} {
  const base64Match = /^data:image\/(\w+);base64,(.+)$/.exec(imageUrl);
  if (!base64Match) {
    return { error: "Invalid image data format received" };
  }

  const format = base64Match[1] ?? "png";
  const buffer = Buffer.from(base64Match[2] ?? "", "base64");
  return { format, buffer };
}

async function sendImageToChannel(
  channel: { send: (options: unknown) => Promise<unknown> },
  imageBuffer: Buffer,
  imageFormat: string,
  prompt: string,
): Promise<void> {
  const fileName = `generated-image.${imageFormat}`;
  const attachment = new AttachmentBuilder(imageBuffer, { name: fileName });

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("Generated Image")
    .setDescription(prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt)
    .setImage(`attachment://${fileName}`)
    .setTimestamp();

  await channel.send({ embeds: [embed], files: [attachment] });
}

export const generateImageTool = defineTool("generate_image", {
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
      .describe("Resolution: '1K', '2K', or '4K'."),
  }),
  handler: async ({ prompt, aspect_ratio, image_size }) => {
    const ctx = toolContextManager.get();

    if (!ctx.channel || !("send" in ctx.channel)) {
      return { error: "No valid channel context available" };
    }

    const channel = ctx.channel as {
      send: (options: unknown) => Promise<unknown>;
    };
    toolLogger.info({ prompt, aspect_ratio, image_size }, "Generating image");

    try {
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.MODEL_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            buildRequestBody(prompt, aspect_ratio, image_size),
          ),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        toolLogger.error(
          { status: response.status, error: errorText },
          "Image generation API error",
        );
        return {
          error: `Image generation failed with status ${response.status}`,
          details: errorText,
        };
      }

      const data = (await response.json()) as ImageGenerationResponse;
      const extracted = extractImageData(data);

      if (extracted.error) {
        toolLogger.error({ error: extracted.error }, "Image extraction failed");
        return { error: "Image generation failed", details: extracted.error };
      }

      const parsed = parseBase64Image(extracted.imageUrl!);
      if (parsed.error) {
        toolLogger.error(
          { imageUrl: extracted.imageUrl?.slice(0, 100) },
          parsed.error,
        );
        return { error: parsed.error };
      }

      await sendImageToChannel(channel, parsed.buffer!, parsed.format!, prompt);

      toolLogger.info(
        {
          prompt: prompt.slice(0, 50),
          format: parsed.format,
          size: parsed.buffer!.length,
        },
        "Image generated and sent",
      );

      return {
        success: true,
        format: parsed.format,
        description: extracted.content ?? null,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toolLogger.error({ error: errorMessage }, "Failed to generate image");
      return { error: "Failed to generate image", details: errorMessage };
    }
  },
});
