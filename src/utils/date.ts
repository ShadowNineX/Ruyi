export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function dateToTime(value: unknown): number | null {
  return isValidDate(value) ? value.getTime() : null;
}
