import type {
  Client,
  TextChannel,
  NewsChannel,
  ThreadChannel,
} from "discord.js";
import { Conversation, type IConversation } from "../db/models";
import { syncLogger } from "../logger";

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

type MessageableChannel = TextChannel | NewsChannel | ThreadChannel;

function isMessageableChannel(channel: unknown): channel is MessageableChannel {
  return (
    channel !== null &&
    typeof channel === "object" &&
    "messages" in channel &&
    typeof (channel as { messages: { fetch: unknown } }).messages?.fetch ===
      "function"
  );
}

async function messageExists(
  channel: MessageableChannel,
  messageId: string,
): Promise<boolean> {
  try {
    await channel.messages.fetch(messageId);
    return true;
  } catch {
    return false;
  }
}

async function findDeletedMessages(
  channel: MessageableChannel,
  messageIds: string[],
): Promise<string[]> {
  const deleted: string[] = [];

  for (const messageId of messageIds) {
    const exists = await messageExists(channel, messageId);
    if (!exists) {
      deleted.push(messageId);
    }
  }

  return deleted;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncConversation(
  client: Client,
  conversation: IConversation,
): Promise<{ channelId: string; deleted: number; skipped: number }> {
  const channelId = conversation.channelId;
  const messagesWithIds = conversation.messages.filter((m) => m.messageId);
  const messagesWithoutIds =
    conversation.messages.length - messagesWithIds.length;

  if (messagesWithIds.length === 0) {
    if (messagesWithoutIds > 0) {
      syncLogger.debug(
        { channelId, messagesWithoutIds },
        "No messages with IDs to sync (legacy messages)",
      );
    }
    return { channelId, deleted: 0, skipped: messagesWithoutIds };
  }

  syncLogger.debug(
    {
      channelId,
      withIds: messagesWithIds.length,
      withoutIds: messagesWithoutIds,
    },
    "Syncing channel",
  );

  let channel: MessageableChannel;
  try {
    const fetchedChannel = await client.channels.fetch(channelId);
    if (!isMessageableChannel(fetchedChannel)) {
      syncLogger.debug({ channelId }, "Channel is not messageable, skipping");
      return { channelId, deleted: 0, skipped: messagesWithIds.length };
    }
    channel = fetchedChannel;
  } catch {
    syncLogger.debug({ channelId }, "Could not fetch channel, skipping");
    return { channelId, deleted: 0, skipped: messagesWithIds.length };
  }

  const messageIds = messagesWithIds.map((m) => m.messageId!);
  const deletedIds: string[] = [];

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    const deleted = await findDeletedMessages(channel, batch);
    deletedIds.push(...deleted);

    if (i + BATCH_SIZE < messageIds.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  if (deletedIds.length > 0) {
    syncLogger.info(
      { channelId, deletedIds },
      "Removing deleted messages from DB",
    );
    await Conversation.updateOne(
      { channelId },
      { $pull: { messages: { messageId: { $in: deletedIds } } } },
    );
  }

  return { channelId, deleted: deletedIds.length, skipped: messagesWithoutIds };
}

export class MessageSyncService {
  private syncInterval: ReturnType<typeof setInterval> | null = null;

  private async runSync(client: Client): Promise<void> {
    const startTime = Date.now();
    syncLogger.info("Starting message sync sweep");

    try {
      const conversations = await Conversation.find({});
      let totalDeleted = 0;
      let totalSkipped = 0;
      let channelsProcessed = 0;

      for (const conversation of conversations) {
        const result = await syncConversation(client, conversation);
        totalDeleted += result.deleted;
        totalSkipped += result.skipped;
        channelsProcessed++;

        if (channelsProcessed < conversations.length) {
          await sleep(500);
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      syncLogger.info(
        {
          channels: channelsProcessed,
          deleted: totalDeleted,
          skipped: totalSkipped,
          elapsed: `${elapsed}s`,
        },
        "Message sync sweep completed",
      );
    } catch (error) {
      syncLogger.error({ error }, "Message sync sweep failed");
    }
  }

  start(client: Client): void {
    if (this.syncInterval) {
      syncLogger.warn("Message sync already running");
      return;
    }

    syncLogger.info(
      { intervalMs: SYNC_INTERVAL_MS },
      "Starting message sync service",
    );

    this.runSync(client);
    this.syncInterval = setInterval(
      () => this.runSync(client),
      SYNC_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      syncLogger.info("Message sync service stopped");
    }
  }

  async trigger(client: Client): Promise<void> {
    await this.runSync(client);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    try {
      const result = await Conversation.updateOne(
        { channelId },
        { $pull: { messages: { messageId } } },
      );
      if (result.modifiedCount > 0) {
        syncLogger.info(
          { channelId, messageId },
          "Deleted message from DB (event)",
        );
      } else {
        syncLogger.debug(
          { channelId, messageId },
          "Message not found in DB (may be legacy or not tracked)",
        );
      }
    } catch (error) {
      syncLogger.error(
        { error, channelId, messageId },
        "Failed to delete message from DB",
      );
    }
  }
}

export const messageSyncService = new MessageSyncService();
