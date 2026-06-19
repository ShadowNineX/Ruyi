import type { ButtonInteraction, ChatInputCommandInteraction, ModalMessageModalSubmitInteraction, ModalSubmitInteraction } from 'discord.js';
import type { IMemory } from '../../db/models/memory';
import type { RuyiUserIdentity } from '../../utils/user-identity';
import {
  ActionRowBuilder,
  ButtonBuilder,

  ButtonStyle,

  EmbedBuilder,
  MessageFlags,
  ModalBuilder,

  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { Types } from 'mongoose';
import { MEMORY_VALUE_MAX_LEN, USER_MEMORY_CAP } from '../../constants';
import { Memory } from '../../db/models';
import { botLogger } from '../../logger';
import {
  MEMORY_KEY_MAX_LEN,
  sanitizeMemoryKey,
  truncateMemoryValue,
} from '../../utils/memory-normalization';
import { buildUserMemoryFilter } from '../../utils/memory-scope';
import {
  buildDiscordUserIdentity,

} from '../../utils/user-identity';

const MEMORY_COLORS = {
  success: 0x2ECC71,
  neutral: 0x5865F2,
  warning: 0xFFAA00,
  error: 0xCC3333,
} as const;

const INVALID_MEMORY_KEY_MESSAGE
  = 'Key must contain at least one alphanumeric character.';
const EMPTY_MEMORY_VALUE_MESSAGE = 'Memory value cannot be empty.';
const MEMORY_PAGE_SIZE = 5;
const MEMORY_COMPONENT_PREFIX = 'memories:v1';
const MEMORY_MODAL_KEY_INPUT_ID = 'memory_key';
const MEMORY_MODAL_VALUE_INPUT_ID = 'memory_value';
const MEMORY_MODAL_PIN_INPUT_ID = 'memory_pin';

type MemoryComponentAction = 'page' | 'delete' | 'add';

interface MemoryComponentState {
  action: MemoryComponentAction;
  ownerUserId: string;
  page: number;
  memoryId?: string;
}

interface MemorySaveResult {
  saved: boolean;
  evictedKey: string | null;
  blockedByPinnedCap: boolean;
}

interface MemoryPanelPayload {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

export const memoriesCommand = new SlashCommandBuilder()
  .setName('memories')
  .setDescription('Manage what Ruyi remembers about you')
  .addSubcommand(sub =>
    sub
      .setName('remember')
      .setDescription('Save a fact about yourself')
      .addStringOption(opt =>
        opt
          .setName('key')
          .setDescription('Short identifier (e.g. \'favorite_color\')')
          .setRequired(true)
          .setMaxLength(MEMORY_KEY_MAX_LEN),
      )
      .addStringOption(opt =>
        opt
          .setName('value')
          .setDescription('The fact to remember')
          .setRequired(true)
          .setMaxLength(MEMORY_VALUE_MAX_LEN),
      )
      .addBooleanOption(opt =>
        opt
          .setName('pin')
          .setDescription('Pin so Ruyi always sees it (default: false)')
          .setRequired(false),
      ),
  )
  .addSubcommand(sub =>
    sub
      .setName('forget')
      .setDescription('Delete a stored memory')
      .addStringOption(opt =>
        opt
          .setName('key')
          .setDescription('The memory key to forget')
          .setRequired(true),
      ),
  )
  .addSubcommand(sub =>
    sub
      .setName('list')
      .setDescription('List everything Ruyi remembers about you')
      .addIntegerOption(opt =>
        opt
          .setName('page')
          .setDescription('Page number to open')
          .setMinValue(1)
          .setRequired(false),
      ),
  )
  .addSubcommand(sub =>
    sub
      .setName('pin')
      .setDescription('Pin an existing memory (always loaded into context)')
      .addStringOption(opt =>
        opt
          .setName('key')
          .setDescription('The memory key to pin')
          .setRequired(true),
      ),
  )
  .addSubcommand(sub =>
    sub
      .setName('unpin')
      .setDescription('Unpin an existing memory')
      .addStringOption(opt =>
        opt
          .setName('key')
          .setDescription('The memory key to unpin')
          .setRequired(true),
      ),
  );

function buildMemoryEmbed(
  title: string,
  description: string,
  color: number,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

function buildIdentityForInteraction(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction,
): RuyiUserIdentity {
  return buildDiscordUserIdentity(
    interaction.user.id,
    interaction.user.username,
  );
}

function clampPage(page: number, pageCount: number): number {
  if (page < 0) { return 0; }
  if (page >= pageCount) { return pageCount - 1; }
  return page;
}

function parsePage(value: string | null | undefined): number {
  if (!value) { return 0; }
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 0;
}

function parseDisplayedPage(value: number | null): number {
  if (!value) { return 0; }
  return Math.max(0, value - 1);
}

function buildMemoryComponentId(state: MemoryComponentState): string {
  return [
    MEMORY_COMPONENT_PREFIX,
    state.action,
    state.ownerUserId,
    String(state.page),
    state.memoryId,
  ]
    .filter(Boolean)
    .join(':');
}

function buildMemoryModalId(ownerUserId: string, page: number): string {
  return [MEMORY_COMPONENT_PREFIX, 'submit', ownerUserId, String(page)].join(
    ':',
  );
}

function parseMemoryComponentId(
  customId: string,
): MemoryComponentState | null {
  const [prefix, version, action, ownerUserId, pageValue, memoryId]
    = customId.split(':');
  if (prefix !== 'memories' || version !== 'v1') { return null; }
  if (action !== 'page' && action !== 'delete' && action !== 'add') { return null; }
  if (!ownerUserId) { return null; }

  return {
    action,
    ownerUserId,
    page: parsePage(pageValue),
    memoryId,
  };
}

function parseMemoryModalId(
  customId: string,
): Pick<MemoryComponentState, 'ownerUserId' | 'page'> | null {
  const [prefix, version, action, ownerUserId, pageValue] = customId.split(':');
  if (prefix !== 'memories' || version !== 'v1' || action !== 'submit') {
    return null;
  }
  if (!ownerUserId) { return null; }
  return { ownerUserId, page: parsePage(pageValue) };
}

function memoryBelongsToInteractionUser(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ownerUserId: string,
): boolean {
  return interaction.user.id === ownerUserId;
}

function buildPrivateMismatchEmbed(): EmbedBuilder {
  return buildMemoryEmbed(
    'Private Memory Panel',
    'That memory panel belongs to another user. Please use `/memories list` to open your own private panel.',
    MEMORY_COLORS.warning,
  );
}

function formatMemoryEntry(memory: IMemory, index: number): string {
  const marker = memory.pinned ? '[PINNED] ' : '';
  const sourceTag = memory.source === 'auto' ? ' _(auto)_' : '';
  return [
    `**${index + 1}.** ${marker}\`${memory.key}\`${sourceTag}`,
    truncateMemoryValue(memory.value, 420),
  ].join('\n');
}

function buildMemoryDeleteButton(
  memory: IMemory,
  ownerUserId: string,
  page: number,
  index: number,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(
      buildMemoryComponentId({
        action: 'delete',
        ownerUserId,
        page,
        memoryId: memory._id instanceof Types.ObjectId
          ? memory._id.toHexString()
          : String(memory._id),
      }),
    )
    .setLabel(`Delete ${index + 1}`)
    .setStyle(ButtonStyle.Danger);
}

function buildMemoryNavigationRow(
  ownerUserId: string,
  page: number,
  pageCount: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildMemoryComponentId({ action: 'add', ownerUserId, page }),
      )
      .setLabel('Add memory')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(
        buildMemoryComponentId({
          action: 'page',
          ownerUserId,
          page: Math.max(0, page - 1),
        }),
      )
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(
        buildMemoryComponentId({
          action: 'page',
          ownerUserId,
          page: Math.min(pageCount - 1, page + 1),
        }),
      )
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1),
  );
}

