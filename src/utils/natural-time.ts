import { rawTimeZones } from "@vvo/tzdb";
import { DateTime, IANAZone } from "luxon";

const DEFAULT_REFERENCE_TIME_ZONE = getZoneName(DateTime.local());
type TzdbTimeZone = (typeof rawTimeZones)[number];

const WEEKDAYS = new Map([
  ["monday", 1],
  ["mon", 1],
  ["tuesday", 2],
  ["tue", 2],
  ["tues", 2],
  ["wednesday", 3],
  ["wed", 3],
  ["thursday", 4],
  ["thu", 4],
  ["thur", 4],
  ["thurs", 4],
  ["friday", 5],
  ["fri", 5],
  ["saturday", 6],
  ["sat", 6],
  ["sunday", 7],
  ["sun", 7],
]);

const DAY_PART_DEFAULT_HOURS = new Map([
  ["morning", 9],
  ["noon", 12],
  ["afternoon", 14],
  ["evening", 19],
  ["tonight", 21],
  ["night", 21],
]);

export interface TimeZoneResolution {
  timeZone: string;
  source:
    | "default"
    | "provided_timezone"
    | "timezone_database";
  matchedLocation: string | null;
}

export interface ParsedNaturalTime {
  expression: string;
  referenceTimeZone: string;
  targetTimeZone: string;
  targetTimeZoneSource: TimeZoneResolution["source"];
  matchedLocation: string | null;
  referenceUnix: number;
  resolvedUnix: number;
  resolvedIso: string;
  localDate: string;
  localTime: string;
  localTime24h: string;
  localTime12h: string;
  weekday: string;
  offsetName: string;
  dayPeriod: string;
  discordTimestamp: string;
  ambiguity: "none" | "assumed_current_time" | "assumed_daypart_time";
  assumptions: string[];
}

export interface CurrentTemporalContext {
  unix: number;
  iso: string;
  timeZone: string;
  localDate: string;
  localTime: string;
  weekday: string;
  offsetName: string;
  dayPeriod: string;
  discordTime: string;
  discordDateTime: string;
}

function normalizeLookup(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[/_-]+/g, " ")
    .replaceAll(/[^a-z0-9/+ ]+/g, "")
    .trim()
    .replaceAll(/\s+/g, " ");
}

function containsNormalizedPhrase(normalized: string, phrase: string): boolean {
  return ` ${normalized} `.includes(` ${phrase} `);
}

function locationAliasMatches(normalized: string, alias: string): boolean {
  return containsNormalizedPhrase(normalized, alias);
}

function getZoneName(dateTime: DateTime): string {
  return dateTime.zoneName ?? "UTC";
}

function isValidTimeZone(value: string): boolean {
  return IANAZone.isValidZone(value);
}

function buildResolution(
  timeZone: string,
  source: TimeZoneResolution["source"],
  matchedLocation: string | null,
): TimeZoneResolution {
  return { timeZone, source, matchedLocation };
}

function normalizedZoneNames(zone: TzdbTimeZone): string[] {
  const names = [zone.name, ...zone.group];
  return names.flatMap((name) => {
    const leaf = name.split("/").at(-1) ?? name;
    return [normalizeLookup(name), normalizeLookup(leaf)];
  });
}

function normalizedZoneTerms(
  zone: TzdbTimeZone,
  options: { includeCountryCode: boolean },
): string[] {
  const terms = [
    ...normalizedZoneNames(zone),
    normalizeLookup(zone.countryName),
    normalizeLookup(zone.alternativeName),
    ...zone.mainCities.map(normalizeLookup),
  ];

  if (options.includeCountryCode) {
    terms.push(normalizeLookup(zone.countryCode));
  }

  return [...new Set(terms.filter(Boolean))];
}

function uniqueZones(zones: TzdbTimeZone[]): TzdbTimeZone[] {
  const seen = new Set<string>();
  const unique: TzdbTimeZone[] = [];
  for (const zone of zones) {
    if (seen.has(zone.name)) continue;
    seen.add(zone.name);
    unique.push(zone);
  }
  return unique;
}

function resolveUniqueZone(
  zones: TzdbTimeZone[],
  matchedLocation: string,
): TimeZoneResolution | null {
  const unique = uniqueZones(zones);
  if (unique.length !== 1) return null;

  return buildResolution(
    unique[0]?.name ?? DEFAULT_REFERENCE_TIME_ZONE,
    "timezone_database",
    matchedLocation,
  );
}

