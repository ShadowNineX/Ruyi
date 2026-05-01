import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { aiLogger } from "../logger";
import { Memory } from "../db/models";
import {
  AUTO_EXTRACT_HISTORY_WINDOW,
  AUTO_EXTRACT_MAX_FACTS,
  AUTO_EXTRACT_TIMEOUT_MS,
  MEMORY_VALUE_MAX_LEN,
  USER_MEMORY_CAP,
} from "../constants";
import { conversationContext } from "./context";
import { copilotClientManager } from "./client";

interface ExtractedFact {
  key: string;
  value: string;
}

const EXTRACTION_SYSTEM_PROMPT = `You extract durable personal facts about a Discord user from chat history.

OUTPUT FORMAT:
Return ONLY a JSON array (no prose, no code fences) of objects: [{"key":"snake_case_key","value":"short fact"}]
Return [] if there are no durable, non-trivial facts.

RULES:
- Extract at most ${AUTO_EXTRACT_MAX_FACTS} facts.
- Only extract DURABLE facts about the named user (preferences, name, age, location, hobbies, accounts, jobs, projects, relationships, opinions held over time).
- DO NOT extract: passing moods, current activities ("eating lunch"), one-off events, things said by other users, things the bot said.
- Keys: short, snake_case, descriptive. Examples: "favorite_food", "occupation", "lastfm_username", "lives_in".
- Values: concise, factual, max 200 chars. Strip "the user" / "they" — write the fact directly.
- If a fact restates something already in "Existing memories", SKIP it.
- If unsure whether something is durable, SKIP it. Quality > quantity.

Example output: [{"key":"favorite_color","value":"deep blue"},{"key":"occupation","value":"frontend engineer at a startup"}]`;

const FENCE_REGEX = /```(?:json)?\s*([\s\S]*?)```/i;

function tryParseJsonArray(raw: string): ExtractedFact[] {
  // Tolerate code fences and surrounding prose.
  const trimmed = raw.trim();
  const fenceMatch = FENCE_REGEX.exec(trimmed);
  const candidate = fenceMatch?.[1]?.trim() ?? trimmed;

  // Find first '[' and last ']' to be lenient.
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];

  const slice = candidate.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (f): f is ExtractedFact =>
          typeof f === "object" &&
          f !== null &&
          typeof (f as ExtractedFact).key === "string" &&
          typeof (f as ExtractedFact).value === "string",
      )
      .slice(0, AUTO_EXTRACT_MAX_FACTS);
  } catch (error) {
    aiLogger.debug(
      { error: (error as Error).message, slice: slice.slice(0, 200) },
      "Failed to parse extraction output",
    );
    return [];
  }
}

function sanitizeKey(key: string): string {
  return key
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 64);
}

function truncateValue(value: string): string {
  if (value.length <= MEMORY_VALUE_MAX_LEN) return value;
  return value.slice(0, MEMORY_VALUE_MAX_LEN - 3) + "...";
}

async function storeFact(username: string, fact: ExtractedFact): Promise<void> {
  const key = sanitizeKey(fact.key);
  if (!key) return;
  const value = truncateValue(fact.value.trim());
  if (!value) return;

  // Evict oldest non-pinned, non-auto-pinned memory if at cap.
  const count = await Memory.countDocuments({ scope: "user", username });
  if (count >= USER_MEMORY_CAP) {
    const oldest = await Memory.findOne({
      scope: "user",
      username,
      pinned: false,
    }).sort({ updatedAt: 1 });
    if (oldest) await oldest.deleteOne();
  }

  // Don't overwrite a pinned fact with the same key.
  const existing = await Memory.findOne({ scope: "user", username, key });
  if (existing?.pinned) return;

  await Memory.updateOne(
    { key, scope: "user", username },
    {
      key,
      value,
      scope: "user",
      username,
      createdBy: username,
      source: "auto",
      pinned: false,
    },
    { upsert: true },
  );
}

async function fetchExistingMemoryKeys(username: string): Promise<string[]> {
  const memories = await Memory.find(
    { scope: "user", username },
    { key: 1, value: 1, _id: 0 },
  ).limit(40);
  return memories.map((m) => `${m.key}: ${m.value}`);
}

/**
 * Background extraction pass. Reads recent channel history, asks the model
 * for durable facts, and stores them as `source: "auto"` user memories.
 * Failures are logged and swallowed (best-effort, never throws).
 */
export async function autoExtractFacts(
  username: string,
  channelId: string,
): Promise<void> {
  const history = await conversationContext.getMemoryContext(
    channelId,
    AUTO_EXTRACT_HISTORY_WINDOW,
  );
  if (!history || history.length < 80) {
    aiLogger.debug(
      { username, channelId },
      "Skip extraction: history too short",
    );
    return;
  }

  const existing = await fetchExistingMemoryKeys(username);
  const existingList = existing.map((e) => `- ${e}`).join("\n");
  const existingBlock =
    existing.length > 0
      ? `\nExisting memories about ${username} (do NOT restate these):\n${existingList}`
      : "";

  const userPrompt = `Target user: ${username}${existingBlock}

Chat history:
${history}

Extract durable facts about ${username} as JSON. Return [] if nothing new.`;

  let client: CopilotClient | null = null;
  try {
    client = new CopilotClient({
      autoStart: true,
      autoRestart: false,
      logLevel: "warning",
    });
    await client.start();

    const session = await client.createSession({
      model: copilotClientManager.model,
      provider: copilotClientManager.getProviderConfig(),
      systemMessage: { mode: "replace", content: EXTRACTION_SYSTEM_PROMPT },
      streaming: true,
      infiniteSessions: { enabled: false },
      onPermissionRequest: approveAll,
    });

    const result = await session.sendAndWait(
      { prompt: userPrompt },
      AUTO_EXTRACT_TIMEOUT_MS,
    );
    const raw = result?.data.content ?? "";

    await session.disconnect();
    await client.stop();
    client = null;

    const facts = tryParseJsonArray(raw);
    aiLogger.info(
      { username, channelId, count: facts.length, raw: raw.slice(0, 200) },
      "Auto-extraction completed",
    );

    for (const fact of facts) {
      try {
        await storeFact(username, fact);
      } catch (error) {
        aiLogger.warn(
          { error: (error as Error).message, key: fact.key },
          "Failed to store auto-extracted fact",
        );
      }
    }
  } catch (error) {
    aiLogger.warn(
      { error: (error as Error).message, username, channelId },
      "Auto-extraction failed",
    );
    try {
      await client?.stop();
    } catch {
      // ignore cleanup
    }
  }
}
