import type {
  resolveTimeZone,
  TimeZoneResolution,
} from '../utils/natural-time';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { conversationContext } from '../ai/context';
import { toolLogger } from '../logger';
import {
  expressionMentionsTimeTarget,
  parseNaturalTime,
  resolveTimeZoneFromExpression,

} from '../utils/natural-time';
import { formatError, toolContextManager } from '../utils/types';

function isDefaultZoneFromUnresolvedLocation(
  source: ReturnType<typeof resolveTimeZone>['source'],
  location: string | null | undefined,
  timeZone: string | null | undefined,
): boolean {
  return source === 'default' && Boolean(location?.trim()) && !timeZone?.trim();
}

async function fetchCurrentUserTimeZone(): Promise<{
  timeZone: string;
  source: string;
} | null> {
  const identity = toolContextManager.get().identity;
  if (!identity) { return null; }

  return conversationContext.fetchUserTimeZone(identity);
}

function shouldPreferUserLocalTarget(
  expression: string | null | undefined,
  targetLocation: string | null | undefined,
  targetTimeZone: string | null | undefined,
  useUserTimezone: boolean,
): boolean {
  if (!useUserTimezone) { return false; }
  if (targetLocation && expressionMentionsTimeTarget(expression, targetLocation)) {
    return false;
  }
  if (targetTimeZone && expressionMentionsTimeTarget(expression, targetTimeZone)) {
    return false;
  }

  return resolveTimeZoneFromExpression(expression) === null;
}

async function resolveToolTarget(
  expression: string | null | undefined,
  targetLocation: string | null | undefined,
  targetTimeZone: string | null | undefined,
  useUserTimezone: boolean,
): Promise<{
  targetLocation: string | null;
  targetTimeZone: string | null;
  targetContext:
    | 'expression_location'
    | 'user_local_memory'
    | 'provided_target'
    | 'default_reference';
  expressionResolution: TimeZoneResolution | null;
  userTimeZone: { timeZone: string; source: string } | null;
  needsUserTimeZone: boolean;
}> {
  const expressionResolution = resolveTimeZoneFromExpression(expression);
  if (expressionResolution) {
    return {
      targetLocation: expressionResolution.matchedLocation,
      targetTimeZone: expressionResolution.timeZone,
      targetContext: 'expression_location',
      expressionResolution,
      userTimeZone: null,
      needsUserTimeZone: false,
    };
  }

  if (
    shouldPreferUserLocalTarget(
      expression,
      targetLocation,
      targetTimeZone,
      useUserTimezone,
    )
  ) {
    const userTimeZone = await fetchCurrentUserTimeZone();
    return {
      targetLocation: null,
      targetTimeZone: userTimeZone?.timeZone ?? null,
      targetContext: userTimeZone ? 'user_local_memory' : 'default_reference',
      expressionResolution,
      userTimeZone,
      needsUserTimeZone: !userTimeZone,
    };
  }

  if (!targetLocation?.trim() && !targetTimeZone?.trim()) {
    const userTimeZone = await fetchCurrentUserTimeZone();
    if (userTimeZone) {
      return {
        targetLocation: null,
        targetTimeZone: userTimeZone.timeZone,
        targetContext: 'user_local_memory',
        expressionResolution,
        userTimeZone,
        needsUserTimeZone: false,
      };
    }
  }

  return {
    targetLocation: targetLocation ?? null,
    targetTimeZone: targetTimeZone ?? null,
    targetContext:
      targetLocation || targetTimeZone ? 'provided_target' : 'default_reference',
    expressionResolution,
    userTimeZone: null,
    needsUserTimeZone: false,
  };
}

