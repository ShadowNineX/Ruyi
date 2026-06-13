import { Agent } from "@openai/agents";
import { z } from "zod";
import { aiLogger } from "../logger";
import { Memory } from "../db/models";
import type { IMemory } from "../db/models/memory";
import {
  AUTO_EXTRACT_HISTORY_WINDOW,
  AUTO_EXTRACT_MAX_FACTS,
  AUTO_EXTRACT_TIMEOUT_MS,
  MEMORY_VALUE_MAX_LEN,
  USER_MEMORY_CAP,
} from "../constants";
import { conversationContext } from "./context";
import { agentsRuntimeManager } from "./client";

const ExtractedMemoryOperationSchema = z.object({
  action: z.enum(["create", "update"]),
  key: z.string(),
  value: z.string(),
  existing_key: z.string().nullable(),
});

const ExtractionOutputSchema = z.object({
  memories: z.array(ExtractedMemoryOperationSchema).max(AUTO_EXTRACT_MAX_FACTS),
});

type ExtractedMemoryOperation = z.infer<typeof ExtractedMemoryOperationSchema>;

interface ExistingMemorySummary {
  key: string;
  value: string;
  pinned: boolean;
  source: "user" | "auto";
}

type MemoryOperationOutcome = "created" | "updated" | "skipped";

const EXTRACTION_SYSTEM_PROMPT = `You extract durable personal facts about a Discord user from chat history.

OUTPUT:
Return structured output with a memories array. Use an empty array if there are no durable, non-trivial facts to create or update.
Each item must be one of:
- {"action":"create","key":"snake_case_key","value":"concise fact","existing_key":null}
- {"action":"update","key":"existing_or_better_key","value":"updated concise fact","existing_key":"exact_existing_key"}

RULES:
- Extract at most ${AUTO_EXTRACT_MAX_FACTS} memory operations.
- Only extract DURABLE facts about the named user (preferences, name, age, location, hobbies, accounts, jobs, projects, relationships, opinions held over time).
- DO NOT extract: passing moods, current activities ("eating lunch"), one-off events, things said by other users, things the bot said.
- Keys: short, snake_case, descriptive. Examples: "favorite_food", "occupation", "lastfm_username", "lives_in".
- Values: concise, factual, max 200 chars. Strip "the user" / "they" — write the fact directly.
- If the fact restates an existing memory, SKIP it.
- If the fact corrects, replaces, or refines an existing non-pinned memory, return action="update" with existing_key set to the exact existing key.
- If the fact belongs under an existing key but the key name could be better, use action="update", existing_key as the old key, and key as the better snake_case key.
- Pinned memories are protected user-curated facts. Do not update pinned memories; skip if new chat merely conflicts with a pinned memory.
- Prefer updating an existing related memory over creating a new near-duplicate key.
- If unsure whether something is durable, SKIP it. Quality > quantity.

Example output shape: {"memories":[{"action":"create","key":"favorite_color","value":"deep blue","existing_key":null},{"action":"update","key":"occupation","value":"frontend engineer at a startup","existing_key":"job"}]}`;

function trimEdgeUnderscores(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === "_") start += 1;
  while (end > start && value[end - 1] === "_") end -= 1;

  return value.slice(start, end);
}

function sanitizeKey(key: string): string {
  const normalized = key
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/g, "_");

  return trimEdgeUnderscores(normalized).slice(0, 64);
}

function truncateValue(value: string): string {
  if (value.length <= MEMORY_VALUE_MAX_LEN) return value;
  return value.slice(0, MEMORY_VALUE_MAX_LEN - 3) + "...";
}

function normalizeComparable(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim()
    .replaceAll(/\s+/g, " ");
}

function valuesLookDuplicate(first: string, second: string): boolean {
  const normalizedFirst = normalizeComparable(first);
  const normalizedSecond = normalizeComparable(second);
  if (!normalizedFirst || !normalizedSecond) return false;
  if (normalizedFirst === normalizedSecond) return true;

  const shortestLength = Math.min(
    normalizedFirst.length,
    normalizedSecond.length,
  );
  return (
    shortestLength >= 16 &&
    (normalizedFirst.includes(normalizedSecond) ||
      normalizedSecond.includes(normalizedFirst))
  );
}

function valuesMatchExactly(first: string, second: string): boolean {
  return normalizeComparable(first) === normalizeComparable(second);
}

function formatExistingMemories(memories: ExistingMemorySummary[]): string {
  return memories
    .map((memory) => {
      const pinned = memory.pinned ? "[PINNED] " : "";
      return `- ${pinned}${memory.key}: ${memory.value} (source: ${memory.source})`;
    })
    .join("\n");
}

async function evictOldestWritableMemory(
  username: string,
): Promise<boolean> {
  const count = await Memory.countDocuments({ scope: "user", username });
  if (count < USER_MEMORY_CAP) return true;

  const oldest = await Memory.findOne({
    scope: "user",
    username,
    pinned: false,
  }).sort({ updatedAt: 1 });
  if (!oldest) return false;

  await oldest.deleteOne();
  return true;
}

async function findRelatedMemory(
  username: string,
  key: string,
  value: string,
): Promise<IMemory | null> {
  const memories = await Memory.find({ scope: "user", username })
    .sort({ pinned: -1, updatedAt: -1 })
    .limit(80);

  return (
    memories.find(
      (memory) =>
        sanitizeKey(memory.key) === key ||
        valuesLookDuplicate(memory.value, value),
    ) ?? null
  );
}