function buildMemoryDeleteRows(
  memories: IMemory[],
  ownerUserId: string,
  page: number,
): ActionRowBuilder<ButtonBuilder>[] {
  if (memories.length === 0) { return []; }
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      memories.map((memory, index) =>
        buildMemoryDeleteButton(memory, ownerUserId, page, index),
      ),
    ),
  ];
}

function buildAddMemoryModal(ownerUserId: string, page: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(buildMemoryModalId(ownerUserId, page))
    .setTitle('Add Memory')
    .addLabelComponents(
      label =>
        label.setLabel('Key').setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(MEMORY_MODAL_KEY_INPUT_ID)
            .setPlaceholder('favorite_color')
            .setRequired(true)
            .setMaxLength(MEMORY_KEY_MAX_LEN)
            .setStyle(TextInputStyle.Short),
        ),
      label =>
        label.setLabel('Memory').setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(MEMORY_MODAL_VALUE_INPUT_ID)
            .setPlaceholder('The fact Ruyi should remember')
            .setRequired(true)
            .setMaxLength(MEMORY_VALUE_MAX_LEN)
            .setStyle(TextInputStyle.Paragraph),
        ),
      label =>
        label
          .setLabel('Pin?')
          .setDescription('Optional: enter yes or no')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId(MEMORY_MODAL_PIN_INPUT_ID)
              .setPlaceholder('no')
              .setRequired(false)
              .setMaxLength(5)
              .setStyle(TextInputStyle.Short),
          ),
    );
}

