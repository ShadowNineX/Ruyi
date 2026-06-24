import pino from 'pino';
import { z } from 'zod';

// Local logger to avoid a circular dep with src/logger.ts (which imports env).
const envLogger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    },
  },
}).child({ module: 'env' });

/**
 * Centralized, validated environment configuration.
 *
 * All `Bun.env` access in the app should go through this module so
 * misconfiguration fails fast at startup instead of crashing deep in code.
 */
const OPENROUTER_KEY_PREFIX = 'sk-or-v1-';
const STEAM_ACCOUNT_ID_PATTERN = /^[\w-]{1,64}$/;
const STEAM_ID64_PATTERN = /^\d{17}$/;

const steamAccountSchema = z.object({
  id: z
    .string()
    .regex(
      STEAM_ACCOUNT_ID_PATTERN,
      'Steam account id must be alphanumeric with underscores/hyphens, max 64 chars',
    ),
  personality: z.enum(['ruyi', 'tails']).default('ruyi'),
  refreshToken: z.string().min(1),
  botSteamId64: z
    .string()
    .regex(STEAM_ID64_PATTERN, 'botSteamId64 must be a SteamID64'),
});

export type SteamAccountEnv = z.infer<typeof steamAccountSchema>;

function hasMongoDatabaseName(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname.replace(/^\/+/, '').length > 0;
  } catch {
    return false;
  }
}

function parseSteamAccounts(
  value: string | undefined,
  ctx: z.RefinementCtx,
): SteamAccountEnv[] {
  const trimmed = value?.trim();
  if (!trimmed) { return []; }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: `STEAM_ACCOUNTS must be valid JSON: ${(error as Error).message}`,
    });
    return z.NEVER;
  }

  const result = z.array(steamAccountSchema).safeParse(parsedJson);
  if (result.success) { return result.data; }

  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: 'custom',
      message: issue.message,
      path: issue.path,
    });
  }
  return z.NEVER;
}

const envSchema = z.object({
  // Required
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  OPENAI_API_KEY: z
    .string()
    .min(1, 'OPENAI_API_KEY is required')
    .refine(
      value => !value.startsWith(OPENROUTER_KEY_PREFIX),
      'OPENAI_API_KEY must be a direct OpenAI API key, not an OpenRouter key',
    ),

  // Optional (with defaults)
  MONGO_URI: z
    .string()
    .default('mongodb://localhost:27017/ruyi')
    .refine(
      hasMongoDatabaseName,
      'MONGO_URI must include an explicit database name, for example mongodb://localhost:27017/ruyi',
    ),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Optional (no default)
  LASTFM_API_KEY: z.string().optional(),
  OPENAI_ADMIN_KEY: z
    .string()
    .optional()
    .transform(value => value?.trim() || undefined),
  GITHUB_PERSONAL_ACCESS_TOKEN: z
    .string()
    .optional()
    .transform(value => value?.trim() || undefined),
  GITHUB_MCP_URL: z
    .url('GITHUB_MCP_URL must be a valid URL')
    .default('https://api.githubcopilot.com/mcp/'),
  TAVILY_API_KEY: z
    .string()
    .optional()
    .transform(value => value?.trim() || undefined),
  SCRAPECREATORS_API_KEY: z
    .string()
    .optional()
    .transform(value => value?.trim() || undefined),
  STEAM_ACCOUNTS: z
    .string()
    .optional()
    .transform(parseSteamAccounts),
  STEAM_OWNER_STEAM_ID64: z
    .string()
    .optional()
    .transform(value => value?.trim() || undefined)
    .pipe(
      z
        .string()
        .regex(STEAM_ID64_PATTERN, 'STEAM_OWNER_STEAM_ID64 must be a SteamID64')
        .optional(),
    ),
  OWNER_DISCORD_USER_ID: z
    .string()
    .optional()
    .transform(value => value?.trim() || undefined),
  SMITHERY_API_KEY: z
    .string()
    .optional()
    .transform(value => value?.trim() || undefined),
  SMITHERY_NAMESPACE: z
    .string()
    .optional()
    .transform(value => value?.trim() || undefined),

  // Debug toggles
  DEBUG_PROMPTS: z
    .string()
    .optional()
    .transform(v => v === '1' || v === 'true'),
}).superRefine((value, ctx) => {
  if (value.STEAM_ACCOUNTS.length === 0) { return; }

  if (!value.STEAM_OWNER_STEAM_ID64) {
    ctx.addIssue({
      code: 'custom',
      path: ['STEAM_OWNER_STEAM_ID64'],
      message:
        'Steam integration requires STEAM_OWNER_STEAM_ID64 so all Steam bot accounts can share one owner profile',
    });
  }

  if (!value.OWNER_DISCORD_USER_ID) {
    ctx.addIssue({
      code: 'custom',
      path: ['OWNER_DISCORD_USER_ID'],
      message:
        'Steam integration requires OWNER_DISCORD_USER_ID so owner memories can be shared across Discord and Steam',
    });
  }

  const accountIds = new Set<string>();
  const botSteamIds = new Set<string>();
  for (const [index, account] of value.STEAM_ACCOUNTS.entries()) {
    if (accountIds.has(account.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['STEAM_ACCOUNTS', index, 'id'],
        message: `Duplicate Steam account id "${account.id}"`,
      });
    }
    if (botSteamIds.has(account.botSteamId64)) {
      ctx.addIssue({
        code: 'custom',
        path: ['STEAM_ACCOUNTS', index, 'botSteamId64'],
        message: `Duplicate Steam bot profile "${account.botSteamId64}"`,
      });
    }
    accountIds.add(account.id);
    botSteamIds.add(account.botSteamId64);
  }
});

type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(Bun.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    envLogger.fatal(
      { issues: parsed.error.issues },
      `Invalid environment configuration:\n${issues}`,
    );
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
