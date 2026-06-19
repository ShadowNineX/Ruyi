import { STEAM_PROFILE_COMMENT_MAX_LENGTH } from "../constants";

export interface SteamCommentFormatResult {
  comment: string;
  truncated: boolean;
  removedUnsupportedFormatting: boolean;
  convertedAlignmentSpaces: boolean;
}

interface SteamTag {
  name: string;
  closing: boolean;
  rest: string;
}

interface SanitizedSteamBbCode {
  comment: string;
  removedUnsupportedFormatting: boolean;
}

interface AlignmentSpacingResult {
  comment: string;
  convertedAlignmentSpaces: boolean;
}

interface RenderedSteamTag {
  text: string;
  removedUnsupportedFormatting: boolean;
}

interface SteamTagScanResult extends RenderedSteamTag {
  nextIndex: number;
}

const NON_BREAKING_SPACE = "\u00a0";
const MAX_STEAM_TAG_LENGTH = 120;
const STEAM_PROFILE_COMMENT_SAFE_BBCODE_TAGS = [
  "b",
  "h2",
  "h3",
  "hr",
  "i",
  "p",
  "pullquote",
  "u",
  "strike",
  "spoiler",
  "url",
] as const;

export const STEAM_PROFILE_COMMENT_SAFE_BBCODE_GUIDE =
  "[h2]heading[/h2], [h3]heading[/h3], [b]bold[/b], [u]underline[/u], [i]italic[/i], [strike]strike[/strike], [spoiler]spoiler[/spoiler], [hr][/hr], [url=https://example.com]text[/url], [p]paragraph[/p], [pullquote]text[/pullquote]";

const SAFE_INLINE_STEAM_TAGS = new Set<string>(
  STEAM_PROFILE_COMMENT_SAFE_BBCODE_TAGS,
);
const KNOWN_UNSUPPORTED_STEAM_TAGS = new Set([
  "*",
  "center",
  "code",
  "color",
  "font",
  "h1",
  "img",
  "left",
  "list",
  "noparse",
  "olist",
  "previewicon",
  "previewimg",
  "previewyoutube",
  "quote",
  "right",
  "screenshot",
  "size",
  "table",
  "td",
  "th",
  "tr",
  "video",
]);

function truncateSteamComment(comment: string): SteamCommentFormatResult {
  if (comment.length <= STEAM_PROFILE_COMMENT_MAX_LENGTH) {
    return {
      comment,
      truncated: false,
      removedUnsupportedFormatting: false,
      convertedAlignmentSpaces: false,
    };
  }

  const suffix = "...";
  const truncated = comment
    .slice(0, STEAM_PROFILE_COMMENT_MAX_LENGTH - suffix.length)
    .trimEnd();
  return {
    comment: `${truncated}${suffix}`,
    truncated: true,
    removedUnsupportedFormatting: false,
    convertedAlignmentSpaces: false,
  };
}

function stripDiscordFenceLines(comment: string): string {
  return comment
    .split("\n")
    .filter((line) => !line.trim().startsWith("```"))
    .join("\n");
}

function stripDiscordLinePrefix(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("> ")) return trimmed.slice(2);
  if (!trimmed.startsWith("#")) return line;

  let index = 0;
  while (index < trimmed.length && trimmed[index] === "#") index += 1;
  return trimmed[index] === " " ? trimmed.slice(index + 1) : line;
}

function stripPairedMarker(comment: string, marker: string): string {
  let output = "";
  let index = 0;

  while (index < comment.length) {
    const start = comment.indexOf(marker, index);
    if (start === -1) {
      output += comment.slice(index);
      break;
    }

    const end = comment.indexOf(marker, start + marker.length);
    if (end === -1) {
      output += comment.slice(index);
      break;
    }

    output += comment.slice(index, start);
    output += comment.slice(start + marker.length, end);
    index = end + marker.length;
  }

  return output;
}

function stripDiscordMarkdown(comment: string): string {
  const withoutFences = stripDiscordFenceLines(comment);
  const withoutLinePrefixes = withoutFences
    .split("\n")
    .map(stripDiscordLinePrefix)
    .join("\n");

  return ["**", "__", "||", "`"].reduce(
    (current, marker) => stripPairedMarker(current, marker),
    withoutLinePrefixes,
  );
}

