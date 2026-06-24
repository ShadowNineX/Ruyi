import type {
  Attachment,
  Message,
  MessageReplyOptions,
  TextBasedChannel,
} from 'discord.js';
import type { ChatMessage } from '../../ai';
import { AttachmentBuilder } from 'discord.js';
import { botLogger } from '../../logger';

const MAX_ATTACHMENT_DESCRIPTION_LENGTH = 120;
const MAX_EMBED_DESCRIPTION_LENGTH = 240;
const MAX_EMBED_FIELD_LENGTH = 120;
const DISCORD_MESSAGE_MAX_LENGTH = 2000;
const TEXT_ATTACHMENT_DEFAULT_FILE_NAME = 'message.txt';
const TEXT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const DISCORD_UNKNOWN_MESSAGE_CODE = 10008;
const DISCORD_INVALID_FORM_BODY_CODE = 50035;
const MENTION_ONLY_PROMPT
  = '[The user mentioned Ruyi without any additional text. Infer their intent from the replied message and recent channel context instead of treating the mention as content.]';

export interface MessageImageInput {
  url: string;
  source: string;
  detail: 'auto' | 'low' | 'high';
}

const IMAGE_EXTENSION_REGEX = /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:[?#].*)?$/i;

function isImageAttachmentName(name: string): boolean {
  return IMAGE_EXTENSION_REGEX.test(name);
}

function isImageAttachment(attachment: Attachment): boolean {
  return (
    attachment.contentType?.startsWith('image/') === true
    || Boolean(attachment.width && attachment.height)
    || isImageAttachmentName(attachment.name)
  );
}

export function getMessageImageInputs(
  message: Message,
  sourceLabel = 'message',
): MessageImageInput[] {
  const attachmentImages = [...message.attachments.values()]
    .filter(isImageAttachment)
    .map((attachment, index) => ({
      url: attachment.url,
      source: `${sourceLabel} attachment ${index + 1}: ${attachment.name}`,
      detail: 'auto' as const,
    }));

  const embedImages = message.embeds.flatMap((embed, embedIndex) => {
    const urls = [embed.image?.url, embed.thumbnail?.url].filter(
      (url): url is string => Boolean(url),
    );
    return urls.map((url, imageIndex) => ({
      url,
      source: `${sourceLabel} embed ${embedIndex + 1} image ${imageIndex + 1}`,
      detail: 'auto' as const,
    }));
  });

  return [...attachmentImages, ...embedImages];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateMetadata(value: string, maxLength: number): string {
  if (value.length <= maxLength) { return value; }
  return `${value.slice(0, maxLength - 3)}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function removeBotMention(message: Message, content: string): string {
  const botId = message.client.user?.id;
  if (!botId) { return content; }

  return content.replace(new RegExp(`<@!?${escapeRegExp(botId)}>`, 'g'), '');
}

function isOnlyBotMention(message: Message, content: string): boolean {
  const botId = message.client.user?.id;
  if (!botId) { return false; }

  const mentionsBot = new RegExp(`<@!?${escapeRegExp(botId)}>`).test(content);
  return mentionsBot && removeBotMention(message, content).trim().length === 0;
}

function normalizeDiscordMentions(message: Message, content: string): string {
  let normalized = content;

  for (const [userId, user] of message.mentions.users) {
    normalized = normalized.replace(
      new RegExp(`<@!?${escapeRegExp(userId)}>`, 'g'),
      `@${user.username}`,
    );
  }

  return normalized.trim();
}

function formatAttachmentDimensions(
  width: number | null,
  height: number | null,
): string | null {
  return width && height ? `${width}x${height}` : null;
}

function formatMessageAttachments(message: Message): string[] {
  return [...message.attachments.values()].map((attachment, index) => {
    const details = [
      attachment.contentType ? `type=${attachment.contentType}` : null,
      `size=${formatBytes(attachment.size)}`,
      formatAttachmentDimensions(attachment.width, attachment.height)
        ? `dimensions=${formatAttachmentDimensions(attachment.width, attachment.height)}`
        : null,
      attachment.description
        ? `description="${truncateMetadata(
          attachment.description,
          MAX_ATTACHMENT_DESCRIPTION_LENGTH,
        )}"`
        : null,
    ].filter(Boolean);

    return `${index + 1}. ${attachment.name} (${details.join(', ')})\n   url: ${
      attachment.url
    }`;
  });
}

