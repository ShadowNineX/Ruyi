import { tool } from "@openai/agents";
import { z } from "zod";
import { toolLogger } from "../logger";
import { formatError } from "../utils/types";
import { parseNaturalTime, resolveTimeZone } from "../utils/natural-time";

function isDefaultZoneFromUnresolvedLocation(
  source: ReturnType<typeof resolveTimeZone>["source"],
  location: string | null | undefined,
  timeZone: string | null | undefined,
): boolean {
  return source === "default" && Boolean(location?.trim()) && !timeZone?.trim();
}

export const resolveTimeTool = tool({
  name: "resolve_time",
  description:
    "Resolve natural-language time/date expressions and timezone conversions. Use this for questions like 'what time is it in North Carolina?', 'tonight', 'tomorrow at 8pm', 'next Friday', or any time expression that needs timezone/daypart reasoning.",
  parameters: z.object({
    expression: z
      .string()
      .nullable()
      .describe(
        "Natural-language time expression to resolve, such as 'now', 'tonight', 'tomorrow 8pm', or 'next Friday'. Use null for the current time.",
      ),
    target_location: z
      .string()
      .nullable()
      .describe(
        "Optional place name like 'North Carolina', 'Sweden', 'Tokyo', or 'London'. Prefer this when the user names a place.",
      ),
    target_timezone: z
      .string()
      .nullable()
      .describe(
        "Optional IANA timezone like 'America/New_York' or 'Europe/Stockholm'. Use this if known exactly.",
      ),
  }),
  execute: async ({ expression, target_location, target_timezone }) => {
    toolLogger.info(
      { expression, target_location, target_timezone },
      "Resolving natural-language time",
    );

    try {
      const parsed = parseNaturalTime(expression, {
        targetLocation: target_location,
        targetTimeZone: target_timezone,
      });

      if (
        isDefaultZoneFromUnresolvedLocation(
          parsed.targetTimeZoneSource,
          target_location,
          target_timezone,
        )
      ) {
        return {
          error:
            "I could not map that location to a timezone. Ask for a city/state I know, or provide an IANA timezone like America/New_York.",
          expression: parsed.expression,
          target_location,
        };
      }

      return {
        expression: parsed.expression,
        timezone: parsed.targetTimeZone,
        timezone_source: parsed.targetTimeZoneSource,
        matched_location: parsed.matchedLocation,
        local_date: parsed.localDate,
        local_time: parsed.localTime,
        weekday: parsed.weekday,
        offset: parsed.offsetName,
        day_period: parsed.dayPeriod,
        unix: parsed.resolvedUnix,
        discord_timestamp: parsed.discordTimestamp,
        ambiguity: parsed.ambiguity,
        assumptions: parsed.assumptions,
        guidance:
          "For a remote place/timezone, mention the target-local time and day period. Discord timestamps render in the viewer's own timezone, so do not rely on them alone for remote local time.",
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { expression, target_location, target_timezone, error: errorMessage },
        "Natural-language time resolution failed",
      );
      return { error: errorMessage };
    }
  },
});
