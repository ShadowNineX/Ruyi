import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { AuditLogEvent, type GuildAuditLogsEntry } from "discord.js";
import { toolLogger } from "../logger";
import { toolContextManager } from "../utils/types";

const actionTypeMap: Record<string, AuditLogEvent> = {
  guild_update: AuditLogEvent.GuildUpdate,
  channel_create: AuditLogEvent.ChannelCreate,
  channel_update: AuditLogEvent.ChannelUpdate,
  channel_delete: AuditLogEvent.ChannelDelete,
  role_create: AuditLogEvent.RoleCreate,
  role_update: AuditLogEvent.RoleUpdate,
  role_delete: AuditLogEvent.RoleDelete,
  member_kick: AuditLogEvent.MemberKick,
  member_ban_add: AuditLogEvent.MemberBanAdd,
  member_ban_remove: AuditLogEvent.MemberBanRemove,
  member_update: AuditLogEvent.MemberUpdate,
  member_role_update: AuditLogEvent.MemberRoleUpdate,
  message_delete: AuditLogEvent.MessageDelete,
  message_bulk_delete: AuditLogEvent.MessageBulkDelete,
  message_pin: AuditLogEvent.MessagePin,
  message_unpin: AuditLogEvent.MessageUnpin,
  invite_create: AuditLogEvent.InviteCreate,
  invite_delete: AuditLogEvent.InviteDelete,
  webhook_create: AuditLogEvent.WebhookCreate,
  webhook_update: AuditLogEvent.WebhookUpdate,
  webhook_delete: AuditLogEvent.WebhookDelete,
  emoji_create: AuditLogEvent.EmojiCreate,
  emoji_update: AuditLogEvent.EmojiUpdate,
  emoji_delete: AuditLogEvent.EmojiDelete,
  bot_add: AuditLogEvent.BotAdd,
};

function getActionName(event: AuditLogEvent): string {
  for (const [name, value] of Object.entries(actionTypeMap)) {
    if (value === event) return name;
  }
  return `unknown_${event}`;
}

function getTargetType(target: unknown): string {
  if (!target || typeof target !== "object") return "unknown";
  if ("username" in target) return "user";
  if ("guild" in target) return "channel";
  if ("color" in target) return "role";
  return "other";
}

function formatTarget(entry: GuildAuditLogsEntry): {
  name: string | null;
  id: string | null;
  type: string | null;
} {
  const target = entry.target;
  if (!target) return { name: null, id: null, type: null };

  if (typeof target === "object" && "username" in target) {
    const user = target as { username: string | null; id: string };
    return { name: user.username ?? null, id: user.id ?? null, type: "user" };
  }

  if (typeof target === "object" && "name" in target) {
    const named = target as { name: string; id?: string };
    return {
      name: named.name ?? null,
      id: named.id ?? null,
      type: getTargetType(target),
    };
  }

  if (typeof target === "object" && "id" in target) {
    const hasId = target as { id: string };
    return { name: null, id: hasId.id ?? null, type: "unknown" };
  }

  return { name: null, id: null, type: null };
}

const actionTypes = [
  "guild_update",
  "channel_create",
  "channel_update",
  "channel_delete",
  "role_create",
  "role_update",
  "role_delete",
  "member_kick",
  "member_ban_add",
  "member_ban_remove",
  "member_update",
  "member_role_update",
  "message_delete",
  "message_bulk_delete",
  "message_pin",
  "message_unpin",
  "invite_create",
  "invite_delete",
  "webhook_create",
  "webhook_update",
  "webhook_delete",
  "emoji_create",
  "emoji_update",
  "emoji_delete",
  "bot_add",
] as const;

export const auditLogTool = defineTool("get_audit_log", {
  description:
    "Search and view the Discord server audit log. Shows who did what actions like bans, kicks, role changes, message deletions, etc.",
  parameters: z.object({
    action_type: z
      .enum(actionTypes)
      .nullable()
      .describe("Filter by action type."),
    user: z
      .string()
      .nullable()
      .describe("Filter by the user who performed the action."),
    target_user: z
      .string()
      .nullable()
      .describe("Filter by the target of the action."),
    limit: z.number().nullable().describe("Maximum entries to return (1-50)."),
  }),
  handler: async ({ action_type, user, target_user, limit }) => {
    const { guild } = toolContextManager.get();

    if (!guild) {
      toolLogger.warn("get_audit_log called without guild context");
      return { error: "Not in a server" };
    }

    const searchLimit = Math.min(Math.max(limit ?? 10, 1), 50);

    try {
      const fetchOptions: { limit: number; type?: AuditLogEvent } = {
        limit:
          user || target_user ? Math.min(searchLimit * 3, 100) : searchLimit,
      };

      if (action_type && action_type in actionTypeMap) {
        fetchOptions.type = actionTypeMap[action_type];
      }

      const auditLogs = await guild.fetchAuditLogs(fetchOptions);
      let entries = [...auditLogs.entries.values()];

      if (user) {
        const userLower = user.toLowerCase();
        entries = entries.filter((entry) => {
          const executor = entry.executor;
          if (!executor?.username) return false;
          return executor.username.toLowerCase().includes(userLower);
        });
      }

      if (target_user) {
        const targetLower = target_user.toLowerCase();
        entries = entries.filter((entry) => {
          const target = entry.target;
          if (!target || typeof target !== "object" || !("username" in target))
            return false;
          const username = (target as { username?: string }).username;
          if (!username) return false;
          return username.toLowerCase().includes(targetLower);
        });
      }

      const results = entries.slice(0, searchLimit).map((entry) => {
        const targetInfo = formatTarget(entry);
        return {
          id: entry.id,
          action: getActionName(entry.action),
          executor: entry.executor?.username ?? null,
          executorId: entry.executor?.id ?? null,
          target: targetInfo.name,
          targetId: targetInfo.id,
          targetType: targetInfo.type,
          reason: entry.reason,
          timestamp: Math.floor(entry.createdTimestamp / 1000),
          changes: entry.changes.map((c) => ({
            key: c.key,
            old: c.old,
            new: c.new,
          })),
        };
      });

      toolLogger.info(
        { action_type, user, target_user, found: results.length },
        "Audit log search complete",
      );

      return {
        entries: results,
        total: results.length,
        server: guild.name,
        hint:
          results.length > 0
            ? "Timestamps are Unix timestamps. Use <t:TIMESTAMP:F> for full date/time format in Discord."
            : "No audit log entries found matching your criteria.",
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toolLogger.error({ error: errorMessage }, "Failed to fetch audit log");

      if (
        errorMessage.includes("Missing Permissions") ||
        errorMessage.includes("VIEW_AUDIT_LOG")
      ) {
        return { error: "Missing VIEW_AUDIT_LOG permission" };
      }

      return { error: "Failed to fetch audit log", details: errorMessage };
    }
  },
});
