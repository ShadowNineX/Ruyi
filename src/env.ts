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
  MONGO_URI: z.string().default("mongodb://localhost:27017/ruyi"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // Optional (no default)
  LASTFM_API_KEY: z.string().optional(),
  OPENAI_ADMIN_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  GITHUB_PERSONAL_ACCESS_TOKEN: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  GITHUB_MCP_URL: z
    .url("GITHUB_MCP_URL must be a valid URL")
    .default("https://api.githubcopilot.com/mcp/"),
  TAVILY_API_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  SCRAPECREATORS_API_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  STEAM_REFRESH_TOKEN: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  STEAM_BOT_STEAM_ID64: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  STEAM_OWNER_STEAM_ID64: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  OWNER_DISCORD_USER_ID: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  SMITHERY_API_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  SMITHERY_NAMESPACE: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),

  // Debug toggles
  DEBUG_PROMPTS: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
}).superRefine((value, ctx) => {
  const steamValues = [
    value.STEAM_REFRESH_TOKEN,
    value.STEAM_BOT_STEAM_ID64,
    value.STEAM_OWNER_STEAM_ID64,
    value.OWNER_DISCORD_USER_ID,
  ];
  const hasAnySteamConfig = steamValues.some(Boolean);
  const hasAllSteamConfig = steamValues.every(Boolean);
  if (!hasAnySteamConfig || hasAllSteamConfig) return;

  for (const key of [
    "STEAM_REFRESH_TOKEN",
    "STEAM_BOT_STEAM_ID64",
    "STEAM_OWNER_STEAM_ID64",
    "OWNER_DISCORD_USER_ID",
  ] as const) {
    if (value[key]) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message:
        "Steam integration requires STEAM_REFRESH_TOKEN, STEAM_BOT_STEAM_ID64, STEAM_OWNER_STEAM_ID64, and OWNER_DISCORD_USER_ID together",
    });
  }
});

type Env = z.infer<typeof envSchema>;

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
