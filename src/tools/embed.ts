import { tool } from "@openai/agents";
import { z } from "zod";
import { EmbedBuilder } from "discord.js";
import { toolLogger } from "../logger";
import { toolContextManager, formatError } from "../utils/types";

// Map color names to hex values
const colorMap: Record<string, number> = {
  red: 0xe74c3c,
  blue: 0x3498db,
  green: 0x2ecc71,
  purple: 0x9b59b6,
  gold: 0xf1c40f,
  orange: 0xe67e22,
  pink: 0xe91e63,
  cyan: 0x00bcd4,
  teal: 0x009688,
  white: 0xffffff,
  black: 0x000000,
  gray: 0x95a5a6,
  grey: 0x95a5a6,
};

function parseColor(color: string | null): number {
  if (!color) return 0x9b59b6;
  const normalized = color.trim().toLowerCase();
  const namedColor = colorMap[normalized];
  if (namedColor !== undefined) return namedColor;
  const hex = normalized.replace(/^#/, "");
  if (!/^[\da-f]{6}$/i.test(hex)) return 0x9b59b6;
  return Number.parseInt(hex, 16);
}

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

const MAX_FIELDS_PER_EMBED = 25;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_DESCRIPTION = 4096;
const MAX_FOOTER = 2048;
const MAX_EMBED_TOTAL = 6000;

function truncateEmbedText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 3) + "...";
}

function normalizeField(field: EmbedField): Required<EmbedField> {
  return {
    name: truncateEmbedText(field.name, MAX_FIELD_NAME) || "\u200b",
    value: truncateEmbedText(field.value, MAX_FIELD_VALUE) || "\u200b",
    inline: field.inline ?? false,
  };
}

function fieldLength(field: Required<EmbedField>): number {
  return field.name.length + field.value.length;
}

function chunkFields(fields: EmbedField[], baseLength = 0): EmbedField[][] {
  const chunks: EmbedField[][] = [];
  let currentChunk: EmbedField[] = [];
  let currentLength = baseLength;

  for (const rawField of fields) {
    const field = normalizeField(rawField);
    const nextLength = currentLength + fieldLength(field);
    const shouldStartNewChunk =
      currentChunk.length >= MAX_FIELDS_PER_EMBED ||
      (currentChunk.length > 0 && nextLength > MAX_EMBED_TOTAL);

    if (shouldStartNewChunk) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentLength = baseLength;
    }

    currentChunk.push(field);
    currentLength += fieldLength(field);
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function chunkDescription(description: string): string[] {
  if (description.length <= MAX_DESCRIPTION) return [description];

  const chunks: string[] = [];
  let remaining = description;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_DESCRIPTION) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n", MAX_DESCRIPTION);
    if (splitIndex < MAX_DESCRIPTION - 500) {
      splitIndex = remaining.lastIndexOf(" ", MAX_DESCRIPTION);
    }
    if (splitIndex < MAX_DESCRIPTION - 500) {
      splitIndex = MAX_DESCRIPTION;
    }
    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

interface EmbedConfig {
  color: number;
  title: string | null;
  description: string | null;
  fields: EmbedField[] | null;
  footer: string | null;
  thumbnail: string | null;
  showTimestamp: boolean;
}

function buildEmbed(config: EmbedConfig): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(config.color);

  if (config.title) embed.setTitle(truncateEmbedText(config.title, 256));
  if (config.description)
    embed.setDescription(truncateEmbedText(config.description, MAX_DESCRIPTION));

  if (config.fields && config.fields.length > 0) {
    for (const field of config.fields.slice(0, MAX_FIELDS_PER_EMBED)) {
      const normalized = normalizeField(field);
      embed.addFields({
        name: normalized.name,
        value: normalized.value,
        inline: normalized.inline,
      });
    }
  }

  if (config.footer)
    embed.setFooter({ text: truncateEmbedText(config.footer, MAX_FOOTER) });
  if (config.thumbnail) embed.setThumbnail(config.thumbnail);
  if (config.showTimestamp) embed.setTimestamp();

  return embed;
}

function getContinuationTitle(
  title: string | null,
  isFirst: boolean,
): string | null {
  if (isFirst) return title;
  return title ? `${title} (cont.)` : null;
}

