/**
 * Centralized magic numbers and tunables.
 * Prefer importing from here over inlining literals.
 */

export const CHAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const CLASSIFIER_TIMEOUT_MS = 30 * 1000;
export const PERMISSION_TIMEOUT_MS = 60 * 1000;
export const CHAT_TURN_TIMEOUT_MS
  = CHAT_TIMEOUT_MS + PERMISSION_TIMEOUT_MS + 15 * 1000;
export const DISCORD_OPERATION_TIMEOUT_MS = 10 * 1000;
export const CHAT_TYPING_INTERVAL_MS = 8 * 1000;
export const STREAM_PREVIEW_EDIT_INTERVAL_MS = 1000;
export const STREAM_PREVIEW_MAX_LENGTH = 1800;
export const AGENT_MAX_TURNS = 20;
export const MAX_AGENT_IMAGE_INPUTS = 10;
export const REMINDER_SCHEDULER_MAX_SLEEP_MS = 24 * 60 * 60 * 1000;
export const REMINDER_DUE_BATCH_SIZE = 20;
export const REMINDER_LIST_LIMIT = 10;
export const REMINDER_MAX_DELIVERY_ATTEMPTS = 5;
export const REMINDER_DELIVERY_RETRY_DELAY_MS = 30 * 1000;
export const REMINDER_TEXT_MAX_LENGTH = 500;
export const REMINDER_LIST_TEXT_MAX_LENGTH = 160;
export const REMINDER_MESSAGE_GENERATION_TIMEOUT_MS = 45 * 1000;
export const REMINDER_MESSAGE_MAX_LENGTH = 700;
export const REMINDER_PROCESSING_STALE_MS
  = REMINDER_MESSAGE_GENERATION_TIMEOUT_MS + 60 * 1000;
export const REMINDER_SCHEDULER_ERROR_RETRY_MS = 60 * 1000;

export const BACKGROUND_TASK_MODEL = 'gpt-5.4-nano';
export const PROACTIVE_TASK_MODEL = 'gpt-5.4-mini';
export const TOOL_ANSWER_MODEL = 'gpt-5.4-mini';

export const ONGOING_CONVERSATION_WINDOW_MS = 30 * 60 * 1000;

export const AGENT_SESSION_ITEM_CAP = 80;
export const AGENT_SESSION_SEED_MESSAGE_LIMIT = 40;
export const AGENT_SESSION_COMPACTION_TRIGGER_ITEMS = 70;
export const AGENT_SESSION_RECENT_ITEM_KEEP = 40;
export const AGENT_SESSION_COMPACTION_ITEM_MAX_LEN = 1200;
export const AGENT_SESSION_SUMMARY_MAX_LEN = 4000;
export const AGENT_SESSION_COMPACTION_TIMEOUT_MS = 60 * 1000;
export const CHANNEL_SUMMARY_CONTEXT_MAX_LEN = 3000;

export const USER_MEMORY_CAP = 100;
export const MEMORY_VALUE_MAX_LEN = 500;

// Auto-extraction (c.ai-style long-term memory)
export const AUTO_EXTRACT_THRESHOLD = 12; // user messages per (channel, user) before extraction
export const AUTO_EXTRACT_COOLDOWN_MS = 10 * 60 * 1000; // min time between extractions per user
export const AUTO_EXTRACT_HISTORY_WINDOW = 25; // recent messages fed to extractor
export const AUTO_EXTRACT_MAX_FACTS = 5; // max facts stored per extraction pass
export const AUTO_EXTRACT_TIMEOUT_MS = 45 * 1000;

// Character.AI-style away messages
export const AWAY_MESSAGE_GENERATION_TIMEOUT_MS = 45 * 1000;
export const AWAY_MESSAGE_DEFAULT_DELAY_MINUTES = 120;
export const AWAY_MESSAGE_DEFAULT_COOLDOWN_HOURS = 24;
export const AWAY_MESSAGE_MIN_DELAY_MINUTES = 15;
export const AWAY_MESSAGE_MAX_DELAY_MINUTES = 7 * 24 * 60;
export const AWAY_MESSAGE_MIN_COOLDOWN_HOURS = 1;
export const AWAY_MESSAGE_MAX_COOLDOWN_HOURS = 30 * 24;
export const AWAY_MESSAGE_MAX_LENGTH = 700;

// Steam Community profile comments
export const STEAM_PROFILE_COMMENT_MAX_LENGTH = 1000;
export const STEAM_PROFILE_DATA_CACHE_TTL_MS = 2 * 60 * 1000;
export const STEAM_PROFILE_DATA_CACHE_MAX_ENTRIES = 200;
export const STEAM_PROFILE_TOOL_LIMIT_MAX = 100;
export const STEAM_INVENTORY_ITEM_LIMIT_MAX = 50;

// Paid/read-only external API caches
export const PINTEREST_DATA_CACHE_TTL_MS = 5 * 60 * 1000;
export const PINTEREST_DATA_CACHE_MAX_ENTRIES = 150;

// Context tiering
export const PINNED_CONTEXT_LIMIT = 15;
export const RECENT_USER_MEMORY_LIMIT = 20;
