import OpenAI from "openai";
import { tool } from "@openai/agents";
import { z } from "zod";
import { env } from "../env";
import { toolLogger } from "../logger";
import { formatError } from "../utils/types";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const DEFAULT_IMAGE_QUESTION =
  "Describe this image clearly. Include visible text, important objects, people, layout, and anything that seems relevant to the user's request. If the image is ambiguous, say what is uncertain.";

function normalizeImageUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("data:image/")) return trimmed;

  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Image URL must be http, https, or a data:image URI");
  }
  if (url.username || url.password) {
    throw new Error("Image URLs with embedded credentials are not allowed");
  }

  return url.toString();
}

function getVisionModel(): string {
  return env.VISION_MODEL_NAME ?? env.MODEL_NAME;
}

export const describeImageTool = tool({
  name: "describe_image",
  description:
    "Inspect an image from a Discord attachment/image URL using OpenAI vision. Use this when the user uploads an image, asks what is in an image, asks to read text from an image, or asks questions about visual details. Pass the attachment CDN URL from the message context.",
  parameters: z.object({
    image_url: z
      .string()
      .min(1)
      .max(8192)
      .describe("The public image URL or data:image URI to inspect."),
    question: z
      .string()
      .nullable()
      .describe(
        "Specific visual question to answer. Use null for a general description.",
      ),
    detail: z
      .enum(["auto", "low", "high"])
      .nullable()
      .describe(
        "Vision detail level. Use high for small text or fine details, low for quick broad descriptions, auto by default.",
      ),
  }),
  timeoutMs: 60_000,
  timeoutBehavior: "error_as_result",
  execute: async ({ image_url, question, detail }) => {
    const model = getVisionModel();
    const effectiveDetail = detail ?? "auto";

    try {
      const normalizedUrl = normalizeImageUrl(image_url);
      const prompt = question?.trim() || DEFAULT_IMAGE_QUESTION;

      toolLogger.info(
        { model, detail: effectiveDetail, imageUrlLength: normalizedUrl.length },
        "Describing image with OpenAI vision",
      );

      const response = await openai.responses.create({
        model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              {
                type: "input_image",
                image_url: normalizedUrl,
                detail: effectiveDetail,
              },
            ],
          },
        ],
        max_output_tokens: 900,
      });

      const description = response.output_text.trim();
      if (!description) {
        return { error: "The vision model returned an empty description" };
      }

      return {
        success: true,
        model,
        detail: effectiveDetail,
        description,
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { error: errorMessage, model, detail: effectiveDetail },
        "Image description failed",
      );
      return { error: "Failed to inspect image", details: errorMessage };
    }
  },
});
