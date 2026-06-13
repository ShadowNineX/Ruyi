import OpenAI from "openai";
import { tool } from "@openai/agents";
import { z } from "zod";
import { env } from "../env";
import { toolLogger } from "../logger";
import { formatError, toolContextManager } from "../utils/types";
import { configManager } from "../config";
import { getCurrentToolConfigScope } from "../utils/discord-scope";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const DEFAULT_MAX_OUTPUT_TOKENS = 900;
const REVERSE_IMAGE_MAX_OUTPUT_TOKENS = 350;
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
  return configManager.getVisionModel(getCurrentToolConfigScope());
}

function isImageDownloadFailure(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("downloading file") ||
    normalized.includes("upstream status code") ||
    normalized.includes("could not download") ||
    normalized.includes("failed to download")
  );
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
    const normalizedUrl = normalizeImageUrl(image_url);
    const previousFailure =
      toolContextManager.getImageDescriptionFailure(normalizedUrl);
    if (previousFailure) {
      return {
        error: "Image URL already failed inspection this turn",
        details: previousFailure,
        retryable: false,
        final_answer_required:
          toolContextManager.imageDescriptionFailureLimitExceeded(),
        instruction:
          "Do not call describe_image again for this URL in this turn. Use a different image URL only if one is already available; otherwise continue with other evidence, or tell the user the image URL could not be inspected directly.",
      };
    }

    if (toolContextManager.imageDescriptionFailureLimitExceeded()) {
      return {
        error: "Image inspection download failure limit exhausted",
        retryable: false,
        final_answer_required: true,
        instruction:
          "Too many image URLs failed inspection this turn. Stop calling describe_image and answer using the evidence already gathered.",
      };
    }

    const budgetDecision = toolContextManager.consumeToolCall("describe_image");
    if (!budgetDecision.allowed) {
      return toolContextManager.budgetDeniedResult(budgetDecision);
    }

    const model = getVisionModel();
    const reverseImageWorkflow =
      toolContextManager.isReverseImageWorkflowActive();
    const effectiveDetail = reverseImageWorkflow ? "low" : (detail ?? "auto");
    const maxOutputTokens = reverseImageWorkflow
      ? REVERSE_IMAGE_MAX_OUTPUT_TOKENS
      : DEFAULT_MAX_OUTPUT_TOKENS;

    try {
      const prompt = question?.trim() || DEFAULT_IMAGE_QUESTION;

      toolLogger.info(
        {
          model,
          detail: effectiveDetail,
          imageUrlLength: normalizedUrl.length,
          reverseImageWorkflow,
        },
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
        max_output_tokens: maxOutputTokens,
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
      const isDownloadFailure = isImageDownloadFailure(errorMessage);
      const failureCount = toolContextManager.rememberImageDescriptionFailure(
        normalizedUrl,
        errorMessage,
      );
      if (isDownloadFailure) {
        toolContextManager.refundToolCall("describe_image");
      }

      toolLogger.error(
        {
          error: errorMessage,
          model,
          detail: effectiveDetail,
          imageUrlLength: normalizedUrl.length,
          budgetRefunded: isDownloadFailure,
          failureCount,
        },
        "Image description failed",
      );
      return {
        error: "Failed to inspect image",
        details: errorMessage,
        retryable: false,
        budget_refunded: isDownloadFailure,
        final_answer_required:
          toolContextManager.imageDescriptionFailureLimitExceeded() ||
          (reverseImageWorkflow && !isDownloadFailure),
        instruction:
          isDownloadFailure
            ? "Do not retry describe_image for this same image URL in this turn. This download failure did not consume the useful describe_image budget; use a different image URL only if one is already available."
            : "Do not retry describe_image for this same image URL in this turn. Continue with other evidence or tell the user the image could not be inspected directly.",
      };
    }
  },
});
