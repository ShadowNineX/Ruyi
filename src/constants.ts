/**
 * Centralized magic numbers and tunables.
 * Prefer importing from here over inlining literals.
 */

export const CHAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const CLASSIFIER_TIMEOUT_MS = 30 * 1000;
export const PERMISSION_TIMEOUT_MS = 60 * 1000;
export const CHAT_TURN_TIMEOUT_MS =
  CHAT_TIMEOUT_MS + PERMISSION_TIMEOUT_MS + 15 * 1000;
export const DISCORD_OPERATION_TIMEOUT_MS = 10 * 1000;
export const CHAT_TYPING_INTERVAL_MS = 8 * 1000;
export const AGENT_MAX_TURNS = 20;

export const ONGOING_CONVERSATION_WINDOW_MS = 30 * 60 * 1000;

export const HISTORY_DB_CAP = 100;
export const HISTORY_PROMPT_LIMIT = 20;
export const MEMORY_CONTEXT_LIMIT = 20;
export const AGENT_SESSION_ITEM_CAP = 80;
export const AGENT_SESSION_SEED_MESSAGE_LIMIT = 40;
export const AGENT_SESSION_COMPACTION_TRIGGER_ITEMS = 70;
export const AGENT_SESSION_RECENT_ITEM_KEEP = 40;
export const AGENT_SESSION_COMPACTION_ITEM_MAX_LEN = 1200;
export const AGENT_SESSION_SUMMARY_MAX_LEN = 4000;
export const AGENT_SESSION_COMPACTION_TIMEOUT_MS = 60 * 1000;
export const CHANNEL_SUMMARY_CONTEXT_MAX_LEN = 3000;

export const USER_MEMORY_CAP = 30;
export const GLOBAL_MEMORY_CAP = 50;
export const MEMORY_VALUE_MAX_LEN = 500;

// Auto-extraction (c.ai-style long-term memory)
export const AUTO_EXTRACT_THRESHOLD = 12; // user messages per (channel, user) before extraction
export const AUTO_EXTRACT_COOLDOWN_MS = 10 * 60 * 1000; // min time between extractions per user
export const AUTO_EXTRACT_HISTORY_WINDOW = 25; // recent messages fed to extractor
export const AUTO_EXTRACT_MAX_FACTS = 5; // max facts stored per extraction pass
export const AUTO_EXTRACT_TIMEOUT_MS = 45 * 1000;

// Context tiering
export const PINNED_CONTEXT_LIMIT = 15;
export const RECENT_USER_MEMORY_LIMIT = 8;
export const GLOBAL_CONTEXT_LIMIT = 8;
