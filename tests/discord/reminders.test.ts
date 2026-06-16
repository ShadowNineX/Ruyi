import { describe, expect, test } from "bun:test";
import {
  formatReminderId,
  formatReminderLine,
  reminderService,
} from "../../src/discord/services/reminders";
import type { IReminder } from "../../src/db/models";

function reminder(overrides: Partial<IReminder> = {}): IReminder {
  return {
    _id: { toString: () => "reminder-1" },
    kind: "timer",
    text: "stretch and drink water",
    dueAt: new Date("2026-06-16T12:30:00.000Z"),
    status: "scheduled",
    scopeKind: "discord:dm",
    scopeId: "user-1",
    guildId: null,
    channelId: "channel-1",
    userId: "user-1",
    username: "Shadow",
    createdByMessageId: null,
    deliveryAttempts: 0,
    processingStartedAt: null,
    lastDeliveryError: null,
    createdAt: new Date("2026-06-16T12:00:00.000Z"),
    updatedAt: new Date("2026-06-16T12:00:00.000Z"),
    ...overrides,
  } as unknown as IReminder;
}

describe("Discord reminder formatting", () => {
  test("formats reminders without exposing raw ids", () => {
    const line = formatReminderLine(reminder());

    expect(line).toContain("Timer: stretch and drink water");
    expect(line).toContain("<t:1781613000:F>");
    expect(line).toContain("<t:1781613000:R>");
    expect(line).not.toContain("reminder-1");
  });

  test("formats reminder ids only when explicitly requested by code", () => {
    expect(formatReminderId(reminder())).toBe("reminder-1");
  });

  test("truncates long reminder text in list output", () => {
    const line = formatReminderLine(
      reminder({ text: "a very long reminder text" }),
      10,
    );

    expect(line).toContain("a very...");
  });
});

describe("Discord reminder scoping", () => {
  test("uses guild scope in servers", () => {
    expect(reminderService.getScope("guild-1", "user-1")).toEqual({
      kind: "discord:guild",
      id: "guild-1",
    });
  });

  test("uses user DM scope outside servers", () => {
    expect(reminderService.getScope(null, "user-1")).toEqual({
      kind: "discord:dm",
      id: "user-1",
    });
  });
});