async function findOperationTarget(
  username: string,
  key: string,
  existingKey: string | null,
  value: string,
): Promise<IMemory | null> {
  if (existingKey) {
    const existing = await Memory.findOne({
      scope: "user",
      username,
      key: existingKey,
    });
    if (existing) return existing;
  }

  const exact = await Memory.findOne({ scope: "user", username, key });
  if (exact) return exact;

  return findRelatedMemory(username, key, value);
}

async function renameMemoryIfNeeded(
  memory: IMemory,
  nextKey: string,
): Promise<IMemory | null> {
  if (memory.key === nextKey) return memory;

  const conflicting = await Memory.findOne({
    scope: memory.scope,
    username: memory.username,
    key: nextKey,
  });
  if (!conflicting) {
    memory.key = nextKey;
    return memory;
  }
  if (conflicting.pinned || String(conflicting._id) === String(memory._id)) {
    return conflicting;
  }

  await memory.deleteOne();
  return conflicting;
}

async function applyMemoryOperation(
  username: string,
  operation: ExtractedMemoryOperation,
): Promise<MemoryOperationOutcome> {
  const key = sanitizeKey(operation.key);
  if (!key) return "skipped";
  const value = truncateValue(operation.value.trim());
  if (!value) return "skipped";
  const existingKey = operation.existing_key
    ? sanitizeKey(operation.existing_key)
    : null;

  const target = await findOperationTarget(username, key, existingKey, value);
  if (target?.pinned) return "skipped";

  if (target) {
    if (target.key === key && valuesMatchExactly(target.value, value)) {
      return "skipped";
    }

    const writableTarget = await renameMemoryIfNeeded(target, key);
    if (!writableTarget || writableTarget.pinned) return "skipped";
    writableTarget.value = value;
    await writableTarget.save();
    return "updated";
  }

  if (operation.action === "update") return "skipped";
  if (!(await evictOldestWritableMemory(username))) return "skipped";

  await Memory.create({
    key,
    value,
    scope: "user",
    username,
    createdBy: username,
    source: "auto",
    pinned: false,
  });
  return "created";
}

async function fetchExistingMemories(
  username: string,
): Promise<ExistingMemorySummary[]> {
  const memories = await Memory.find(
    { scope: "user", username },
    { key: 1, value: 1, pinned: 1, source: 1, _id: 0 },
  )
    .sort({ pinned: -1, updatedAt: -1 })
    .limit(40);

  return memories.map((memory) => ({
    key: memory.key,
    value: memory.value,
    pinned: memory.pinned,
    source: memory.source,
  }));
}

/**
 * Background extraction pass. Reads recent channel history, asks the model
 * for durable facts, and stores them as `source: "auto"` user memories.
 * Returns true only when the extraction pass completed.
 */
export async function autoExtractFacts(
  username: string,
  channelId: string,
): Promise<boolean> {
  const history = await conversationContext.getMemoryContext(
    channelId,
    AUTO_EXTRACT_HISTORY_WINDOW,
  );
  if (!history || history.length < 80) {
    aiLogger.debug(
      { username, channelId },
      "Skip extraction: history too short",
    );
    return false;
  }

  const existing = await fetchExistingMemories(username);
  const existingBlock =
    existing.length > 0
      ? `\nExisting memories about ${username}:\n${formatExistingMemories(existing)}`
      : "";

  const userPrompt = `Target user: ${username}${existingBlock}

Chat history:
${history}

Extract durable facts about ${username}. Return create/update memory operations, or an empty memories array if nothing should change.`;

  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    AUTO_EXTRACT_TIMEOUT_MS,
  );

  try {
    const agent = new Agent({
      name: "Ruyi memory extractor",
      instructions: EXTRACTION_SYSTEM_PROMPT,
      model: agentsRuntimeManager.model,
      modelSettings: agentsRuntimeManager.modelSettings,
      outputType: ExtractionOutputSchema,
    });

    const result = await agentsRuntimeManager.getRunner().run(agent, userPrompt, {
      maxTurns: 1,
      signal: abortController.signal,
    });

    const operations =
      result.finalOutput?.memories.slice(0, AUTO_EXTRACT_MAX_FACTS) ?? [];
    const outcomes: Record<MemoryOperationOutcome, number> = {
      created: 0,
      updated: 0,
      skipped: 0,
    };

    for (const operation of operations) {
      try {
        const outcome = await applyMemoryOperation(username, operation);
        outcomes[outcome] += 1;
      } catch (error) {
        aiLogger.warn(
          {
            error: (error as Error).message,
            action: operation.action,
            key: operation.key,
            existingKey: operation.existing_key,
          },
          "Failed to apply auto-extracted memory operation",
        );
      }
    }

    aiLogger.info(
      {
        username,
        channelId,
        count: operations.length,
        created: outcomes.created,
        updated: outcomes.updated,
        skipped: outcomes.skipped,
      },
      "Auto-extraction completed",
    );

    return true;
  } catch (error) {
    aiLogger.warn(
      {
        error: (error as Error).message,
        stack: (error as Error).stack,
        name: (error as Error).name,
        username,
        channelId,
      },
      "Auto-extraction failed",
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