function buildMultipleEmbeds(
  color: number,
  title: string | null,
  description: string | null,
  fields: EmbedField[] | null,
  footer: string | null,
  thumbnail: string | null,
): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];
  const descriptionChunks: (string | null)[] = description
    ? chunkDescription(description)
    : [];
  const fieldChunks: EmbedField[][] =
    fields && fields.length > 0 ? chunkFields(fields) : [];

  let partIndex = 0;

  for (const descChunk of descriptionChunks) {
    const isFirst = partIndex === 0;
    const hasMoreParts =
      partIndex < descriptionChunks.length - 1 || fieldChunks.length > 0;

    embeds.push(
      buildEmbed({
        color,
        title: getContinuationTitle(title, isFirst),
        description: descChunk,
        fields: null,
        footer: hasMoreParts ? null : footer,
        thumbnail: isFirst ? thumbnail : null,
        showTimestamp: !hasMoreParts,
      }),
    );
    partIndex++;
  }

  for (const fieldChunk of fieldChunks) {
    const isFirst = partIndex === 0;
    const isLast = partIndex === descriptionChunks.length + fieldChunks.length - 1;

    embeds.push(
      buildEmbed({
        color,
        title: getContinuationTitle(title, isFirst),
        description: null,
        fields: fieldChunk,
        footer: isLast ? footer : null,
        thumbnail: isFirst ? thumbnail : null,
        showTimestamp: isLast,
      }),
    );
    partIndex++;
  }

  return embeds;
}

function needsMultipleEmbeds(
  fields: EmbedField[] | null,
  description: string | null,
  title: string | null,
  footer: string | null,
): boolean {
  const tooManyFields = fields !== null && fields.length > MAX_FIELDS_PER_EMBED;
  const descriptionTooLong =
    description !== null && description.length > MAX_DESCRIPTION;
  const totalLength =
    (title?.length ?? 0) +
    (description?.length ?? 0) +
    (footer?.length ?? 0) +
    (fields ?? [])
      .map((field) => fieldLength(normalizeField(field)))
      .reduce((sum, length) => sum + length, 0);

  return tooManyFields || descriptionTooLong || totalLength > MAX_EMBED_TOTAL;
}

export const embedTool = tool({
  name: "send_embed",
  description:
    "Send a beautifully formatted Discord embed message. Use this for tables, lists, structured data, audit logs, search results, or any content that benefits from rich formatting.",
  parameters: z.object({
    title: z.string().nullable().describe("The embed title."),
    description: z
      .string()
      .nullable()
      .describe("Main embed description. Supports Discord markdown."),
    color: z.string().nullable().describe("Embed color as hex or color name."),
    fields: z
      .array(
        z.object({
          name: z.string(),
          value: z.string(),
          inline: z.boolean().optional(),
        }),
      )
      .nullable()
      .describe("Array of field objects for structured data."),
    footer: z.string().nullable().describe("Small text at the bottom."),
    thumbnail: z
      .string()
      .nullable()
      .describe("URL of a small image in top-right corner."),
  }),
  execute: async ({ title, description, color, fields, footer, thumbnail }) => {
    const ctx = toolContextManager.get();

    if (!ctx.channel) {
      toolLogger.warn("No channel context available for send_embed");
      return { error: "No channel context available" };
    }

    const channel = ctx.channel;
    if (!("send" in channel)) {
      return { error: "Cannot send messages in this channel type" };
    }

    try {
      const parsedColor = parseColor(color);
      let embeds: EmbedBuilder[];

      if (!title && !description && (!fields || fields.length === 0) && !footer && !thumbnail) {
        return { error: "Embed needs at least a title, description, field, footer, or thumbnail" };
      }

      if (needsMultipleEmbeds(fields, description, title, footer)) {
        embeds = buildMultipleEmbeds(
          parsedColor,
          title,
          description,
          fields,
          footer,
          thumbnail,
        );
      } else {
        embeds = [
          buildEmbed({
            color: parsedColor,
            title,
            description,
            fields,
            footer,
            thumbnail,
            showTimestamp: true,
          }),
        ];
      }

      for (let i = 0; i < embeds.length; i += 10) {
        await channel.send({ embeds: embeds.slice(i, i + 10) });
      }

      toolLogger.info(
        { title, fieldCount: fields?.length ?? 0, embedCount: embeds.length },
        "Sent embed message(s)",
      );

      return {
        success: true,
        title: title ?? "(no title)",
        fieldCount: fields?.length ?? 0,
        embedCount: embeds.length,
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error({ error: errorMessage }, "Failed to send embed");
      return { error: "Failed to send embed", details: errorMessage };
    }
  },
});
