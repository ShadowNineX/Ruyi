import { DateTime, IANAZone } from "luxon";

const DEFAULT_REFERENCE_TIME_ZONE = getZoneName(DateTime.local());

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

const LOCATION_TIME_ZONES = new Map([
  ["north carolina", "America/New_York"],
  ["nc", "America/New_York"],
  ["new york", "America/New_York"],
  ["nyc", "America/New_York"],
  ["eastern time", "America/New_York"],
  ["est", "America/New_York"],
  ["edt", "America/New_York"],
  ["california", "America/Los_Angeles"],
  ["los angeles", "America/Los_Angeles"],
  ["pacific time", "America/Los_Angeles"],
  ["pst", "America/Los_Angeles"],
  ["pdt", "America/Los_Angeles"],
  ["texas", "America/Chicago"],
  ["chicago", "America/Chicago"],
  ["central time", "America/Chicago"],
  ["cst", "America/Chicago"],
  ["cdt", "America/Chicago"],
  ["denver", "America/Denver"],
  ["colorado", "America/Denver"],
  ["mountain time", "America/Denver"],
  ["mst", "America/Denver"],
  ["mdt", "America/Denver"],
  ["arizona", "America/Phoenix"],
  ["phoenix", "America/Phoenix"],
  ["alaska", "America/Anchorage"],
  ["hawaii", "Pacific/Honolulu"],
  ["sweden", "Europe/Stockholm"],
  ["stockholm", "Europe/Stockholm"],
  ["uk", "Europe/London"],
  ["united kingdom", "Europe/London"],
  ["england", "Europe/London"],
  ["london", "Europe/London"],
  ["japan", "Asia/Tokyo"],
  ["tokyo", "Asia/Tokyo"],
  ["korea", "Asia/Seoul"],
  ["seoul", "Asia/Seoul"],
  ["australia eastern", "Australia/Sydney"],
  ["sydney", "Australia/Sydney"],
  ["utc", "UTC"],
  ["gmt", "UTC"],
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
  source: "default" | "provided_timezone" | "location_alias";
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
    .toLowerCase()
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/[^a-z0-9/+ ]+/g, "")
    .trim()
    .replaceAll(/\s+/g, " ");
}

function getZoneName(dateTime: DateTime): string {
  return dateTime.zoneName ?? "UTC";
}

function isValidTimeZone(value: string): boolean {
  return IANAZone.isValidZone(value);
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
    const normalized = normalizeLookup(location);
    const aliasedZone = LOCATION_TIME_ZONES.get(normalized);
    if (aliasedZone) {
      return {
        timeZone: aliasedZone,
        source: "location_alias",
        matchedLocation: location,
      };
    }

    if (isValidTimeZone(location)) {
      return {
        timeZone: location,
        source: "provided_timezone",
        matchedLocation: null,
      };
    }
  }

  return {
    timeZone: DEFAULT_REFERENCE_TIME_ZONE,
    source: "default",
    matchedLocation: null,
  };
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
): { resolved: DateTime; assumptions: string[]; daypartAssumed: boolean } {
  const normalized = normalizeLookup(expression);
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

  const isCurrentTimeRequest =
    normalized === "now" ||
    normalized === "current time" ||
    normalized === "what time is it";
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
  const rawExpression = expression?.trim() || "now";
  const reference = (options.reference ?? DateTime.now()).setZone(
    resolution.timeZone,
  );
  const date = resolveDate(rawExpression, reference);
  const clock = resolveClockTime(rawExpression, reference, date);
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
