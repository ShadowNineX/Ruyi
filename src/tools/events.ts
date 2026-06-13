import { tool } from "@openai/agents";
import { z } from "zod";
import {
  ChannelType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
  type Guild,
  type GuildScheduledEvent,
  type GuildScheduledEventCreateOptions,
  type GuildScheduledEventEditOptions,
  type PermissionResolvable,
} from "discord.js";
import { toolLogger } from "../logger";
import { parseNaturalTime } from "../utils/natural-time";
import { requesterHasGuildPermission } from "../utils/discord-permissions";
import { formatError, toolContextManager } from "../utils/types";

const EVENT_ID_REGEX = /^\d{17,20}$/;
const DEFAULT_EVENT_DURATION_MINUTES = 60;
const MAX_EVENT_RESULTS = 25;

const EVENT_STATUS_LABELS: Record<GuildScheduledEventStatus, string> = {
  [GuildScheduledEventStatus.Scheduled]: "scheduled",
  [GuildScheduledEventStatus.Active]: "active",
  [GuildScheduledEventStatus.Completed]: "completed",
  [GuildScheduledEventStatus.Canceled]: "canceled",
};

const EVENT_ENTITY_LABELS: Record<GuildScheduledEventEntityType, string> = {
  [GuildScheduledEventEntityType.StageInstance]: "stage",
  [GuildScheduledEventEntityType.Voice]: "voice",
  [GuildScheduledEventEntityType.External]: "external",
};

type EventWriteAction =
  | "create"
  | "edit"
  | "move"
  | "cancel"
  | "delete"
  | "start"
  | "complete";

type EventEntityInput = "external" | "voice" | "stage";

interface TimeResolutionOptions {
  targetLocation: string | null;
  targetTimeZone: string | null;
}

interface EventWindow {
  start: Date;
  end: Date;
  startUnix: number;
  endUnix: number;
  assumptions: string[];
}

interface EventMutationInput {
  eventIdOrName: string | null;
  title: string | null;
  description: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  eventType: EventEntityInput | null;
  location: string | null;
  channelId: string | null;
  timeOptions: TimeResolutionOptions;
}

type EventLookupResult =
  | { ok: true; event: GuildScheduledEvent }
  | { ok: false; error: string; matches?: ReturnType<typeof formatEvent>[] };

type EventPermission = {
  permission: PermissionResolvable;
  label: string;
};

function eventPermissionForAction(action: EventWriteAction): EventPermission {
  if (action === "create") {
    return {
      permission: PermissionFlagsBits.CreateEvents,
      label: "Create Events",
    };
  }

  return {
    permission: PermissionFlagsBits.ManageEvents,
    label: "Manage Events",
  };
}

async function ensureEventPermission(
  guild: Guild,
  action: EventWriteAction,
): Promise<string | null> {
  const required = eventPermissionForAction(action);
  if (!(await requesterHasGuildPermission(guild, required.permission))) {
    return `You need ${required.label} permission to ${action} server events.`;
  }

  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  if (!botMember.permissions.has(required.permission)) {
    return `Ruyi needs ${required.label} permission to ${action} server events.`;
  }

  return null;
}