function resolveDatabaseTarget(
  target: string,
  options: { includeCountryCode: boolean },
): TimeZoneResolution | null {
  const normalized = normalizeLookup(target);
  if (!normalized) return null;

  const exactCountryMatches = rawTimeZones.filter((zone) => {
    const normalizedCountry = normalizeLookup(zone.countryName);
    const normalizedCountryCode = normalizeLookup(zone.countryCode);
    return (
      normalizedCountry === normalized ||
      (options.includeCountryCode && normalizedCountryCode === normalized)
    );
  });
  const countryResolution = resolveUniqueZone(exactCountryMatches, target);
  if (countryResolution) return countryResolution;

  const exactTermMatches = rawTimeZones.filter((zone) =>
    normalizedZoneTerms(zone, options).includes(normalized),
  );
  return resolveUniqueZone(exactTermMatches, target);
}

function resolveContainedDatabaseTarget(
  normalizedExpression: string,
): TimeZoneResolution | null {
  const matches: { term: string; zone: TzdbTimeZone }[] = [];
  for (const zone of rawTimeZones) {
    for (const term of normalizedZoneTerms(zone, { includeCountryCode: false })) {
      if (term.length < 3) continue;
      if (locationAliasMatches(normalizedExpression, term)) {
        matches.push({ term, zone });
      }
    }
  }

  matches.sort((left, right) => right.term.length - left.term.length);
  const first = matches[0];
  if (!first) return null;

  const strongestMatches = matches.filter(
    (match) => match.term.length === first.term.length,
  );
  return resolveUniqueZone(
    strongestMatches.map((match) => match.zone),
    first.term,
  );
}

function extractTrailingLocationCandidate(
  normalizedExpression: string,
): string | null {
  const markers = [" in ", " for ", " at "];
  for (const marker of markers) {
    const index = normalizedExpression.lastIndexOf(marker);
    if (index >= 0) {
      const candidate = normalizedExpression.slice(index + marker.length).trim();
      return candidate || null;
    }
  }

  return null;
}

function resolveCandidateDatabaseTarget(
  candidate: string,
): TimeZoneResolution | null {
  const exactResolution = resolveDatabaseTarget(candidate, {
    includeCountryCode: false,
  });
  if (exactResolution) return exactResolution;

  const matchedTerms: { term: string; zone: TzdbTimeZone }[] = [];
  for (const zone of rawTimeZones) {
    for (const term of normalizedZoneTerms(zone, { includeCountryCode: false })) {
      if (term.length < 3) continue;
      if (locationAliasMatches(candidate, term)) {
        matchedTerms.push({ term, zone });
      }
    }
  }

  const candidateHasMultipleWords = candidate.includes(" ");
  if (candidateHasMultipleWords && matchedTerms.length < 2) return null;

  return resolveUniqueZone(
    matchedTerms.map((match) => match.zone),
    matchedTerms.map((match) => match.term).join(" + "),
  );
}

export function resolveTimeZone(
  targetTimeZone?: string | null,
  targetLocation?: string | null,
): TimeZoneResolution {
  const trimmedZone = targetTimeZone?.trim();
  if (trimmedZone && isValidTimeZone(trimmedZone)) {
    return {
      timeZone: trimmedZone,
      source: "provided_timezone",
      matchedLocation: null,
    };
  }

  const location = targetLocation?.trim();
  if (location) {
    if (isValidTimeZone(location)) {
      return {
        timeZone: location,
        source: "provided_timezone",
        matchedLocation: null,
      };
    }

    const databaseResolution = resolveDatabaseTarget(location, {
      includeCountryCode: true,
    });
    if (databaseResolution) return databaseResolution;
  }

  return {
    timeZone: DEFAULT_REFERENCE_TIME_ZONE,
    source: "default",
    matchedLocation: null,
  };
}

export function resolveTimeZoneFromExpression(
  expression: string | null | undefined,
): TimeZoneResolution | null {
  const normalized = normalizeLookup(expression ?? "");
  if (!normalized) return null;

  const trailingCandidate = extractTrailingLocationCandidate(normalized);
  if (trailingCandidate) {
    return resolveCandidateDatabaseTarget(trailingCandidate);
  }

  return resolveContainedDatabaseTarget(normalized);
}