function parsePinnedInput(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'pin'].includes(normalized);
}

function buildMemoryPanelEmbed(args: {
  identity: RuyiUserIdentity;
  memories: IMemory[];
  page: number;
  pageCount: number;
  total: number;
  notice?: string;
}): EmbedBuilder {
  const description
    = args.memories.length > 0
      ? args.memories
          .map((memory, index) =>
            formatMemoryEntry(memory, args.page * MEMORY_PAGE_SIZE + index),
          )
          .join('\n\n')
      : 'No memories yet. Use **Add memory** to create one privately.';

  const embed = buildMemoryEmbed(
    `Memories About ${args.identity.username}`,
    description,
    MEMORY_COLORS.neutral,
  ).setFooter({
    text: `Page ${args.page + 1}/${args.pageCount} • ${args.total}/${USER_MEMORY_CAP} used • Private to you`,
  });

  if (args.notice) {
    embed.addFields({ name: 'Updated', value: args.notice });
  }

  return embed;
}

async function buildMemoryPanelPayload(
  identity: RuyiUserIdentity,
  ownerUserId: string,
  requestedPage: number,
  notice?: string,
): Promise<MemoryPanelPayload> {
  const filter = buildUserMemoryFilter(identity);
  const total = await Memory.countDocuments(filter);
  const pageCount = Math.max(1, Math.ceil(total / MEMORY_PAGE_SIZE));
  const page = clampPage(requestedPage, pageCount);
  const memories = await Memory.find(filter)
    .sort({ pinned: -1, updatedAt: -1 })
    .skip(page * MEMORY_PAGE_SIZE)
    .limit(MEMORY_PAGE_SIZE);

  return {
    embeds: [
      buildMemoryPanelEmbed({
        identity,
        memories,
        page,
        pageCount,
        total,
        notice,
      }),
    ],
    components: [
      buildMemoryNavigationRow(ownerUserId, page, pageCount),
      ...buildMemoryDeleteRows(memories, ownerUserId, page),
    ],
  };
}

