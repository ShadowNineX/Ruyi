import { Agent } from "@openai/agents";
import { z } from "zod";
import type { ConfigScope } from "../config";
import { aiLogger } from "../logger";
import { CLASSIFIER_TIMEOUT_MS } from "../constants";
import { conversationContext } from "./context";
import { agentsRuntimeManager } from "./client";

const ReplyDecisionSchema = z.object({
  shouldReply: z.boolean(),
});

const POLITE_PREFIXES = ["please ", "pls "] as const;
const DIRECT_REQUEST_PREFIXES = [
  "can you ",
  "could you ",
  "would you ",
  "will you ",
] as const;
const MESSAGE_TARGET_WORDS = [
  "message",
  "messages",
  "channel",
  "chat",
  "history",
] as const;
const MEMORY_WORDS = ["memory", "memories"] as const;
const BOT_REPLY_WORDS = [
  "message",
  "reply",
  "replies",
  "response",
  "answer",
  "that",
  "last",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function normalizeForMatching(message: string): string {
  return message.toLowerCase().trim().replace(/\s+/g, " ");
}

function stripAnyPrefix(text: string, prefixes: readonly string[]): string {
  const prefix = prefixes.find((candidate) => text.startsWith(candidate));
  return prefix ? text.slice(prefix.length) : text;
}

function stripDirectRequestLeadIn(message: string): string {
  let text = normalizeForMatching(message);
  text = stripAnyPrefix(text, POLITE_PREFIXES);
  text = stripAnyPrefix(text, DIRECT_REQUEST_PREFIXES);
  return stripAnyPrefix(text, POLITE_PREFIXES);
}

function isWordCharacter(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || char === "'"
  );
}

function startsWithWord(text: string, word: string): boolean {
  return text.startsWith(word) && !isWordCharacter(text[word.length]);
}

function startsWithAnyWord(text: string, words: readonly string[]): boolean {
  return words.some((word) => startsWithWord(text, word));
}

function startsWithPhrase(text: string, phrase: string): boolean {
  return text === phrase || text.startsWith(`${phrase} `);
}

function startsWithAnyPhrase(
  text: string,
  phrases: readonly string[],
): boolean {
  return phrases.some((phrase) => startsWithPhrase(text, phrase));
}