export function expressionMentionsTimeTarget(
  expression: string | null | undefined,
  target: string | null | undefined,
): boolean {
  const normalizedExpression = normalizeLookup(expression ?? "");
  const normalizedTarget = normalizeLookup(target ?? "");
  if (!normalizedExpression || !normalizedTarget) return false;

  return locationAliasMatches(normalizedExpression, normalizedTarget);
}

function describeDayPeriod(dateTime: DateTime): string {
  const hour = dateTime.hour;
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

function findWeekday(expression: string): number | null {
  const words = normalizeLookup(expression).split(" ");
  for (const word of words) {
    const weekday = WEEKDAYS.get(word);
    if (weekday) return weekday;
  }
  return null;
}

function findDayPart(expression: string): string | null {
  const normalized = normalizeLookup(expression);
  for (const dayPart of DAY_PART_DEFAULT_HOURS.keys()) {
    if (normalized.includes(dayPart)) return dayPart;
  }
  return null;
}

function resolveDate(expression: string, reference: DateTime): DateTime {
  const normalized = normalizeLookup(expression);
  if (normalized.includes("day after tomorrow")) {
    return reference.plus({ days: 2 }).startOf("day");
  }
  if (normalized.includes("tomorrow")) {
    return reference.plus({ days: 1 }).startOf("day");
  }

  const weekday = findWeekday(expression);
  if (!weekday) return reference.startOf("day");

  let daysUntil = (weekday - reference.weekday + 7) % 7;
  if (daysUntil === 0 && normalized.includes(`next ${weekdayName(weekday)}`)) {
    daysUntil = 7;
  }
  return reference.plus({ days: daysUntil }).startOf("day");
}

function weekdayName(weekday: number): string {
  return (
    [...WEEKDAYS.entries()].find(
      ([name, value]) => value === weekday && name.length > 3,
    )?.[0] ?? ""
  );
}

function parseClockTime(
  expression: string,
): { hour: number; minute: number; explicitMeridiem: boolean } | null {
  const match = new RegExp(
    /\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/i,
  ).exec(expression);
  if (!match) return null;

  const rawHour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = match[3]?.toLowerCase() ?? null;
  if (!Number.isFinite(rawHour) || !Number.isFinite(minute)) return null;

  if (meridiem === "am") {
    return {
      hour: rawHour === 12 ? 0 : rawHour,
      minute,
      explicitMeridiem: true,
    };
  }
  if (meridiem === "pm") {
    return {
      hour: rawHour === 12 ? 12 : rawHour + 12,
      minute,
      explicitMeridiem: true,
    };
  }

  return { hour: rawHour, minute, explicitMeridiem: false };
}

function minutesSinceStartOfDay(dateTime: DateTime): number {
  return dateTime.hour * 60 + dateTime.minute;
}

function resolveClockTime(
  expression: string,
  reference: DateTime,
  date: DateTime,
  isCurrentTimeRequest: boolean,
): { resolved: DateTime; assumptions: string[]; daypartAssumed: boolean } {
  const clockTime = parseClockTime(expression);
  if (clockTime) {
    const resolved = date.set({
      hour: clockTime.hour,
      minute: clockTime.minute,
      second: 0,
      millisecond: 0,
    });
    const noDateGiven = date.hasSame(reference, "day");
    const alreadyPassed =
      minutesSinceStartOfDay(resolved) <= minutesSinceStartOfDay(reference);
    if (noDateGiven && alreadyPassed) {
      return {
        resolved: resolved.plus({ days: 1 }),
        assumptions: [
          "No date was specified, so a past clock time was treated as the next occurrence.",
        ],
        daypartAssumed: false,
      };
    }
    return { resolved, assumptions: [], daypartAssumed: false };
  }

  const dayPart = findDayPart(expression);
  const hour = dayPart ? DAY_PART_DEFAULT_HOURS.get(dayPart) : undefined;
  if (hour !== undefined) {
    return {
      resolved: date.set({ hour, minute: 0, second: 0, millisecond: 0 }),
      assumptions: [`"${dayPart}" was resolved as ${hour}:00 local time.`],
      daypartAssumed: true,
    };
  }

  const isFutureDateOnly = !date.hasSame(reference, "day");
  if (isFutureDateOnly) {
    return {
      resolved: date.set({ hour: 9, minute: 0, second: 0, millisecond: 0 }),
      assumptions: [
        "No clock time was provided, so 09:00 local time was used.",
      ],
      daypartAssumed: true,
    };
  }

  return {
    resolved: reference,
    assumptions: isCurrentTimeRequest
      ? []
      : ["No specific clock time was provided, so the current time was used."],
    daypartAssumed: false,
  };
}

function buildParsedTime(
  expression: string,
  reference: DateTime,
  target: DateTime,
  resolution: TimeZoneResolution,
  ambiguity: ParsedNaturalTime["ambiguity"],
  assumptions: string[],
): ParsedNaturalTime {
  const resolvedUnix = target.toUnixInteger();
  return {
    expression,
    referenceTimeZone: getZoneName(reference),
    targetTimeZone: getZoneName(target),
    targetTimeZoneSource: resolution.source,
    matchedLocation: resolution.matchedLocation,
    referenceUnix: reference.toUnixInteger(),
    resolvedUnix,
    resolvedIso: target.toISO() ?? "",
    localDate: target.toFormat("yyyy-LL-dd"),
    localTime: target.toFormat("HH:mm"),
    localTime24h: target.toFormat("HH:mm"),
    localTime12h: target.toFormat("h:mm a"),
    weekday: target.toFormat("cccc"),
    offsetName: target.offsetNameShort ?? target.toFormat("ZZ"),
    dayPeriod: describeDayPeriod(target),
    discordTimestamp: `<t:${resolvedUnix}:F>`,
    ambiguity,
    assumptions,
  };
}

function resolveTimeAmbiguity(clock: {
  assumptions: string[];
  daypartAssumed: boolean;
}): ParsedNaturalTime["ambiguity"] {
  if (clock.assumptions.some((item) => item.includes("current"))) {
    return "assumed_current_time";
  }

  if (clock.daypartAssumed) {
    return "assumed_daypart_time";
  }

  return "none";
}

export function parseNaturalTime(
  expression: string | null | undefined,
  options: {
    reference?: DateTime;
    targetTimeZone?: string | null;
    targetLocation?: string | null;
  } = {},
): ParsedNaturalTime {
  const resolution = resolveTimeZone(
    options.targetTimeZone,
    options.targetLocation,
  );
  const trimmedExpression = expression?.trim() ?? "";
  const isCurrentTimeRequest = trimmedExpression.length === 0;
  const rawExpression = isCurrentTimeRequest ? "now" : trimmedExpression;
  const reference = (options.reference ?? DateTime.now()).setZone(
    resolution.timeZone,
  );
  const date = resolveDate(rawExpression, reference);
  const clock = resolveClockTime(
    rawExpression,
    reference,
    date,
    isCurrentTimeRequest,
  );
  const ambiguity = resolveTimeAmbiguity(clock);

  return buildParsedTime(
    rawExpression,
    reference,
    clock.resolved,
    resolution,
    ambiguity,
    clock.assumptions,
  );
}

export function buildCurrentTemporalContext(
  timeZone = DEFAULT_REFERENCE_TIME_ZONE,
): CurrentTemporalContext {
  const now = DateTime.now().setZone(timeZone);
  const unix = now.toUnixInteger();
  return {
    unix,
    iso: now.toISO() ?? "",
    timeZone: getZoneName(now),
    localDate: now.toFormat("yyyy-LL-dd"),
    localTime: now.toFormat("HH:mm"),
    weekday: now.toFormat("cccc"),
    offsetName: now.offsetNameShort ?? now.toFormat("ZZ"),
    dayPeriod: describeDayPeriod(now),
    discordTime: `<t:${unix}:t>`,
    discordDateTime: `<t:${unix}:F>`,
  };
}

export function formatTemporalContext(context: CurrentTemporalContext): string {
  return [
    `CURRENT TIME: Unix ${context.unix}`,
    `Reference timezone: ${context.timeZone} (${context.offsetName})`,
    `Reference local date/time: ${context.weekday}, ${context.localDate} ${context.localTime}`,
    `Reference day period: ${context.dayPeriod}`,
    `Discord time-only timestamp for this instant: ${context.discordTime}`,
    `Discord date-time timestamp for this instant: ${context.discordDateTime}`,
    `Use resolve_time for natural-language dates, dayparts, or any location/timezone conversion.`,
    `Daypart defaults: morning=09:00, afternoon=14:00, evening=19:00, tonight/night=21:00 local time.`,
  ].join("\n");
}
