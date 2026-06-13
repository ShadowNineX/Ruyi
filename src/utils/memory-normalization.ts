import { MEMORY_VALUE_MAX_LEN } from "../constants";

export const MEMORY_KEY_MAX_LEN = 64;

function trimEdgeUnderscores(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === "_") start += 1;
  while (end > start && value[end - 1] === "_") end -= 1;

  return value.slice(start, end);
}

export function sanitizeMemoryKey(key: string): string {
  const normalized = key
    .toLowerCase()
    .trim()
    .replaceAll(/[^a-z0-9_]+/g, "_");

  return trimEdgeUnderscores(normalized).slice(0, MEMORY_KEY_MAX_LEN);
}

export function truncateMemoryValue(
  value: string,
  maxLength = MEMORY_VALUE_MAX_LEN,
): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 3) + "...";
}
