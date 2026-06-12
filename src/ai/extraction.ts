import { Agent } from "@openai/agents";
import { z } from "zod";
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
import { agentsRuntimeManager } from "./client";

const ExtractedFactSchema = z.object({
  key: z.string(),
  value: z.string(),
});

const ExtractionOutputSchema = z.object({
  facts: z.array(ExtractedFactSchema).max(AUTO_EXTRACT_MAX_FACTS),
});

type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

const EXTRACTION_SYSTEM_PROMPT = `You extract durable personal facts about a Discord user from chat history.

OUTPUT:
Return structured output with a facts array. Use an empty array if there are no durable, non-trivial facts.

RULES:
- Extract at most ${AUTO_EXTRACT_MAX_FACTS} facts.
- Only extract DURABLE facts about the named user (preferences, name, age, location, hobbies, accounts, jobs, projects, relationships, opinions held over time).
- DO NOT extract: passing moods, current activities ("eating lunch"), one-off events, things said by other users, things the bot said.
- Keys: short, snake_case, descriptive. Examples: "favorite_food", "occupation", "lastfm_username", "lives_in".
- Values: concise, factual, max 200 chars. Strip "the user" / "they" — write the fact directly.
- If a fact restates something already in "Existing memories", SKIP it.
- If unsure whether something is durable, SKIP it. Quality > quantity.

Example output shape: {"facts":[{"key":"favorite_color","value":"deep blue"},{"key":"occupation","value":"frontend engineer at a startup"}]}`;

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

async function storeFact(username: string, fact: ExtractedFact): Promise<void> {
  const key = sanitizeKey(fact.key);
  if (!key) return;
  const value = truncateValue(fact.value.trim());
  if (!value) return;

  const existing = await Memory.findOne({ scope: "user", username, key });
  if (existing?.pinned) return;

  const count = await Memory.countDocuments({ scope: "user", username });
  if (count >= USER_MEMORY_CAP) {
    const oldest = await Memory.findOne({
      scope: "user",
      username,
      pinned: false,
    }).sort({ updatedAt: 1 });
    if (oldest) await oldest.deleteOne();
  }

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
  return memories.map((memory) => `${memory.key}: ${memory.value}`);
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

  const existing = await fetchExistingMemoryKeys(username);
  const existingList = existing.map((entry) => `- ${entry}`).join("\n");
  const existingBlock =
    existing.length > 0
      ? `\nExisting memories about ${username} (do NOT restate these):\n${existingList}`
      : "";

  const userPrompt = `Target user: ${username}${existingBlock}

Chat history:
${history}

Extract durable facts about ${username}. Return an empty facts array if nothing new.`;

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
      outputType: ExtractionOutputSchema,
    });

    const result = await agentsRuntimeManager.getRunner().run(agent, userPrompt, {
      maxTurns: 1,
      signal: abortController.signal,
    });

    const facts =
      result.finalOutput?.facts.slice(0, AUTO_EXTRACT_MAX_FACTS) ?? [];
    aiLogger.info(
      { username, channelId, count: facts.length },
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
