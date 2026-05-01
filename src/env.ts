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
const envSchema = z.object({
  // Required
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  MODEL_TOKEN: z.string().min(1, "MODEL_TOKEN is required"),

  // Optional (with defaults)
  MODEL_NAME: z.string().default("openrouter/auto"),
  MONGO_URI: z.string().default("mongodb://localhost:27017/ruyi"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // Optional (no default)
  GITHUB_TOKEN: z.string().optional(),
  LASTFM_API_KEY: z.string().optional(),
  SMITHERY_ACCESS_TOKEN: z.string().optional(),
  PROVISIONING_KEY: z.string().optional(),

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