function trimSteamCommentInput(message: string): string {
  const normalized = message.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!normalized.includes("\n")) return normalized.trim();

  const lines = normalized.split("\n");
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function isTagNameChar(value: string | undefined): boolean {
  if (!value) return false;
  const code = value.toLowerCase().codePointAt(0);
  if (code === undefined) return false;
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

function readTagName(value: string): string {
  let index = 0;
  while (index < value.length && isTagNameChar(value[index])) index += 1;
  return value.slice(0, index).toLowerCase();
}

function parseSteamTag(value: string): SteamTag | null {
  const trimmed = value.trim();
  if (trimmed === "*") return { name: "*", closing: false, rest: "" };

  const closing = trimmed.startsWith("/");
  const body = closing ? trimmed.slice(1).trimStart() : trimmed;
  const name = readTagName(body);
  if (!name) return null;

  return {
    name,
    closing,
    rest: body.slice(name.length).trim(),
  };
}

function isSafeUrlTarget(target: string): boolean {
  const hasWhitespace = [...target].some(
    (character) => character.trim() === "",
  );
  if (
    !target ||
    target.includes("]") ||
    target.includes("[") ||
    hasWhitespace
  ) {
    return false;
  }

  return (
    target.startsWith("https://") ||
    target.startsWith("http://") ||
    target.startsWith("steamcommunity.com/") ||
    target.startsWith("store.steampowered.com/")
  );
}

function looksLikeUnsupportedTagPair(
  comment: string,
  tag: SteamTag,
  searchFrom: number,
): boolean {
  if (tag.closing) return KNOWN_UNSUPPORTED_STEAM_TAGS.has(tag.name);
  if (KNOWN_UNSUPPORTED_STEAM_TAGS.has(tag.name)) return true;
  return comment.toLowerCase().includes(`[/${tag.name}]`, searchFrom);
}

function renderSafeSteamTag(tag: SteamTag): string | null {
  if (SAFE_INLINE_STEAM_TAGS.has(tag.name) && tag.rest === "") {
    return tag.closing ? `[/${tag.name}]` : `[${tag.name}]`;
  }

  if (tag.name !== "url") return null;
  if (tag.closing && tag.rest === "") return "[/url]";
  if (tag.closing || !tag.rest.startsWith("=")) return null;

  const target = tag.rest.slice(1).trim();
  return isSafeUrlTarget(target) ? `[url=${target}]` : null;
}

function renderUnsupportedSteamTag(
  comment: string,
  tag: SteamTag,
  outputSoFar: string,
  start: number,
  end: number,
): RenderedSteamTag {
  if (tag.name === "*") {
    const bulletPrefix =
      outputSoFar.length === 0 || outputSoFar.endsWith("\n") ? "- " : "\n- ";
    return {
      text: bulletPrefix,
      removedUnsupportedFormatting: true,
    };
  }

  if (looksLikeUnsupportedTagPair(comment, tag, end + 1)) {
    return { text: "", removedUnsupportedFormatting: true };
  }

  return {
    text: comment.slice(start, end + 1),
    removedUnsupportedFormatting: false,
  };
}

function renderParsedSteamTag(
  comment: string,
  tag: SteamTag,
  outputSoFar: string,
  start: number,
  end: number,
): RenderedSteamTag {
  const safeTag = renderSafeSteamTag(tag);
  if (safeTag !== null) {
    return { text: safeTag, removedUnsupportedFormatting: false };
  }

  return renderUnsupportedSteamTag(comment, tag, outputSoFar, start, end);
}

function scanSteamTag(
  comment: string,
  outputSoFar: string,
  start: number,
): SteamTagScanResult {
  const end = comment.indexOf("]", start + 1);
  if (end === -1 || end - start > MAX_STEAM_TAG_LENGTH) {
    return {
      text: comment[start] ?? "",
      nextIndex: start + 1,
      removedUnsupportedFormatting: false,
    };
  }

  const tag = parseSteamTag(comment.slice(start + 1, end));
  if (!tag) {
    return {
      text: comment.slice(start, end + 1),
      nextIndex: end + 1,
      removedUnsupportedFormatting: false,
    };
  }

  return {
    ...renderParsedSteamTag(comment, tag, outputSoFar, start, end),
    nextIndex: end + 1,
  };
}

function sanitizeSteamBbCode(comment: string): SanitizedSteamBbCode {
  let output = "";
  let index = 0;
  let removedUnsupportedFormatting = false;

  while (index < comment.length) {
    if (comment[index] !== "[") {
      output += comment[index];
      index += 1;
      continue;
    }

    const result = scanSteamTag(comment, output, index);
    output += result.text;
    removedUnsupportedFormatting ||= result.removedUnsupportedFormatting;
    index = result.nextIndex;
  }

  return { comment: output, removedUnsupportedFormatting };
}

function protectLineAlignmentSpaces(line: string): AlignmentSpacingResult {
  let output = "";
  let index = 0;
  let convertedAlignmentSpaces = false;

  while (index < line.length && line[index] === " ") {
    output += NON_BREAKING_SPACE;
    convertedAlignmentSpaces = true;
    index += 1;
  }

  while (index < line.length) {
    if (line[index] !== " ") {
      output += line[index];
      index += 1;
      continue;
    }

    let end = index;
    while (end < line.length && line[end] === " ") end += 1;
    const runLength = end - index;
    output += runLength > 1 ? NON_BREAKING_SPACE.repeat(runLength) : " ";
    convertedAlignmentSpaces ||= runLength > 1;
    index = end;
  }

  return { comment: output, convertedAlignmentSpaces };
}

function protectAlignmentSpaces(comment: string): AlignmentSpacingResult {
  let convertedAlignmentSpaces = false;
  const lines = comment.split("\n").map((line) => {
    const result = protectLineAlignmentSpaces(line);
    convertedAlignmentSpaces ||= result.convertedAlignmentSpaces;
    return result.comment;
  });

  return {
    comment: lines.join("\n"),
    convertedAlignmentSpaces,
  };
}

export function normalizeSteamProfileComment(
  message: string,
): SteamCommentFormatResult {
  const normalized = trimSteamCommentInput(message);
  const withoutDiscordMarkdown = stripDiscordMarkdown(normalized);
  const sanitized = sanitizeSteamBbCode(withoutDiscordMarkdown);
  const spacing = protectAlignmentSpaces(sanitized.comment);
  const truncated = truncateSteamComment(spacing.comment);

  return {
    comment: truncated.comment,
    truncated: truncated.truncated,
    removedUnsupportedFormatting: sanitized.removedUnsupportedFormatting,
    convertedAlignmentSpaces: spacing.convertedAlignmentSpaces,
  };
}