function getWords(text: string): Set<string> {
  return new Set(text.split(/[^a-z0-9']+/).filter(Boolean));
}

function containsAnyWord(text: string, words: readonly string[]): boolean {
  const textWords = getWords(text);
  return words.some((word) => textWords.has(word));
}

function containsHttpUrl(text: string): boolean {
  return text.includes("http://") || text.includes("https://");
}

const DIRECT_ACTION_RULES: ReadonlyArray<(text: string) => boolean> = [
  (text) => startsWithAnyWord(text, ["pin", "unpin"]),
  (text) =>
    startsWithAnyWord(text, ["clear", "delete", "remove", "purge", "clean"]) &&
    containsAnyWord(text, MESSAGE_TARGET_WORDS),
  (text) =>
    startsWithAnyWord(text, ["react"]) ||
    startsWithAnyPhrase(text, [
      "add reaction",
      "add a reaction",
      "remove reaction",
      "remove a reaction",
    ]),
  (text) =>
    startsWithAnyWord(text, ["search", "find", "fetch"]) ||
    startsWithPhrase(text, "look up"),
  (text) =>
    startsWithAnyWord(text, [
      "read",
      "summarize",
      "inspect",
      "quote",
      "open",
    ]) && containsHttpUrl(text),
  (text) => startsWithAnyWord(text, ["remember", "store", "forget"]),
  (text) =>
    startsWithAnyWord(text, ["show", "list", "recall"]) &&
    containsAnyWord(text, MEMORY_WORDS),
  (text) =>
    startsWithAnyWord(text, ["what", "which"]) &&
    containsAnyWord(text, MEMORY_WORDS),
  (text) =>
    startsWithAnyWord(text, [
      "create",
      "edit",
      "assign",
      "give",
      "add",
      "remove",
    ]) && containsAnyWord(text, ["role"]),
  (text) =>
    startsWithAnyWord(text, ["edit", "revise", "correct", "fix", "replace"]) &&
    containsAnyWord(text, BOT_REPLY_WORDS),
  (text) =>
    startsWithAnyWord(text, ["send", "make", "create"]) &&
    containsAnyWord(text, ["embed"]),
  (text) => startsWithAnyWord(text, ["calculate", "calc", "solve"]),
  (text) =>
    startsWithAnyWord(text, ["what", "what's", "whats"]) &&
    containsAnyWord(text, ["time", "date"]),
];

function isDirectActionRequest(message: string): boolean {
  const text = stripDirectRequestLeadIn(message);
  return DIRECT_ACTION_RULES.some((rule) => rule(text));
}

function getDeterministicReplyReason(
  message: string,
  botName: string,
): "bot_name" | "action_request" | null {
  const aliases = [...new Set([botName, "Ruyi", "Abacus"].filter(Boolean))];
  const botNamePattern = new RegExp(
    String.raw`\b(?:${aliases.map(escapeRegExp).join("|")})\b`,
    "i",
  );

  if (botNamePattern.test(message)) return "bot_name";
  if (isDirectActionRequest(message)) return "action_request";
  return null;
}

class ReplyClassifier {
  async shouldReply(
    message: string,
    botName: string,
    channelId?: string,
    configScope?: ConfigScope | null,
  ): Promise<boolean> {
    const trimmedMessage = message.trim();
    const deterministicReason = getDeterministicReplyReason(
      trimmedMessage,
      botName,
    );
    if (deterministicReason) {
      aiLogger.debug(
        {
          messagePreview: trimmedMessage.slice(0, 50),
          reason: deterministicReason,
        },
        "shouldReply deterministic yes",
      );
      return true;
    }

    let historyContext = "";
    if (channelId) {
      historyContext = await conversationContext.getMemoryContext(
        channelId,
        15,
      );
    }

    const historySection = historyContext
      ? `\nPrevious chat history:\n${historyContext}`
      : "";

    const systemPromptText = `You are a context analyzer for "${botName}", a friendly Discord bot assistant (Ruyi from Nine Sols). Decide whether Ruyi should reply.

Set shouldReply to true if:
- Greetings like "hey", "hi", "hello", "yo", "sup", "good morning", etc.
- Questions directed at the chat/room
- Someone asking for help, advice, or opinions
- Messages that invite conversation or responses
- Someone seems lonely or wants to chat
- Interesting topics worth engaging with
- Somebody mentions your name or the bot's name (Ruyi/Abacus)
- If it's a continuation of an ongoing conversation with the bot, even without direct mention like "as we were saying..., back to our previous topic..., continuing our chat about..., yes, please do, etc.

Set shouldReply to false if:
- Message is clearly directed at another specific person
- Private conversation between others
- Just emojis, reactions, or "lol/lmao" type responses
- Spam or nonsense
- Very short messages with no substance (like just "ok" or "yeah" unless it's part of user's answer to the bot)${historySection}
`;

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      CLASSIFIER_TIMEOUT_MS,
    );

    try {
      const agent = new Agent({
        name: "Ruyi reply classifier",
        instructions: systemPromptText,
        model: agentsRuntimeManager.getModel(configScope),
        modelSettings: agentsRuntimeManager.getModelSettings(configScope),
        outputType: ReplyDecisionSchema,
      });

      const result = await agentsRuntimeManager
        .getRunner()
        .run(agent, message, {
          maxTurns: 1,
          signal: abortController.signal,
        });

      const decision = result.finalOutput?.shouldReply ?? false;
      aiLogger.debug(
        { messagePreview: message.slice(0, 50), decision },
        "shouldReply decision",
      );
      return decision;
    } catch (error) {
      const err = error as Error;
      aiLogger.warn(
        {
          error: err.message,
          stack: err.stack,
          name: err.name,
          messagePreview: message.slice(0, 50),
        },
        "shouldReply failed, defaulting to no",
      );
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const replyClassifier = new ReplyClassifier();