function formatMessageStickers(message: Message): string[] {
  return [...message.stickers.values()].map((sticker, index) => {
    const description = sticker.description
      ? ` - ${truncateMetadata(sticker.description, MAX_ATTACHMENT_DESCRIPTION_LENGTH)}`
      : '';
    return `${index + 1}. ${sticker.name}${description}`;
  });
}

function formatMessageEmbeds(message: Message): string[] {
  return message.embeds.map((embed, index) => {
    const parts = [
      embed.title ? `title="${truncateMetadata(embed.title, 120)}"` : null,
      embed.description
        ? `description="${truncateMetadata(
          embed.description,
          MAX_EMBED_DESCRIPTION_LENGTH,
        )}"`
        : null,
      embed.url ? `url=${embed.url}` : null,
      embed.image?.url ? `image=${embed.image.url}` : null,
      embed.thumbnail?.url ? `thumbnail=${embed.thumbnail.url}` : null,
      embed.fields.length > 0
        ? `fields=${embed.fields
          .slice(0, 3)
          .map(
            field =>
              `${field.name}: ${truncateMetadata(
                field.value,
                MAX_EMBED_FIELD_LENGTH,
              )}`,
          )
          .join(' | ')}`
        : null,
    ].filter(Boolean);

    return `${index + 1}. ${parts.join(', ') || 'embed with no text metadata'}`;
  });
}