function clampLimit(value: number | null): number {
  return Math.min(Math.max(Math.round(value ?? 10), 1), MAX_EVENT_RESULTS);
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

function formatDiscordTimestamp(timestamp: number | null): string | null {
  return timestamp ? `<t:${Math.floor(timestamp / 1000)}:F>` : null;
}

function formatEvent(event: GuildScheduledEvent) {
  return {
    id: event.id,
    name: event.name,
    description: event.description ?? null,
    status: EVENT_STATUS_LABELS[event.status],
    entityType: EVENT_ENTITY_LABELS[event.entityType],
    channelId: event.channelId,
    location: event.entityMetadata?.location ?? null,
    startTimestamp: event.scheduledStartTimestamp,
    endTimestamp: event.scheduledEndTimestamp,
    startsAt: event.scheduledStartAt?.toISOString() ?? null,
    endsAt: event.scheduledEndAt?.toISOString() ?? null,
    discordStart: formatDiscordTimestamp(event.scheduledStartTimestamp),
    discordEnd: formatDiscordTimestamp(event.scheduledEndTimestamp),
    userCount: event.userCount,
    url: event.url,
  };
}

function eventOverlapsWindow(
  event: GuildScheduledEvent,
  startMs: number,
  endMs: number,
): boolean {
  const eventStart = event.scheduledStartTimestamp;
  if (!eventStart) return false;

  const eventEnd =
    event.scheduledEndTimestamp ??
    eventStart + DEFAULT_EVENT_DURATION_MINUTES * 60 * 1000;

  return eventStart < endMs && eventEnd > startMs;
}

function parseEventDate(
  expression: string,
  options: TimeResolutionOptions,
): { date: Date; unix: number; assumptions: string[] } {
  const parsed = parseNaturalTime(expression, {
    targetLocation: options.targetLocation,
    targetTimeZone: options.targetTimeZone,
  });

  return {
    date: new Date(parsed.resolvedUnix * 1000),
    unix: parsed.resolvedUnix,
    assumptions: parsed.assumptions,
  };
}

function resolveDurationMinutes(
  durationMinutes: number | null,
  fallbackMinutes = DEFAULT_EVENT_DURATION_MINUTES,
): number {
  return Math.min(Math.max(Math.round(durationMinutes ?? fallbackMinutes), 1), 24 * 60);
}

function buildEventWindow(
  startTime: string,
  endTime: string | null,
  durationMinutes: number | null,
  options: TimeResolutionOptions,
  fallbackDurationMinutes = DEFAULT_EVENT_DURATION_MINUTES,
): EventWindow {
  const start = parseEventDate(startTime, options);
  const end = endTime
    ? parseEventDate(endTime, options)
    : {
        date: new Date(
          start.date.getTime() +
            resolveDurationMinutes(durationMinutes, fallbackDurationMinutes) *
              60 *
              1000,
        ),
        unix:
          start.unix +
          resolveDurationMinutes(durationMinutes, fallbackDurationMinutes) * 60,
        assumptions: [],
      };

  if (end.date.getTime() <= start.date.getTime()) {
    throw new Error("Event end time must be after the start time.");
  }

  return {
    start: start.date,
    end: end.date,
    startUnix: start.unix,
    endUnix: end.unix,
    assumptions: [...start.assumptions, ...end.assumptions],
  };
}

function getExistingDurationMinutes(event: GuildScheduledEvent): number {
  const start = event.scheduledStartTimestamp;
  const end = event.scheduledEndTimestamp;
  if (!start || !end || end <= start) return DEFAULT_EVENT_DURATION_MINUTES;
  return Math.max(1, Math.round((end - start) / 60_000));
}

async function fetchGuildEvents(guild: Guild) {
  const events = await guild.scheduledEvents.fetch({
    cache: false,
    withUserCount: true,
  });
  return [...events.values()].sort(
    (a, b) => (a.scheduledStartTimestamp ?? 0) - (b.scheduledStartTimestamp ?? 0),
  );
}

async function findEvent(
  guild: Guild,
  eventIdOrName: string | null,
): Promise<EventLookupResult> {
  const lookup = eventIdOrName?.trim();
  if (!lookup) {
    return { ok: false, error: "event_id_or_name is required for this action." };
  }

  const events = await fetchGuildEvents(guild);
  if (EVENT_ID_REGEX.test(lookup)) {
    const event = events.find((item) => item.id === lookup);
    return event
      ? { ok: true, event }
      : { ok: false, error: `No scheduled event found with ID ${lookup}.` };
  }

  const normalized = normalizeLookup(lookup);
  const exactMatches = events.filter(
    (event) => normalizeLookup(event.name) === normalized,
  );
  const exactMatch = exactMatches[0];
  if (exactMatches.length === 1 && exactMatch) {
    return { ok: true, event: exactMatch };
  }

  const partialMatches = events.filter((event) =>
    normalizeLookup(event.name).includes(normalized),
  );
  const matches = exactMatches.length > 0 ? exactMatches : partialMatches;

  const singleMatch = matches[0];
  if (matches.length === 1 && singleMatch) {
    return { ok: true, event: singleMatch };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error:
        "Multiple scheduled events matched. Use one of the returned event IDs.",
      matches: matches.slice(0, 10).map(formatEvent),
    };
  }

  return { ok: false, error: `No scheduled event matched "${lookup}".` };
}

function toEntityType(input: EventEntityInput): GuildScheduledEventEntityType {
  switch (input) {
    case "stage":
      return GuildScheduledEventEntityType.StageInstance;
    case "voice":
      return GuildScheduledEventEntityType.Voice;
    case "external":
      return GuildScheduledEventEntityType.External;
  }
}