async function saveMemoryForIdentity(
  identity: RuyiUserIdentity,
  key: string,
  value: string,
  pinned: boolean,
): Promise<MemorySaveResult> {
  const userFilter = buildUserMemoryFilter(identity);
  const existing = await Memory.exists({ key, ...userFilter });
  let evictedKey: string | null = null;

  if (!existing) {
    const count = await Memory.countDocuments(userFilter);
    if (count >= USER_MEMORY_CAP) {
      const oldest = await Memory.findOne({
        ...userFilter,
        pinned: false,
      }).sort({ updatedAt: 1 });
      if (!oldest) {
        return { saved: false, evictedKey: null, blockedByPinnedCap: true };
      }
      evictedKey = oldest.key;
      await oldest.deleteOne();
    }
  }

  await Memory.updateOne(
    { key, ...userFilter },
    {
      $set: {
        ...userFilter,
        key,
        value,
        username: identity.username,
        createdBy: identity.username,
        source: 'user',
        pinned,
      },
    },
    { upsert: true },
  );

  return { saved: true, evictedKey, blockedByPinnedCap: false };
}

async function replyWithMemoryEmbed(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string,
  color: number,
): Promise<void> {
  await interaction.reply({
    embeds: [buildMemoryEmbed(title, description, color)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function getMemoryKeyOrReply(
  interaction: ChatInputCommandInteraction,
  errorTitle: string,
): Promise<string | null> {
  const key = sanitizeMemoryKey(interaction.options.getString('key', true));
  if (key) { return key; }

  await replyWithMemoryEmbed(
    interaction,
    errorTitle,
    INVALID_MEMORY_KEY_MESSAGE,
    MEMORY_COLORS.error,
  );
  return null;
}

async function handleRemember(
  interaction: ChatInputCommandInteraction,
  identity: RuyiUserIdentity,
): Promise<void> {
  const key = await getMemoryKeyOrReply(interaction, 'Memory Not Saved');
  if (!key) { return; }

  const value = truncateMemoryValue(
    interaction.options.getString('value', true).trim(),
  );
  if (!value) {
    await replyWithMemoryEmbed(
      interaction,
      'Memory Not Saved',
      EMPTY_MEMORY_VALUE_MESSAGE,
      MEMORY_COLORS.error,
    );
    return;
  }

  const pinned = interaction.options.getBoolean('pin') ?? false;
  const result = await saveMemoryForIdentity(identity, key, value, pinned);

  if (!result.saved) {
    await replyWithMemoryEmbed(
      interaction,
      'Memory Limit Reached',
      'All saved memories are pinned. Unpin or delete one before adding another.',
      MEMORY_COLORS.warning,
    );
    return;
  }

  const evictedLine = result.evictedKey
    ? `\n\nEvicted oldest unpinned memory: \`${result.evictedKey}\`.`
    : '';

  await replyWithMemoryEmbed(
    interaction,
    pinned ? 'Memory Saved And Pinned' : 'Memory Saved',
    `\`${key}\`\n${value}\n\nStored for your linked Ruyi memory.${evictedLine}`,
    pinned ? MEMORY_COLORS.success : MEMORY_COLORS.neutral,
  );
}

async function handleForget(
  interaction: ChatInputCommandInteraction,
  identity: RuyiUserIdentity,
): Promise<void> {
  const key = await getMemoryKeyOrReply(interaction, 'Memory Not Found');
  if (!key) { return; }

  const result = await Memory.deleteOne({
    key,
    ...buildUserMemoryFilter(identity),
  });
  await replyWithMemoryEmbed(
    interaction,
    result.deletedCount > 0 ? 'Memory Forgotten' : 'Memory Not Found',
    result.deletedCount > 0
      ? `Forgot \`${key}\`.`
      : `No memory found for \`${key}\`.`,
    result.deletedCount > 0 ? MEMORY_COLORS.success : MEMORY_COLORS.warning,
  );
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  identity: RuyiUserIdentity,
): Promise<void> {
  const page = parseDisplayedPage(interaction.options.getInteger('page'));
  const payload = await buildMemoryPanelPayload(
    identity,
    interaction.user.id,
    page,
  );

  await interaction.reply({
    ...payload,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handlePinToggle(
  interaction: ChatInputCommandInteraction,
  identity: RuyiUserIdentity,
  pinned: boolean,
): Promise<void> {
  const key = await getMemoryKeyOrReply(interaction, 'Memory Not Found');
  if (!key) { return; }

  const result = await Memory.updateOne(
    { key, ...buildUserMemoryFilter(identity) },
    { $set: { pinned } },
  );
  const verb = pinned ? 'Pinned' : 'Unpinned';
  await replyWithMemoryEmbed(
    interaction,
    result.matchedCount > 0 ? `Memory ${verb}` : 'Memory Not Found',
    result.matchedCount > 0
      ? `${verb} \`${key}\`.`
      : `No memory found for \`${key}\`.`,
    result.matchedCount > 0 ? MEMORY_COLORS.success : MEMORY_COLORS.warning,
  );
}

async function replyToForeignMemoryPanel(
  interaction: ButtonInteraction | ModalSubmitInteraction,
): Promise<void> {
  await interaction.reply({
    embeds: [buildPrivateMismatchEmbed()],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function updateMemoryPanel(
  interaction: ButtonInteraction | ModalMessageModalSubmitInteraction,
  identity: RuyiUserIdentity,
  ownerUserId: string,
  page: number,
  notice?: string,
): Promise<void> {
  const payload = await buildMemoryPanelPayload(
    identity,
    ownerUserId,
    page,
    notice,
  );

  await interaction.update({
    ...payload,
    allowedMentions: { parse: [] },
  });
}

async function handleMemoryPageButton(
  interaction: ButtonInteraction,
  state: MemoryComponentState,
): Promise<void> {
  const identity = buildIdentityForInteraction(interaction);
  await updateMemoryPanel(interaction, identity, state.ownerUserId, state.page);
}

async function handleMemoryDeleteButton(
  interaction: ButtonInteraction,
  state: MemoryComponentState,
): Promise<void> {
  const identity = buildIdentityForInteraction(interaction);
  const filter = buildUserMemoryFilter(identity);
  let notice = 'That memory was not found in your private memories.';

  if (state.memoryId && Types.ObjectId.isValid(state.memoryId)) {
    const deleted = await Memory.findOneAndDelete({
      _id: state.memoryId,
      ...filter,
    });
    if (deleted) {
      notice = `Deleted \`${deleted.key}\`.`;
      botLogger.info(
        {
          user: interaction.user.username,
          memoryKey: deleted.key,
          personId: identity.personId,
        },
        'Memory deleted from private panel',
      );
    }
  }

  await updateMemoryPanel(
    interaction,
    identity,
    state.ownerUserId,
    state.page,
    notice,
  );
}

async function handleMemoryAddButton(
  interaction: ButtonInteraction,
  state: MemoryComponentState,
): Promise<void> {
  await interaction.showModal(
    buildAddMemoryModal(state.ownerUserId, state.page),
  );
}

export async function handleMemoriesButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const state = parseMemoryComponentId(interaction.customId);
  if (!state) { return; }

  if (!memoryBelongsToInteractionUser(interaction, state.ownerUserId)) {
    await replyToForeignMemoryPanel(interaction);
    return;
  }

  try {
    if (state.action === 'page') {
      await handleMemoryPageButton(interaction, state);
      return;
    }
    if (state.action === 'delete') {
      await handleMemoryDeleteButton(interaction, state);
      return;
    }
    await handleMemoryAddButton(interaction, state);
  } catch (error) {
    botLogger.error(
      {
        error: (error as Error).message,
        stack: (error as Error).stack,
        user: interaction.user.username,
        customId: interaction.customId,
      },
      'Memory button failed',
    );

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [
          buildMemoryEmbed(
            'Memory Action Failed',
            'Something went wrong handling that memory action.',
            MEMORY_COLORS.error,
          ),
        ],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  }
}

function getModalText(
  interaction: ModalSubmitInteraction,
  fieldId: string,
): string {
  return interaction.fields.getTextInputValue(fieldId).trim();
}

function buildMemoryModalNotice(
  key: string,
  result: MemorySaveResult,
): string {
  if (!result.saved) {
    return 'All saved memories are pinned. Unpin or delete one before adding another.';
  }

  let notice = `Saved \`${key}\`.`;
  if (result.evictedKey) {
    notice += ` Evicted \`${result.evictedKey}\`.`;
  }
  return notice;
}

function getMemoryInputError(key: string, value: string): string | null {
  if (key && value) { return null; }
  return key ? EMPTY_MEMORY_VALUE_MESSAGE : INVALID_MEMORY_KEY_MESSAGE;
}

async function handleValidMemoryModalSubmit(
  interaction: ModalSubmitInteraction,
  ownerUserId: string,
  page: number,
  key: string,
  value: string,
  pinned: boolean,
): Promise<void> {
  const identity = buildIdentityForInteraction(interaction);
  const result = await saveMemoryForIdentity(identity, key, value, pinned);
  const notice = buildMemoryModalNotice(key, result);

  if (interaction.isFromMessage()) {
    await updateMemoryPanel(interaction, identity, ownerUserId, page, notice);
    return;
  }

  await interaction.reply({
    embeds: [
      buildMemoryEmbed(
        result.saved ? 'Memory Saved' : 'Memory Limit Reached',
        notice,
        result.saved ? MEMORY_COLORS.success : MEMORY_COLORS.warning,
      ),
    ],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export async function handleMemoriesModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const state = parseMemoryModalId(interaction.customId);
  if (!state) { return; }

  if (!memoryBelongsToInteractionUser(interaction, state.ownerUserId)) {
    await replyToForeignMemoryPanel(interaction);
    return;
  }

  const key = sanitizeMemoryKey(
    getModalText(interaction, MEMORY_MODAL_KEY_INPUT_ID),
  );
  const value = truncateMemoryValue(
    getModalText(interaction, MEMORY_MODAL_VALUE_INPUT_ID),
  );
  const pinned = parsePinnedInput(
    getModalText(interaction, MEMORY_MODAL_PIN_INPUT_ID),
  );
  const inputError = getMemoryInputError(key, value);

  if (inputError) {
    await interaction.reply({
      embeds: [
        buildMemoryEmbed(
          'Memory Not Saved',
          inputError,
          MEMORY_COLORS.error,
        ),
      ],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  try {
    await handleValidMemoryModalSubmit(
      interaction,
      state.ownerUserId,
      state.page,
      key,
      value,
      pinned,
    );
  } catch (error) {
    botLogger.error(
      {
        error: (error as Error).message,
        stack: (error as Error).stack,
        user: interaction.user.username,
        customId: interaction.customId,
      },
      'Memory modal failed',
    );

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [
          buildMemoryEmbed(
            'Memory Not Saved',
            'Something went wrong saving that memory.',
            MEMORY_COLORS.error,
          ),
        ],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  }
}

export function isMemoriesButton(customId: string): boolean {
  return parseMemoryComponentId(customId) !== null;
}

export function isMemoriesModal(customId: string): boolean {
  return parseMemoryModalId(customId) !== null;
}

export async function handleMemoriesCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const username = interaction.user.username;
  const identity = buildIdentityForInteraction(interaction);
  const sub = interaction.options.getSubcommand();

  botLogger.info({ user: username, sub }, '/memories invoked');

  try {
    switch (sub) {
      case 'remember':
        await handleRemember(interaction, identity);
        break;
      case 'forget':
        await handleForget(interaction, identity);
        break;
      case 'list':
        await handleList(interaction, identity);
        break;
      case 'pin':
        await handlePinToggle(interaction, identity, true);
        break;
      case 'unpin':
        await handlePinToggle(interaction, identity, false);
        break;
    }
  } catch (error) {
    botLogger.error(
      { error: (error as Error).message, sub, user: username },
      '/memories failed',
    );
    if (!interaction.replied) {
      await replyWithMemoryEmbed(
        interaction,
        'Memory Command Failed',
        'Something went wrong handling that.',
        MEMORY_COLORS.error,
      );
    }
  }
}
