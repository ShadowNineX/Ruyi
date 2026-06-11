import { tool } from "@openai/agents";
import { z } from "zod";
import type { ColorResolvable, Guild, Role, GuildMember } from "discord.js";
import { toolLogger } from "../logger";
import { toolContextManager, formatError } from "../utils/types";

function parseColor(
  color: string | undefined | null,
): ColorResolvable | undefined {
  if (!color) return undefined;
  const normalized = color.trim().replace(/^#/, "");
  if (!/^[\da-f]{6}$/i.test(normalized)) return undefined;
  return `#${normalized}`;
}

function findRole(guild: Guild, roleName: string): Role | undefined {
  const normalized = roleName.toLowerCase();
  return (
    guild.roles.cache.find((role) => role.name.toLowerCase() === normalized) ??
    guild.roles.cache.find((role) =>
      role.name.toLowerCase().includes(normalized),
    )
  );
}

async function findMember(
  guild: Guild,
  username: string,
): Promise<GuildMember | undefined> {
  const members = await guild.members.fetch({ query: username, limit: 10 });
  return (
    members.find(
      (m) => m.user.username.toLowerCase() === username.toLowerCase(),
    ) || members.first()
  );
}

function getRoleManageabilityError(role: Role): string | null {
  if (role.managed) {
    return `Role "${role.name}" is managed by an integration and cannot be changed by the bot.`;
  }
  if (!role.editable) {
    return `Role "${role.name}" is above or equal to the bot's highest role, or the bot lacks Manage Roles permission.`;
  }
  return null;
}

// Extracted action handlers to reduce complexity
async function handleCreateRole(
  guild: Guild,
  roleName: string,
  color: string | null,
) {
  if (findRole(guild, roleName)) {
    return { error: `Role "${roleName}" already exists` };
  }
  const parsedColor = parseColor(color);
  if (color && !parsedColor) {
    return {
      error: "Invalid role color. Use a 6-digit hex color like #FF5733.",
    };
  }
  const newRole = await guild.roles.create({
    name: roleName,
    color: parsedColor,
    reason: "Created by Ruyi bot",
  });
  toolLogger.info(
    { role: newRole.name, color: newRole.hexColor },
    "Created role",
  );
  return {
    success: true,
    action: "created",
    role: { name: newRole.name, color: newRole.hexColor, id: newRole.id },
  };
}

async function handleEditRole(
  guild: Guild,
  roleName: string,
  newName: string | null,
  color: string | null,
) {
  const role = findRole(guild, roleName);
  if (!role) {
    return { error: `Role "${roleName}" not found` };
  }
  const manageabilityError = getRoleManageabilityError(role);
  if (manageabilityError) return { error: manageabilityError };
  if (!newName && !color) {
    return { error: "No changes specified (provide new_name or color)" };
  }
  const parsedColor = parseColor(color);
  if (color && !parsedColor) {
    return {
      error: "Invalid role color. Use a 6-digit hex color like #FF5733.",
    };
  }
  await role.edit({
    name: newName ?? undefined,
    color: parsedColor,
    reason: "Edited by Ruyi bot",
  });
  toolLogger.info({ role: role.name, newName, color }, "Edited role");
  return {
    success: true,
    action: "edited",
    role: { name: role.name, color: role.hexColor, id: role.id },
  };
}

async function handleAssignRole(
  guild: Guild,
  roleName: string,
  username: string | null,
) {
  if (!username) {
    return { error: "Username required for assign action" };
  }
  const role = findRole(guild, roleName);
  if (!role) {
    return { error: `Role "${roleName}" not found` };
  }
  const manageabilityError = getRoleManageabilityError(role);
  if (manageabilityError) return { error: manageabilityError };
  const member = await findMember(guild, username);
  if (!member) {
    return { error: `User "${username}" not found` };
  }
  if (member.roles.cache.has(role.id)) {
    return {
      error: `${member.user.username} already has the "${role.name}" role`,
    };
  }
  await member.roles.add(role, "Assigned by Ruyi bot");
  toolLogger.info(
    { role: role.name, user: member.user.username },
    "Assigned role",
  );
  return {
    success: true,
    action: "assigned",
    role: { name: role.name, color: role.hexColor },
    user: member.user.username,
  };
}

async function handleRemoveRole(
  guild: Guild,
  roleName: string,
  username: string | null,
) {
  if (!username) {
    return { error: "Username required for remove action" };
  }
  const role = findRole(guild, roleName);
  if (!role) {
    return { error: `Role "${roleName}" not found` };
  }
  const manageabilityError = getRoleManageabilityError(role);
  if (manageabilityError) return { error: manageabilityError };
  const member = await findMember(guild, username);
  if (!member) {
    return { error: `User "${username}" not found` };
  }
  if (!member.roles.cache.has(role.id)) {
    return {
      error: `${member.user.username} doesn't have the "${role.name}" role`,
    };
  }
  await member.roles.remove(role, "Removed by Ruyi bot");
  toolLogger.info(
    { role: role.name, user: member.user.username },
    "Removed role",
  );
  return {
    success: true,
    action: "removed",
    role: { name: role.name, color: role.hexColor },
    user: member.user.username,
  };
}

export const manageRoleTool = tool({
  name: "manage_role",
  description:
    "Manage Discord roles: create a new role, edit an existing role's name/color, or assign/remove a role from a user",
  parameters: z.object({
    action: z
      .enum(["create", "edit", "assign", "remove"])
      .describe(
        "Action to perform: create a new role, edit existing role, assign role to user, or remove role from user",
      ),
    role_name: z
      .string()
      .min(1)
      .describe("Name of the role to create, edit, assign, or remove"),
    new_name: z
      .string()
      .nullable()
      .describe("New name for the role (only for edit action, null otherwise)"),
    color: z
      .string()
      .nullable()
      .describe(
        "Hex color for the role e.g. '#FF5733' (for create/edit actions, null otherwise)",
      ),
    username: z
      .string()
      .nullable()
      .describe(
        "Username to assign/remove the role to/from (for assign/remove actions, null otherwise)",
      ),
  }),
  needsApproval: true,
  execute: async ({ action, role_name, new_name, color, username }) => {
    const { guild } = toolContextManager.get();
    if (!guild) {
      toolLogger.warn("manage_role called without guild context");
      return { error: "Not in a server" };
    }

    const roleName = role_name.trim();
    const newName = new_name?.trim() || null;

    if (!roleName) {
      return { error: "Role name cannot be empty" };
    }

    toolLogger.debug(
      { action, role_name: roleName, new_name: newName, color, username },
      "Managing role",
    );

    try {
      switch (action) {
        case "create":
          return await handleCreateRole(guild, roleName, color);
        case "edit":
          return await handleEditRole(guild, roleName, newName, color);
        case "assign":
          return await handleAssignRole(guild, roleName, username);
        case "remove":
          return await handleRemoveRole(guild, roleName, username);
        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { action, role_name: roleName, error: errorMessage },
        "Error managing role",
      );
      return { error: `Failed to ${action} role: ${errorMessage}` };
    }
  },
});