async function validateEventChannel(
  guild: Guild,
  eventType: EventEntityInput,
  channelId: string | null,
): Promise<string | null> {
  if (eventType === "external") return null;
  if (!channelId?.trim()) {
    return `${eventType} events require a voice or stage channel_id.`;
  }

  const channel =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));
  const expectedType =
    eventType === "stage" ? ChannelType.GuildStageVoice : ChannelType.GuildVoice;

  if (channel?.type === expectedType) return null;

  const channelKind = eventType === "stage" ? "stage" : "voice";
  return `${eventType} events require a ${channelKind} channel.`;
}

function buildCreateOptions(input: {
  title: string;
  description: string | null;
  eventType: EventEntityInput;
  location: string | null;
  channelId: string | null;
  window: EventWindow;
}): GuildScheduledEventCreateOptions {
  const entityType = toEntityType(input.eventType);
  const base = {
    name: input.title,
    scheduledStartTime: input.window.start,
    scheduledEndTime: input.window.end,
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    entityType,
    description: input.description ?? undefined,
    reason: "Managed by Ruyi bot",
  } satisfies GuildScheduledEventCreateOptions;

  if (input.eventType === "external") {
    return {
      ...base,
      entityMetadata: { location: input.location ?? undefined },
    };
  }

  return {
    ...base,
    channel: input.channelId ?? undefined,
  };
}

function buildEditOptions(input: {
  event: GuildScheduledEvent;
  title: string | null;
  description: string | null;
  eventType: EventEntityInput | null;
  location: string | null;
  channelId: string | null;
  window: EventWindow | null;
}): GuildScheduledEventEditOptions<GuildScheduledEventStatus, GuildScheduledEventStatus.Active | GuildScheduledEventStatus.Canceled | GuildScheduledEventStatus.Completed> {
  const options: GuildScheduledEventEditOptions<
    GuildScheduledEventStatus,
    | GuildScheduledEventStatus.Active
    | GuildScheduledEventStatus.Canceled
    | GuildScheduledEventStatus.Completed
  > = {
    reason: "Managed by Ruyi bot",
  };

  if (input.title) options.name = input.title;
  if (input.description !== null) options.description = input.description;
  if (input.window) {
    options.scheduledStartTime = input.window.start;
    options.scheduledEndTime = input.window.end;
  }

  const eventType =
    input.eventType ??
    (EVENT_ENTITY_LABELS[input.event.entityType] as EventEntityInput);
  if (input.eventType) options.entityType = toEntityType(input.eventType);

  if (eventType === "external") {
    options.channel = null;
    options.entityMetadata = {
      location: input.location ?? input.event.entityMetadata?.location ?? undefined,
    };
  } else if (input.channelId) {
    options.channel = input.channelId;
  }

  return options;
}

function requireExternalLocation(
  eventType: EventEntityInput,
  location: string | null,
): string | null {
  return eventType === "external" && !location?.trim()
    ? "External events require a location."
    : null;
}

async function handleCreateEvent(
  guild: Guild,
  input: EventMutationInput,
) {
  if (!input.title?.trim()) {
    return { error: "title is required to create an event." };
  }
  if (!input.startTime?.trim()) {
    return { error: "start_time is required to create an event." };
  }

  const resolvedEventType = input.eventType ?? "external";
  const locationError = requireExternalLocation(
    resolvedEventType,
    input.location,
  );
  if (locationError) return { error: locationError };

  const channelError = await validateEventChannel(
    guild,
    resolvedEventType,
    input.channelId,
  );
  if (channelError) return { error: channelError };

  const window = buildEventWindow(
    input.startTime,
    input.endTime,
    input.durationMinutes,
    input.timeOptions,
  );

  const event = await guild.scheduledEvents.create(
    buildCreateOptions({
      title: input.title.trim(),
      description: input.description,
      eventType: resolvedEventType,
      location: input.location,
      channelId: input.channelId,
      window,
    }),
  );

  return {
    success: true,
    action: "created",
    event: formatEvent(event),
    assumptions: window.assumptions,
  };
}