export function formatMessageForAI(message: Message): string {
  const sections: string[] = [];
  const rawContent = message.content.trim();
  const content = isOnlyBotMention(message, rawContent)
    ? MENTION_ONLY_PROMPT
    : normalizeDiscordMentions(message, rawContent);

  if (content) { sections.push(content); }

  const attachments = formatMessageAttachments(message);
  if (attachments.length > 0) {
    sections.push(`Attachments:\n${attachments.join('\n')}`);
  }

  const stickers = formatMessageStickers(message);
  if (stickers.length > 0) {
    sections.push(`Stickers:\n${stickers.join('\n')}`);
  }

  const embeds = formatMessageEmbeds(message);
  if (embeds.length > 0) {
    sections.push(`Embedded/link preview content:\n${embeds.join('\n')}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : '[no text content]';
}

interface ProtectedRange {
  start: number;
  end: number;
}

// Regex patterns for content that should not be split.
const REGEX_PROTECTED_PATTERNS = [
  /https?:\/\/[^\s\])<>]+/g, // URLs
  /```[\s\S]*?```/g, // Code blocks
  /`[^`]+`/g, // Inline code
];

function findMarkdownLinkRanges(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  let index = 0;

  while (index < text.length) {
    const labelStart = text.indexOf('[', index);
    if (labelStart === -1) { break; }

    const labelEnd = text.indexOf(']', labelStart + 1);
    if (labelEnd === -1) { break; }

    if (text[labelEnd + 1] !== '(') {
      index = labelStart + 1;
      continue;
    }

    const urlEnd = text.indexOf(')', labelEnd + 2);
    if (urlEnd === -1) { break; }

    ranges.push({ start: labelStart, end: urlEnd + 1 });
    index = urlEnd + 1;
  }

  return ranges;
}

// Find all ranges in the text that should not be split
function findProtectedRanges(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = findMarkdownLinkRanges(text);

  for (const pattern of REGEX_PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
      match = pattern.exec(text);
    }
  }

  return ranges;
}

// Check if an index falls within any protected range
function isIndexProtected(
  index: number,
  ranges: ProtectedRange[],
): boolean {
  return ranges.some(range => index > range.start && index < range.end);
}

// Find the nearest protected range that the index falls within
function findProtectedRangeStart(
  index: number,
  ranges: ProtectedRange[],
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
  protectedRanges: ProtectedRange[],
): number {
  let splitIndex = maxLength;

  // Check if split point is inside protected content
  const protectedStart = findProtectedRangeStart(splitIndex, protectedRanges);
  if (protectedStart !== null) {
    splitIndex = protectedStart;
  }

  // Try to find a natural break point (newline or space)
  if (splitIndex > 100) {
    const newlineIndex = text.lastIndexOf('\n', splitIndex);
    if (newlineIndex > splitIndex - 300 && newlineIndex > 0) {
      if (!isIndexProtected(newlineIndex, protectedRanges)) {
        return newlineIndex + 1;
      }
    }

    const spaceIndex = text.lastIndexOf(' ', splitIndex);
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
  if (text.length <= maxLength) { return [text]; }

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

export interface TextAttachmentResult extends SentChunk {
  bytes: number;
  fileName: string;
  url: string;
}

interface TextAttachmentOptions {
  fileName?: string | null;
  notice?: string | null;
}

interface TextAttachmentPayload {
  content: string;
  files: AttachmentBuilder[];
}

function normalizeTextAttachmentFileName(fileName: string | null | undefined): string {
  const normalized = (fileName?.trim() || TEXT_ATTACHMENT_DEFAULT_FILE_NAME)
    .replaceAll(/[^\w.-]/g, '_')
    .slice(0, 80);
  if (!normalized) { return TEXT_ATTACHMENT_DEFAULT_FILE_NAME; }
  return normalized.toLowerCase().endsWith('.txt') ? normalized : `${normalized}.txt`;
}

function textByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function assertTextAttachmentSize(text: string): number {
  const bytes = textByteLength(text);
  if (bytes > TEXT_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `Text attachment is too large (${formatBytes(bytes)}). Maximum supported size is ${formatBytes(TEXT_ATTACHMENT_MAX_BYTES)}.`,
    );
  }
  return bytes;
}

function buildTextAttachmentPayload(
  text: string,
  options: TextAttachmentOptions = {},
): TextAttachmentPayload {
  const fileName = normalizeTextAttachmentFileName(options.fileName);
  assertTextAttachmentSize(text);
  const attachment = new AttachmentBuilder(Buffer.from(text, 'utf8'), {
    name: fileName,
  });
  return {
    content:
      options.notice
      ?? `I attached the full text as \`${fileName}\`.`,
    files: [attachment],
  };
}

function getSentAttachmentUrl(message: Message, fileName: string): string {
  return (
    message.attachments.find(attachment => attachment.name === fileName)?.url
    ?? message.attachments.first()?.url
    ?? message.url
  );
}

export async function sendTextAttachmentToChannel(
  channel: TextBasedChannel,
  text: string,
  options: TextAttachmentOptions = {},
): Promise<TextAttachmentResult> {
  if (!('send' in channel)) {
    throw new Error('This Discord channel cannot send attachments.');
  }

  const fileName = normalizeTextAttachmentFileName(options.fileName);
  const bytes = assertTextAttachmentSize(text);
  const payload = buildTextAttachmentPayload(text, {
    ...options,
    fileName,
  });
  const sent = await channel.send(payload);
  return {
    id: sent.id,
    content: text,
    bytes,
    fileName,
    url: getSentAttachmentUrl(sent, fileName),
  };
}

async function sendInitialReplyChunk(
  message: Message,
  chunk: string,
): Promise<SentChunk | null> {
  return sendInitialReplyPayload(message, chunk, chunk);
}

async function sendInitialReplyPayload(
  message: Message,
  payload: string | MessageReplyOptions | TextAttachmentPayload,
  archiveContent: string,
): Promise<SentChunk | null> {
  try {
    const sent = await message.reply(payload);
    return { id: sent.id, content: archiveContent };
  } catch (error) {
    const err = error as { code?: number };
    if (err.code === DISCORD_UNKNOWN_MESSAGE_CODE) {
      botLogger.debug(
        {
          channelId: message.channel.id,
          messageId: message.id,
        },
        'Original message was deleted before reply could be sent',
      );
      return null;
    }

    if (
      err.code === DISCORD_INVALID_FORM_BODY_CODE
      && 'send' in message.channel
    ) {
      botLogger.debug(
        'Reply reference was invalid, sending as regular message',
      );
      const sent = await message.channel.send(payload);
      return { id: sent.id, content: archiveContent };
    }

    throw error;
  }
}

function shouldAttachReply(reply: string): boolean {
  return (
    reply.length > DISCORD_MESSAGE_MAX_LENGTH
    && textByteLength(reply) <= TEXT_ATTACHMENT_MAX_BYTES
  );
}

export async function sendReplyChunks(
  message: Message,
  reply: string,
  user: string,
): Promise<SentChunk[]> {
  if (shouldAttachReply(reply)) {
    const payload = buildTextAttachmentPayload(reply);
    const sent = await sendInitialReplyPayload(message, payload, reply);
    if (!sent) { return []; }
    botLogger.info(
      {
        user,
        replyLength: reply.length,
        attachment: true,
        fileName: TEXT_ATTACHMENT_DEFAULT_FILE_NAME,
        bytes: textByteLength(reply),
      },
      'Sent reply as text attachment',
    );
    return [sent];
  }

  const chunks = splitMessage(reply);
  const sentChunks: SentChunk[] = [];

  for (const [i, chunk] of chunks.entries()) {
    if (i === 0) {
      const sent = await sendInitialReplyChunk(message, chunk);
      if (!sent) { return sentChunks; }
      sentChunks.push(sent);
    } else if ('send' in message.channel) {
      const sent = await message.channel.send(chunk);
      sentChunks.push({ id: sent.id, content: chunk });
    }
  }
  botLogger.info(
    { user, replyLength: reply.length, chunks: chunks.length },
    'Sent reply',
  );
  return sentChunks;
}

async function fetchEditableBotMessage(
  message: Message,
  messageId: string,
): Promise<Message | null> {
  if (!('messages' in message.channel)) { return null; }

  try {
    const fetched = await message.channel.messages.fetch(messageId);
    if (fetched.author.id !== message.client.user?.id) { return null; }
    return fetched;
  } catch (error) {
    botLogger.debug(
      {
        error: (error as Error)?.message,
        channelId: message.channel.id,
        messageId,
      },
      'Could not fetch bot reply chunk for edit',
    );
    return null;
  }
}

async function deleteBotReplyChunk(
  message: Message,
  messageId: string,
): Promise<void> {
  const fetched = await fetchEditableBotMessage(message, messageId);
  if (!fetched) { return; }

  await fetched.delete().catch((error: unknown) => {
    botLogger.debug(
      {
        error: (error as Error)?.message,
        channelId: message.channel.id,
        messageId,
      },
      'Could not delete excess bot reply chunk after edit',
    );
  });
}

async function deleteBotReplyChunks(
  message: Message,
  messageIds: string[],
): Promise<void> {
  for (const messageId of messageIds) {
    await deleteBotReplyChunk(message, messageId);
  }
}

async function editBotReplyPayload(
  message: Message,
  messageId: string | undefined,
  payload: TextAttachmentPayload,
  archiveContent: string,
): Promise<SentChunk | null> {
  if (!messageId) { return null; }

  const fetched = await fetchEditableBotMessage(message, messageId);
  if (!fetched) { return null; }

  const edited = await fetched.edit(payload);
  return { id: edited.id, content: archiveContent };
}

async function editReplyAsTextAttachment(
  message: Message,
  existingMessageIds: string[],
  reply: string,
  user: string,
): Promise<SentChunk[]> {
  const payload = buildTextAttachmentPayload(reply);
  const editedChunk = await editBotReplyPayload(
    message,
    existingMessageIds[0],
    payload,
    reply,
  );
  const sentChunk = editedChunk
    ?? (await sendInitialReplyPayload(message, payload, reply));

  await deleteBotReplyChunks(message, existingMessageIds.slice(1));

  botLogger.info(
    {
      user,
      replyLength: reply.length,
      attachment: true,
      editedChunks: sentChunk ? 1 : 0,
      previousChunks: existingMessageIds.length,
    },
    'Edited reply as text attachment',
  );

  return sentChunk ? [sentChunk] : [];
}

export async function editReplyChunks(
  message: Message,
  existingMessageIds: string[],
  reply: string,
  user: string,
): Promise<SentChunk[]> {
  if (shouldAttachReply(reply)) {
    return editReplyAsTextAttachment(message, existingMessageIds, reply, user);
  }

  const chunks = splitMessage(reply);
  const editedChunks: SentChunk[] = [];
  let editedExistingChunk = false;

  for (const [index, chunk] of chunks.entries()) {
    const existingMessageId = existingMessageIds[index];
    if (existingMessageId) {
      const fetched = await fetchEditableBotMessage(message, existingMessageId);
      if (fetched) {
        const edited = await fetched.edit(chunk);
        editedChunks.push({ id: edited.id, content: chunk });
        editedExistingChunk = true;
      }
      continue;
    }

    if (editedExistingChunk && 'send' in message.channel) {
      const sent = await message.channel.send(chunk);
      editedChunks.push({ id: sent.id, content: chunk });
    }
  }

  const excessIds = existingMessageIds.slice(chunks.length);
  await deleteBotReplyChunks(message, excessIds);

  botLogger.info(
    {
      user,
      replyLength: reply.length,
      chunks: chunks.length,
      editedChunks: editedChunks.length,
      previousChunks: existingMessageIds.length,
    },
    'Edited reply after user message edit',
  );

  return editedChunks;
}

export async function fetchReplyChain(
  message: Message,
  firstReferencedMessage?: Message | null,
  maxDepth = 10,
): Promise<ChatMessage[]> {
  const chain: ChatMessage[] = [];
  let currentMessage = firstReferencedMessage ?? null;
  let currentRef: { messageId: string } | null
    = !currentMessage && message.reference?.messageId
      ? { messageId: message.reference.messageId }
      : null;
  let depth = 0;

  if (!('messages' in message.channel)) { return chain; }

  while ((currentMessage || currentRef) && depth < maxDepth) {
    try {
      const referencedMessage
        = currentMessage
          ?? (await message.channel.messages.fetch(currentRef!.messageId));

      chain.unshift({
        author: referencedMessage.author.username,
        content: formatMessageForAI(referencedMessage),
        isBot: referencedMessage.author.bot,
        isReplyContext: true,
      });
      currentRef = referencedMessage.reference?.messageId
        ? { messageId: referencedMessage.reference.messageId }
        : null;
      currentMessage = null;
      depth++;
    } catch (error) {
      botLogger.debug(
        {
          error: (error as Error)?.message,
          messageId: currentRef?.messageId,
          depth,
        },
        'Stopping reply-chain walk (message unfetchable)',
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
  if (!('messages' in message.channel)) { return chatHistory; }

  try {
    const messages = await message.channel.messages.fetch({ limit: 30 });
    const sorted = [...messages.values()].reverse();

    for (const msg of sorted) {
      if (msg.id === message.id) { continue; }
      chatHistory.push({
        author: msg.author.username,
        content: formatMessageForAI(msg),
        isBot: msg.author.bot,
      });
    }
  } catch (error) {
    botLogger.debug(
      {
        error: (error as Error)?.message,
        channelId: message.channel.id,
        messageId: message.id,
      },
      'Could not fetch chat history',
    );
  }

  return chatHistory;
}

export async function fetchRecentChatMessages(
  channel: Message['channel'] | TextBasedChannel,
  options: {
    limit?: number;
    context: Record<string, unknown>;
    failureMessage: string;
  },
): Promise<ChatMessage[]> {
  if (!('messages' in channel)) { return []; }

  try {
    const messages = await channel.messages.fetch({
      limit: options.limit ?? 20,
    });
    return [...messages.values()].reverse().map(message => ({
      author: message.author.username,
      content: formatMessageForAI(message),
      isBot: message.author.bot,
    }));
  } catch (error) {
    botLogger.debug(
      {
        ...options.context,
        error: (error as Error).message,
        channelId: channel.id,
      },
      options.failureMessage,
    );
    return [];
  }
}

export async function fetchReferencedMessage(
  message: Message,
): Promise<Message | null> {
  if (!message.reference?.messageId || !('messages' in message.channel)) {
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
      'Could not fetch referenced message',
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
    name?: string;
  };
  const status = err?.status || err?.code;
  const errorMsg = err?.error?.message || err?.message;
  const normalizedMessage = errorMsg?.toLowerCase() ?? '';

  if (
    err?.name === 'ChatTurnTimeoutError'
    || normalizedMessage.includes('timed out')
  ) {
    return 'Forgive me, my lord — that request took too long, so I stopped it before it could leave my systems in an uncertain state. Please try again in a moment.';
  }
  if (status === 402) {
    return 'Apologies, but I\'ve run out of credits to process requests. Please try again later.';
  }
  if (status === 429) {
    if (
      normalizedMessage.includes('quota')
      || normalizedMessage.includes('billing')
    ) {
      return 'Apologies, but the OpenAI project is out of API quota or has hit its billing limit. Please check the OpenAI billing and usage limits.';
    }
    return 'I\'m receiving too many requests right now. Please wait a moment.';
  }
  if (status === 503 || status === 502) {
    return 'The AI service is temporarily unavailable. Please try again shortly.';
  }
  return `Something went wrong: ${errorMsg || 'Unknown error'}`;
}
