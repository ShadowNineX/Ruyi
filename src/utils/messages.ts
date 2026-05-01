import type { Message } from "discord.js";
import type { ChatMessage } from "../ai";
import { botLogger } from "../logger";

// Patterns for content that should not be split
const PROTECTED_PATTERNS = [
  /https?:\/\/[^\s\])<>]+/g, // URLs
  /\[[^\]]*\]\([^)]+\)/g, // Markdown links
  /```[\s\S]*?```/g, // Code blocks
  /`[^`]+`/g, // Inline code
];

// Find all ranges in the text that should not be split
function findProtectedRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  return ranges;
}

// Check if an index falls within any protected range
function isIndexProtected(
  index: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) => index > range.start && index < range.end);
}

// Find the nearest protected range that the index falls within
function findProtectedRangeStart(
  index: number,
  ranges: Array<{ start: number; end: number }>,
): number | null {
  for (const range of ranges) {
    if (index > range.start && index < range.end) {
      return range.start;
    }
  }
  return null;
}

// Find a safe split point that doesn't break protected content
function findSafeSplitPoint(
  text: string,
  maxLength: number,
  protectedRanges: Array<{ start: number; end: number }>,
): number {
  let splitIndex = maxLength;

  // Check if split point is inside protected content
  const protectedStart = findProtectedRangeStart(splitIndex, protectedRanges);
  if (protectedStart !== null) {
    splitIndex = protectedStart;
  }

  // Try to find a natural break point (newline or space)
  if (splitIndex > 100) {
    const newlineIndex = text.lastIndexOf("\n", splitIndex);
    if (newlineIndex > splitIndex - 300 && newlineIndex > 0) {
      if (!isIndexProtected(newlineIndex, protectedRanges)) {
        return newlineIndex + 1;
      }
    }

    const spaceIndex = text.lastIndexOf(" ", splitIndex);
    if (spaceIndex > splitIndex - 200 && spaceIndex > 0) {
      if (!isIndexProtected(spaceIndex, protectedRanges)) {
        return spaceIndex + 1;
      }
    }
  }

  // Fallback: if splitIndex is too small, force split at maxLength
  return splitIndex < 50 ? maxLength : splitIndex;
}

export function splitMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const protectedRanges = findProtectedRanges(remaining);
    const splitIndex = findSafeSplitPoint(
      remaining,
      maxLength,
      protectedRanges,
    );

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

export interface SentChunk {
  id: string;
  content: string;
}

export async function sendReplyChunks(
  message: Message,
  reply: string,
  user: string,
): Promise<SentChunk[]> {
  const chunks = splitMessage(reply);
  const sentChunks: SentChunk[] = [];

  for (const [i, chunk] of chunks.entries()) {
    if (i === 0) {
      try {
        const sent = await message.reply(chunk);
        sentChunks.push({ id: sent.id, content: chunk });
      } catch (error) {
        // If reply fails (e.g., original message was deleted), send as regular message
        const err = error as { code?: number };
        if (err.code === 50035 && "send" in message.channel) {
          botLogger.debug(
            "Original message unavailable, sending as regular message",
          );
          const sent = await message.channel.send(chunk);
          sentChunks.push({ id: sent.id, content: chunk });
        } else {
          throw error;
        }
      }
    } else if ("send" in message.channel) {
      const sent = await message.channel.send(chunk);
      sentChunks.push({ id: sent.id, content: chunk });
    }
  }
  botLogger.info(
    { user, replyLength: reply.length, chunks: chunks.length },
    "Sent reply",
  );
  return sentChunks;
}

export async function fetchReplyChain(
  message: Message,
  maxDepth = 10,
): Promise<ChatMessage[]> {
  const chain: ChatMessage[] = [];
  let currentRef: { channelId: string; messageId: string } | null = message
    .reference?.messageId
    ? { channelId: message.channel.id, messageId: message.reference.messageId }
    : null;
  let depth = 0;

  if (!("messages" in message.channel)) return chain;

  while (currentRef && depth < maxDepth) {
    try {
      const referencedMessage = await message.channel.messages.fetch(
        currentRef.messageId,
      );
      chain.unshift({
        author: referencedMessage.author.username,
        content: referencedMessage.content.trim(),
        isBot: referencedMessage.author.bot,
        isReplyContext: true,
      });
      currentRef = referencedMessage.reference?.messageId
        ? {
            channelId: referencedMessage.channel.id,
            messageId: referencedMessage.reference.messageId,
          }
        : null;
      depth++;
    } catch (error) {
      botLogger.debug(
        {
          error: (error as Error)?.message,
          messageId: currentRef?.messageId,
          depth,
        },
        "Stopping reply-chain walk (message unfetchable)",
      );
      break;
    }
  }

  return chain;
}

export async function fetchChatHistory(
  message: Message,
): Promise<ChatMessage[]> {
  const chatHistory: ChatMessage[] = [];
  if (!("messages" in message.channel)) return chatHistory;

  // Fetch 30 messages to give the model more context for avoiding repetition
  const messages = await message.channel.messages.fetch({ limit: 30 });
  const sorted = [...messages.values()].reverse();
  for (const msg of sorted) {
    if (msg.id === message.id) continue;
    chatHistory.push({
      author: msg.author.username,
      content: msg.content.trim(),
      isBot: msg.author.bot,
    });
  }
  return chatHistory;
}

export async function fetchReferencedMessage(
  message: Message,
): Promise<Message | null> {
  if (!message.reference?.messageId || !("messages" in message.channel)) {
    return null;
  }
  try {
    return await message.channel.messages.fetch(message.reference.messageId);
  } catch (error) {
    botLogger.debug(
      {
        error: (error as Error)?.message,
        referencedMessageId: message.reference.messageId,
        channelId: message.channel.id,
      },
      "Could not fetch referenced message",
    );
    return null;
  }
}

export function getErrorMessage(error: unknown): string {
  const err = error as {
    status?: number;
    code?: number;
    error?: { message?: string };
    message?: string;
  };
  const status = err?.status || err?.code;
  const errorMsg = err?.error?.message || err?.message;

  if (status === 402) {
    return "Apologies, but I've run out of credits to process requests. Please try again later.";
  }
  if (status === 429) {
    return "I'm receiving too many requests right now. Please wait a moment.";
  }
  if (status === 503 || status === 502) {
    return "The AI service is temporarily unavailable. Please try again shortly.";
  }
  return `Something went wrong: ${errorMsg || "Unknown error"}`;
}