async function handleEditEvent(
  guild: Guild,
  input: EventMutationInput,
) {
  const lookup = await findEvent(guild, input.eventIdOrName);
  if (!lookup.ok) return { error: lookup.error, matches: lookup.matches };

  const targetEventType =
    input.eventType ??
    (EVENT_ENTITY_LABELS[lookup.event.entityType] as EventEntityInput);
  const locationError = input.eventType
    ? requireExternalLocation(
        targetEventType,
        input.location ?? lookup.event.entityMetadata?.location ?? null,
      )
    : null;
  if (locationError) return { error: locationError };

  const channelError = await validateEventChannel(
    guild,
    targetEventType,
    input.channelId ?? lookup.event.channelId,
  );
  if (channelError) return { error: channelError };

  const window =
    input.startTime?.trim()
      ? buildEventWindow(
          input.startTime,
          input.endTime,
          input.durationMinutes,
          input.timeOptions,
          getExistingDurationMinutes(lookup.event),
        )
      : null;

  const edited = await lookup.event.edit(
    buildEditOptions({
      event: lookup.event,
      title: input.title?.trim() || null,
      description: input.description,
      eventType: input.eventType,
      location: input.location,
      channelId: input.channelId,
      window,
    }),
  );

  return {
    success: true,
    action: "edited",
    event: formatEvent(edited),
    assumptions: window?.assumptions ?? [],
  };
}

async function handleMoveEvent(
  guild: Guild,
  eventIdOrName: string | null,
  startTime: string | null,
  endTime: string | null,
  durationMinutes: number | null,
  timeOptions: TimeResolutionOptions,
) {
  if (!startTime?.trim()) {
    return { error: "start_time is required to move an event." };
  }

  const lookup = await findEvent(guild, eventIdOrName);
  if (!lookup.ok) return { error: lookup.error, matches: lookup.matches };

  const window = buildEventWindow(
    startTime,
    endTime,
    durationMinutes,
    timeOptions,
    getExistingDurationMinutes(lookup.event),
  );
  const edited = await lookup.event.edit({
    scheduledStartTime: window.start,
    scheduledEndTime: window.end,
    reason: "Moved by Ruyi bot",
  });

  return {
    success: true,
    action: "moved",
    event: formatEvent(edited),
    assumptions: window.assumptions,
  };
}

async function handleStatusEvent(
  guild: Guild,
  eventIdOrName: string | null,
  action: Extract<EventWriteAction, "cancel" | "start" | "complete">,
) {
  const lookup = await findEvent(guild, eventIdOrName);
  if (!lookup.ok) return { error: lookup.error, matches: lookup.matches };

  let nextStatus = GuildScheduledEventStatus.Completed;
  if (action === "cancel") {
    nextStatus = GuildScheduledEventStatus.Canceled;
  } else if (action === "start") {
    nextStatus = GuildScheduledEventStatus.Active;
  }

  const edited = await lookup.event.setStatus(nextStatus, "Managed by Ruyi bot");
  return {
    success: true,
    action,
    event: formatEvent(edited),
  };
}

async function handleDeleteEvent(guild: Guild, eventIdOrName: string | null) {
  const lookup = await findEvent(guild, eventIdOrName);
  if (!lookup.ok) return { error: lookup.error, matches: lookup.matches };

  const event = formatEvent(lookup.event);
  await lookup.event.delete();
  return {
    success: true,
    action: "deleted",
    event,
  };
}

export const getEventsTool = tool({
  name: "get_events",
  description:
    "List Discord server scheduled events or check server event availability for a time window.",
  parameters: z.object({
    action: z
      .enum(["list", "availability"])
      .describe("Use list for upcoming events or availability to find overlaps."),
    query: z
      .string()
      .nullable()
      .describe("Optional event title filter for list mode."),
    start_time: z
      .string()
      .nullable()
      .describe(
        "Natural-language window start, such as 'tonight 8pm' or 'next Friday 19:00'. Required for availability.",
      ),
    end_time: z
      .string()
      .nullable()
      .describe("Natural-language window end. Use null with duration_minutes."),
    duration_minutes: z
      .number()
      .nullable()
      .describe("Window duration when end_time is null. Defaults to 60 minutes."),
    target_location: z
      .string()
      .nullable()
      .describe("Optional place name for resolving natural-language times."),
    target_timezone: z
      .string()
      .nullable()
      .describe("Optional IANA timezone for resolving natural-language times."),
    max_results: z.number().nullable().describe("Maximum events to return, 1-25."),
  }),
  execute: async ({
    action,
    query,
    start_time,
    end_time,
    duration_minutes,
    target_location,
    target_timezone,
    max_results,
  }) => {
    const { guild } = toolContextManager.get();
    if (!guild) return { error: "Calendar events are only available in servers." };

    try {
      const limit = clampLimit(max_results);
      const events = await fetchGuildEvents(guild);
      const filteredEvents = query?.trim()
        ? events.filter((event) =>
            normalizeLookup(event.name).includes(normalizeLookup(query)),
          )
        : events;

      if (action === "list") {
        return {
          server: guild.name,
          events: filteredEvents.slice(0, limit).map(formatEvent),
          total: filteredEvents.length,
        };
      }

      if (!start_time?.trim()) {
        return { error: "start_time is required for availability checks." };
      }

      const window = buildEventWindow(start_time, end_time, duration_minutes, {
        targetLocation: target_location,
        targetTimeZone: target_timezone,
      });
      const overlaps = filteredEvents
        .filter((event) =>
          eventOverlapsWindow(
            event,
            window.start.getTime(),
            window.end.getTime(),
          ),
        )
        .slice(0, limit)
        .map(formatEvent);

      return {
        server: guild.name,
        available: overlaps.length === 0,
        limitation:
          "This checks Discord server scheduled events only, not every member's private calendar.",
        window: {
          start: window.start.toISOString(),
          end: window.end.toISOString(),
          discordStart: `<t:${window.startUnix}:F>`,
          discordEnd: `<t:${window.endUnix}:F>`,
          assumptions: window.assumptions,
        },
        overlaps,
      };
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error({ error: errorMessage, action }, "Event lookup failed");
      return { error: "Failed to read server events", details: errorMessage };
    }
  },
});

