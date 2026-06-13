import { describe, expect, test } from "bun:test";
import { DateTime } from "luxon";
import {
  parseNaturalTime,
  resolveTimeZone,
  resolveTimeZoneFromExpression,
} from "../src/utils/natural-time";

describe("natural time timezone lookup", () => {
  test("uses tzdb for country and city lookups", () => {
    expect(resolveTimeZone(null, "Sweden")).toMatchObject({
      timeZone: "Europe/Stockholm",
      source: "timezone_database",
    });
    expect(resolveTimeZoneFromExpression("what time is it in Tokyo?"))
      .toMatchObject({
        timeZone: "Asia/Tokyo",
        source: "timezone_database",
      });
  });

  test("does not invent timezones for regions missing from tzdb", () => {
    expect(resolveTimeZone(null, "North Carolina")).toMatchObject({
      source: "default",
    });
    expect(resolveTimeZoneFromExpression("what time is it in north carolina?"))
      .toBeNull();
  });

  test("uses tzdb IANA aliases instead of app-owned aliases", () => {
    expect(resolveTimeZone(null, "New York")).toMatchObject({
      timeZone: "America/New_York",
      source: "timezone_database",
    });
  });
});

describe("natural time local and 24-hour handling", () => {
  const stockholmReference = DateTime.fromISO("2026-06-13T12:00:00", {
    zone: "Europe/Stockholm",
  });

  test("resolves named remote locations without using the user's local zone", () => {
    const parsed = parseNaturalTime(null, {
      reference: stockholmReference,
      targetTimeZone: "America/New_York",
    });

    expect(parsed.localTime24h).toBe("06:00");
    expect(parsed.dayPeriod).toBe("morning");
  });

  test("formats user-local current time in 24-hour format", () => {
    const parsed = parseNaturalTime(null, {
      reference: stockholmReference,
      targetTimeZone: "Europe/Stockholm",
    });

    expect(parsed.localTime24h).toBe("12:00");
    expect(parsed.localTime12h).toBe("12:00 PM");
    expect(parsed.assumptions).toEqual([]);
  });

  test("keeps explicit 24-hour clock phrases intact", () => {
    const parsed = parseNaturalTime("today at 20:30", {
      reference: stockholmReference,
      targetTimeZone: "Europe/Stockholm",
    });

    expect(parsed.localTime24h).toBe("20:30");
  });
});
