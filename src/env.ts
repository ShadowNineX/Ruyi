import { z } from "zod";
import pino from "pino";

// Local logger to avoid a circular dep with src/logger.ts (which imports env).
const envLogger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
}).child({ module: "env" });

/**
 * Centralized, validated environment configuration.
 *
 * All `Bun.env` access in the app should go through this module so
 * misconfiguration fails fast at startup instead of crashing deep in code.
 */
const NON_OPENAI_MODEL_PROVIDER_FRAGMENT = "open" + "router";
const OPENROUTER_KEY_PREFIX = "sk-or-v1-";

const envSchema = z.object({
  // Required
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  OPENAI_API_KEY: z
    .string()
    .min(1, "OPENAI_API_KEY is required")
    .refine(
      (value) => !value.startsWith(OPENROUTER_KEY_PREFIX),
      "OPENAI_API_KEY must be a direct OpenAI API key, not an OpenRouter key",
    ),

  // Optional (with defaults)
  MODEL_NAME: z
    .string()
    .default("gpt-5.4-mini")
    .refine(
      (value) =>
        !value.toLowerCase().includes(NON_OPENAI_MODEL_PROVIDER_FRAGMENT),
      "MODEL_NAME must be a direct OpenAI model id",
    ),
  VISION_MODEL_NAME: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined)
    .refine(
      (value) =>
        !value ||
        !value.toLowerCase().includes(NON_OPENAI_MODEL_PROVIDER_FRAGMENT),
      "VISION_MODEL_NAME must be a direct OpenAI model id",
    ),
  MONGO_URI: z.string().default("mongodb://localhost:27017/ruyi"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // Optional (no default)
  GITHUB_TOKEN: z.string().optional(),
  LASTFM_API_KEY: z.string().optional(),
  OPENAI_ADMIN_KEY: z.string().optional(),

  // Debug toggles
  DEBUG_PROMPTS: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(Bun.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    envLogger.fatal(
      { issues: parsed.error.issues },
      `Invalid environment configuration:\n${issues}`,
    );
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