export const manageEventTool = tool({
  name: "manage_event",
  description:
    "Create, edit, move, start, complete, cancel, or delete Discord server scheduled events. Use get_events first when the target event is ambiguous.",
  parameters: z.object({
    action: z
      .enum(["create", "edit", "move", "cancel", "delete", "start", "complete"])
      .describe("Event action to perform."),
    event_id_or_name: z
      .string()
      .nullable()
      .describe("Event ID or name for edit/move/cancel/delete/start/complete."),
    title: z
      .string()
      .nullable()
      .describe("Event title for create/edit. Null to leave unchanged."),
    description: z
      .string()
      .nullable()
      .describe("Event description for create/edit. Null to leave unchanged."),
    start_time: z
      .string()
      .nullable()
      .describe("Natural-language start time for create/move/edit."),
    end_time: z
      .string()
      .nullable()
      .describe("Natural-language end time. Use null with duration_minutes."),
    duration_minutes: z
      .number()
      .nullable()
      .describe("Duration when end_time is null. Defaults to 60 minutes."),
    target_location: z
      .string()
      .nullable()
      .describe("Optional place name for resolving natural-language times."),
    target_timezone: z
      .string()
      .nullable()
      .describe("Optional IANA timezone for resolving natural-language times."),
    event_type: z
      .enum(["external", "voice", "stage"])
      .nullable()
      .describe("Event type for create/edit. Defaults to external on create."),
    location: z
      .string()
      .nullable()
      .describe("External event location. Required for external events."),
    channel_id: z
      .string()
      .nullable()
      .describe("Voice or stage channel ID for voice/stage events."),
  }),
  needsApproval: true,
  execute: async ({
    action,
    event_id_or_name,
    title,
    description,
    start_time,
    end_time,
    duration_minutes,
    target_location,
    target_timezone,
    event_type,
    location,
    channel_id,
  }) => {
    const { guild } = toolContextManager.get();
    if (!guild) return { error: "Calendar events are only available in servers." };

    const permissionError = await ensureEventPermission(guild, action);
    if (permissionError) return { error: permissionError };

    const timeOptions = {
      targetLocation: target_location,
      targetTimeZone: target_timezone,
    };
    const mutationInput: EventMutationInput = {
      eventIdOrName: event_id_or_name,
      title,
      description,
      startTime: start_time,
      endTime: end_time,
      durationMinutes: duration_minutes,
      eventType: event_type,
      location,
      channelId: channel_id,
      timeOptions,
    };

    try {
      switch (action) {
        case "create":
          return await handleCreateEvent(guild, mutationInput);
        case "edit":
          return await handleEditEvent(guild, mutationInput);
        case "move":
          return await handleMoveEvent(
            guild,
            event_id_or_name,
            start_time,
            end_time,
            duration_minutes,
            timeOptions,
          );
        case "cancel":
        case "start":
        case "complete":
          return await handleStatusEvent(guild, event_id_or_name, action);
        case "delete":
          return await handleDeleteEvent(guild, event_id_or_name);
      }
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error({ error: errorMessage, action }, "Event management failed");
      return { error: `Failed to ${action} event`, details: errorMessage };
    }
  },
});
