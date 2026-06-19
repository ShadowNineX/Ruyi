import type { ColorResolvable, Guild, GuildMember, Role } from 'discord.js';
import { tool } from '@openai/agents';
import {

  PermissionFlagsBits,

} from 'discord.js';
import { z } from 'zod';
import { toolLogger } from '../../logger';
import { formatError, toolContextManager } from '../../utils/types';

const USER_ID_REGEX = /^\d{17,20}$/;
const USER_MENTION_REGEX = /^<@!?(\d{17,20})>$/;
const INVALID_ROLE_COLOR_ERROR
  = 'Invalid role color. Use a 6-digit hex color like #FF5733.';

type RoleColorResolution
  = | { ok: true; color: ColorResolvable | undefined }
    | { ok: false; error: string };

type MemberRoleAction = 'assign' | 'remove';

function parseColor(
  color: string | undefined | null,
): ColorResolvable | undefined {
  if (!color) { return undefined; }
  const normalized = color.trim().replace(/^#/, '');
  if (!/^[\da-f]{6}$/i.test(normalized)) { return undefined; }
  return `#${normalized}`;
}

function resolveRoleColor(color: string | undefined | null): RoleColorResolution {
  const parsedColor = parseColor(color);
  return color && !parsedColor
    ? { ok: false, error: INVALID_ROLE_COLOR_ERROR }
    : { ok: true, color: parsedColor };
}

function findRole(guild: Guild, roleName: string): Role | undefined {
  const normalized = roleName.toLowerCase();
  return (
    guild.roles.cache.find(role => role.name.toLowerCase() === normalized)
    ?? guild.roles.cache.find(role =>
      role.name.toLowerCase().includes(normalized),
    )
  );
}

function normalizeUserLookup(query: string): string {
  return USER_MENTION_REGEX.exec(query.trim())?.[1] ?? query.trim();
}

async function findMember(
  guild: Guild,
  userLookup: string,
): Promise<GuildMember | undefined> {
  const lookup = normalizeUserLookup(userLookup);
  if (USER_ID_REGEX.test(lookup)) {
    return (
      (await guild.members.fetch(lookup).catch((error: unknown) => {
        toolLogger.debug(
          { userLookup, error: error instanceof Error ? error.message : String(error) },
          'Could not fetch role target member by ID',
        );
        return null;
      })) ?? undefined
    );
  }

  const lowerLookup = lookup.toLowerCase();
  const members = await guild.members.fetch({ query: lookup, limit: 10 });
  return (
    members.find(
      m =>
        m.user.username.toLowerCase() === lowerLookup
        || m.displayName.toLowerCase() === lowerLookup
        || m.user.globalName?.toLowerCase() === lowerLookup,
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

async function getRequesterRoleManager(
  guild: Guild,
): Promise<GuildMember | string> {
  const requesterId = toolContextManager.get().message?.author.id;
  if (!requesterId) {
    return 'Could not determine who requested this role change.';
  }

  const member = await guild.members.fetch(requesterId).catch((error: unknown) => {
    toolLogger.debug(
      { requesterId, error: error instanceof Error ? error.message : String(error) },
      'Could not fetch role requester member',
    );
    return null;
  });

  if (!member?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'You need Manage Roles permission to ask Ruyi to manage roles.';
  }

  return member;
}

function requesterCanManageRole(requester: GuildMember, role: Role): boolean {
  if (requester.id === requester.guild.ownerId) { return true; }
  return role.position < requester.roles.highest.position;
}

function requesterCanManageMember(
  requester: GuildMember,
  target: GuildMember,
): boolean {
  if (requester.id === requester.guild.ownerId) { return true; }
  if (requester.id === target.id) { return false; }
  return target.roles.highest.position < requester.roles.highest.position;
}

function getRequesterRoleError(
  requester: GuildMember,
  role: Role,
): string | null {
  return requesterCanManageRole(requester, role)
    ? null
    : `You cannot use Ruyi to manage the "${role.name}" role because it is above or equal to your highest role.`;
}

function getRequesterMemberError(
  requester: GuildMember,
  target: GuildMember,
): string | null {
  return requesterCanManageMember(requester, target)
    ? null
    : `You cannot use Ruyi to change roles for ${target.user.username} because their highest role is above or equal to yours, or because you are trying to change your own roles.`;
}

function resolveManageableRole(
  guild: Guild,
  requester: GuildMember,
  roleName: string,
): Role | string {
  const role = findRole(guild, roleName);
  if (!role) {
    return `Role "${roleName}" not found`;
  }

  return (
    getRoleManageabilityError(role)
    ?? getRequesterRoleError(requester, role)
    ?? role
  );
}

function getMemberRoleStateError(
  action: MemberRoleAction,
  member: GuildMember,
  role: Role,
): string | null {
  const hasRole = member.roles.cache.has(role.id);
  if (action === 'assign' && hasRole) {
    return `${member.user.username} already has the "${role.name}" role`;
  }
  if (action === 'remove' && !hasRole) {
    return `${member.user.username} doesn't have the "${role.name}" role`;
  }
  return null;
}

async function applyMemberRoleAction(
  action: MemberRoleAction,
  member: GuildMember,
  role: Role,
): Promise<void> {
  if (action === 'assign') {
    await member.roles.add(role, 'Assigned by Ruyi bot');
    return;
  }

  await member.roles.remove(role, 'Removed by Ruyi bot');
}

async function handleMemberRoleAction(
  guild: Guild,
  requester: GuildMember,
  roleName: string,
  username: string | null,
  action: MemberRoleAction,
) {
  if (!username) {
    return { error: `Username required for ${action} action` };
  }

  const role = resolveManageableRole(guild, requester, roleName);
  if (typeof role === 'string') { return { error: role }; }

  const member = await findMember(guild, username);
  if (!member) {
    return { error: `User "${username}" not found` };
  }

  const requesterMemberError = getRequesterMemberError(requester, member);
  if (requesterMemberError) { return { error: requesterMemberError }; }

  const roleStateError = getMemberRoleStateError(action, member, role);
  if (roleStateError) { return { error: roleStateError }; }

  await applyMemberRoleAction(action, member, role);
  toolLogger.info(
    { role: role.name, user: member.user.username },
    action === 'assign' ? 'Assigned role' : 'Removed role',
  );
  return {
    success: true,
    action: action === 'assign' ? 'assigned' : 'removed',
    role: { name: role.name, color: role.hexColor },
    user: member.user.username,
  };
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
  const colorResolution = resolveRoleColor(color);
  if (!colorResolution.ok) { return { error: colorResolution.error }; }
  const newRole = await guild.roles.create({
    name: roleName,
    color: colorResolution.color,
    reason: 'Created by Ruyi bot',
  });
  toolLogger.info(
    { role: newRole.name, color: newRole.hexColor },
    'Created role',
  );
  return {
    success: true,
    action: 'created',
    role: { name: newRole.name, color: newRole.hexColor, id: newRole.id },
  };
}

async function handleEditRole(
  guild: Guild,
  requester: GuildMember,
  roleName: string,
  newName: string | null,
  color: string | null,
) {
  const role = resolveManageableRole(guild, requester, roleName);
  if (typeof role === 'string') { return { error: role }; }
  if (!newName && !color) {
    return { error: 'No changes specified (provide new_name or color)' };
  }
  const colorResolution = resolveRoleColor(color);
  if (!colorResolution.ok) { return { error: colorResolution.error }; }
  await role.edit({
    name: newName ?? undefined,
    color: colorResolution.color,
    reason: 'Edited by Ruyi bot',
  });
  toolLogger.info({ role: role.name, newName, color }, 'Edited role');
  return {
    success: true,
    action: 'edited',
    role: { name: role.name, color: role.hexColor, id: role.id },
  };
}

async function handleAssignRole(
  guild: Guild,
  requester: GuildMember,
  roleName: string,
  username: string | null,
) {
  return handleMemberRoleAction(guild, requester, roleName, username, 'assign');
}

async function handleRemoveRole(
  guild: Guild,
  requester: GuildMember,
  roleName: string,
  username: string | null,
) {
  return handleMemberRoleAction(guild, requester, roleName, username, 'remove');
}

export const manageRoleTool = tool({
  name: 'manage_role',
  description:
    'Manage Discord roles: create a new role, edit an existing role\'s name/color, or assign/remove a role from a user',
  parameters: z.object({
    action: z
      .enum(['create', 'edit', 'assign', 'remove'])
      .describe(
        'Action to perform: create a new role, edit existing role, assign role to user, or remove role from user',
      ),
    role_name: z
      .string()
      .min(1)
      .describe('Name of the role to create, edit, assign, or remove'),
    new_name: z
      .string()
      .nullable()
      .describe('New name for the role (only for edit action, null otherwise)'),
    color: z
      .string()
      .nullable()
      .describe(
        'Hex color for the role e.g. \'#FF5733\' (for create/edit actions, null otherwise)',
      ),
    username: z
      .string()
      .nullable()
      .describe(
        'Username to assign/remove the role to/from (for assign/remove actions, null otherwise)',
      ),
  }),
  needsApproval: true,
  execute: async ({ action, role_name, new_name, color, username }) => {
    const { guild } = toolContextManager.get();
    if (!guild) {
      toolLogger.warn('manage_role called without guild context');
      return { error: 'Not in a server' };
    }
    const requester = await getRequesterRoleManager(guild);
    if (typeof requester === 'string') { return { error: requester }; }

    const roleName = role_name.trim();
    const newName = new_name?.trim() || null;

    if (!roleName) {
      return { error: 'Role name cannot be empty' };
    }

    toolLogger.debug(
      { action, role_name: roleName, new_name: newName, color, username },
      'Managing role',
    );

    try {
      switch (action) {
        case 'create':
          return await handleCreateRole(guild, roleName, color);
        case 'edit':
          return await handleEditRole(guild, requester, roleName, newName, color);
        case 'assign':
          return await handleAssignRole(guild, requester, roleName, username);
        case 'remove':
          return await handleRemoveRole(guild, requester, roleName, username);
        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error(
        { action, role_name: roleName, error: errorMessage },
        'Error managing role',
      );
      return { error: `Failed to ${action} role: ${errorMessage}` };
    }
  },
});