export const resolveTimeTool = tool({
  name: 'resolve_time',
  description:
    'Resolve natural-language time/date expressions, user-local time, preferred clock formats, and timezone conversions.',
  parameters: z.object({
    expression: z
      .string()
      .nullable()
      .describe(
        'Natural-language time expression to resolve, such as \'now\', \'tonight\', \'tomorrow 8pm\', or \'next Friday\'. Use null for the current time.',
      ),
    target_location: z
      .string()
      .nullable()
      .describe(
        'Optional place name like \'North Carolina\', \'Sweden\', \'Tokyo\', or \'London\'. Prefer this when the user names a place.',
      ),
    target_timezone: z
      .string()
      .nullable()
      .describe(
        'Optional IANA timezone like \'America/New_York\' or \'Europe/Stockholm\'. Use this if known exactly.',
      ),
    use_user_timezone: z
      .boolean()
      .default(false)
      .describe(
        'Set true when the user asks for their own local time/timezone. Code resolves the active user\'s stored timezone; do not pass user IDs.',
      ),
    output_format: z
      .enum(['natural', '24-hour', '12-hour'])
      .default('natural')
      .describe(
        'Preferred time format for the answer. Use the user\'s explicit request first, then loaded memory preferences. Use \'natural\' when neither exists.',
      ),
  }),
  execute: async ({
    expression,
    target_location,
    target_timezone,
    use_user_timezone,
    output_format,
  }) => {
    toolLogger.info(
      {
        expression,
        target_location,
        target_timezone,
        use_user_timezone,
        output_format,
      },
      'Resolving natural-language time',
    );

    try {
      const target = await resolveToolTarget(
        expression,
        target_location,
        target_timezone,
        use_user_timezone,
      );
      if (target.needsUserTimeZone) {
        return {
          error: 'User local timezone is unknown',
          needs_clarification: true,
          target_context: target.targetContext,
          requested_user_local_time: true,
          guidance:
            'The user asked for their local time, but no user timezone memory was found. Ask briefly for their timezone/location, or use the context Discord timestamp only when a viewer-local current-time display is enough.',
        };
      }

      const parsed = parseNaturalTime(expression, {
        targetLocation: target.targetLocation,
        targetTimeZone: target.targetTimeZone,
      });

      if (
        isDefaultZoneFromUnresolvedLocation(
          parsed.targetTimeZoneSource,
          target.targetLocation,
          target.targetTimeZone,
        )
      ) {
        return {
          error:
            'I could not map that location to a timezone. Ask for a city/state I know, or provide an IANA timezone like America/New_York.',
          expression: parsed.expression,
          target_location: target.targetLocation,
        };
      }

      let preferredAnswerTime: string | null = null;
      if (output_format === '24-hour') {
        preferredAnswerTime = parsed.localTime24h;
      } else if (output_format === '12-hour') {
        preferredAnswerTime = parsed.localTime12h;
      }

      return {
        expression: parsed.expression,
        timezone: parsed.targetTimeZone,
        timezone_source: parsed.targetTimeZoneSource,
        matched_location: parsed.matchedLocation,
        target_context: target.targetContext,
        user_timezone_used: target.userTimeZone?.timeZone ?? null,
        user_timezone_source: target.userTimeZone?.source ?? null,
        local_date: parsed.localDate,
        local_time: parsed.localTime,
        local_time_24h: parsed.localTime24h,
        local_time_12h: parsed.localTime12h,
        requested_format: output_format,
        preferred_answer_time: preferredAnswerTime,
        weekday: parsed.weekday,
        offset: parsed.offsetName,
        day_period: parsed.dayPeriod,
        unix: parsed.resolvedUnix,
        discord_timestamp: parsed.discordTimestamp,
        ambiguity: parsed.ambiguity,
        assumptions: parsed.assumptions,
        guidance:
          'For a remote place/timezone, mention the target-local time and day period. For user-local questions, use target_context=user_local_memory when present. If preferred_answer_time is null, choose between local_time_24h and local_time_12h from the user\'s loaded memories or the current request. Discord timestamps render in the viewer\'s own timezone, so do not rely on them alone for remote local time.',
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        {
          expression,
          target_location,
          target_timezone,
          use_user_timezone,
          output_format,
          error: errorMessage,
        },
        'Natural-language time resolution failed',
      );
      return { error: errorMessage };
    }
  },
});
