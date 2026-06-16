import type {
  Client,
  TextChannel,
  NewsChannel,
  ThreadChannel,
} from "discord.js";
import { AgentSession, Conversation, type IConversation } from "../db/models";
import { sessionManager } from "../ai/session";
import { syncLogger } from "../logger";
import {
  getMessageSyncInterval,
  isMessageSyncRunning,
  setMessageSyncInterval,
  setMessageSyncRunning,
} from "../stores";

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

type MessageableChannel = TextChannel | NewsChannel | ThreadChannel;
type MessagePresence = "exists" | "deleted" | "unknown";
type SyncResult = { channelId: string; deleted: number; skipped: number };
type SyncConversation = Pick<IConversation, "channelId" | "messages">;
type SyncAgentSession = {
  channelId: string;
  userMessageIds: string[];
  assistantMessageIds: string[];
};
type ChannelResolutionResult =
  | { ok: true; channel: MessageableChannel }
  | { ok: false; result: SyncResult };

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
): Promise<MessagePresence> {
  try {
    await channel.messages.fetch(messageId);
    return "exists";
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 10008) return "deleted";

    syncLogger.debug(
      {
        error: (error as Error).message,
        code,
        channelId: channel.id,
        messageId,
      },
      "Could not verify message during sync",
    );
    return "unknown";
  }
}

async function findDeletedMessages(
  channel: MessageableChannel,
  messageIds: string[],
): Promise<{ deletedIds: string[]; skipped: number }> {
  const deleted: string[] = [];
  let skipped = 0;

  for (const messageId of messageIds) {
    const presence = await messageExists(channel, messageId);
    if (presence === "deleted") {
      deleted.push(messageId);
    } else if (presence === "unknown") {
      skipped += 1;
    }
  }

  return { deletedIds: deleted, skipped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMessageIds(messageIds: string[]): string[] {
  return [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))];
}

async function fetchMessageableChannel(
  client: Client,
  channelId: string,
  skippedMessageCount: number,
  fetchErrorMessage: string,
): Promise<ChannelResolutionResult> {
  try {
    const fetchedChannel = await client.channels.fetch(channelId);
    if (!isMessageableChannel(fetchedChannel)) {
      syncLogger.debug({ channelId }, "Channel is not messageable, skipping");
      return {
        ok: false,
        result: { channelId, deleted: 0, skipped: skippedMessageCount },
      };
    }
    return { ok: true, channel: fetchedChannel };
  } catch (error) {
    syncLogger.debug(
      { channelId, error: (error as Error).message },
      fetchErrorMessage,
    );
    return {
      ok: false,
      result: { channelId, deleted: 0, skipped: skippedMessageCount },
    };
  }
}

async function findDeletedMessagesInBatches(
  channel: MessageableChannel,
  messageIds: string[],
): Promise<{ deletedIds: string[]; skipped: number }> {
  const deletedIds: string[] = [];
  let skippedFetches = 0;

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    const { deletedIds: deleted, skipped } = await findDeletedMessages(
      channel,
      batch,
    );
    deletedIds.push(...deleted);
    skippedFetches += skipped;

    if (i + BATCH_SIZE < messageIds.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return { deletedIds, skipped: skippedFetches };
}

async function removeDeletedMessageReferences(
  channelId: string,
  messageIds: string[],
): Promise<{ conversationModified: boolean; sessionInvalidated: boolean }> {
  const normalizedIds = normalizeMessageIds(messageIds);
  if (normalizedIds.length === 0) {
    return { conversationModified: false, sessionInvalidated: false };
  }

  const result = await Conversation.updateOne(
    { channelId },
    { $pull: { messages: { messageId: { $in: normalizedIds } } } },
  );
  const conversationModified = result.modifiedCount > 0;
  const sessionInvalidated =
    await sessionManager.invalidateIfTrackedMessagesDeleted(
      channelId,
      normalizedIds,
    );

  if (conversationModified && !sessionInvalidated) {
    await sessionManager.invalidate(channelId);
  }

  return { conversationModified, sessionInvalidated };
}

async function syncConversation(
  client: Client,
  conversation: SyncConversation,
): Promise<SyncResult> {
  const channelId = conversation.channelId;
  const messageIds = normalizeMessageIds(
    conversation.messages.map((message) => message.messageId),
  );

  if (messageIds.length === 0) {
    return { channelId, deleted: 0, skipped: 0 };
  }

  syncLogger.debug(
    {
      channelId,
      messageCount: messageIds.length,
    },
    "Syncing channel",
  );

  const channelResolution = await fetchMessageableChannel(
    client,
    channelId,
    messageIds.length,
    "Could not fetch channel, skipping",
  );
  if (!channelResolution.ok) {
    return channelResolution.result;
  }
  const { deletedIds, skipped } = await findDeletedMessagesInBatches(
    channelResolution.channel,
    messageIds,
  );

  if (deletedIds.length > 0) {
    syncLogger.info(
      { channelId, deletedIds },
      "Removing deleted messages from DB",
    );
    await removeDeletedMessageReferences(channelId, deletedIds);
    syncLogger.info(
      { channelId },
      "Invalidated agent session after archived Discord messages were deleted",
    );
  }

  return {
    channelId,
    deleted: deletedIds.length,
    skipped,
  };
}

async function syncAgentSessionMessages(
  client: Client,
  session: SyncAgentSession,
): Promise<SyncResult> {
  const channelId = session.channelId;
  const messageIds = normalizeMessageIds([
    ...session.assistantMessageIds,
    ...session.userMessageIds,
  ]);
  if (messageIds.length === 0) {
    return { channelId, deleted: 0, skipped: 0 };
  }

  const channelResolution = await fetchMessageableChannel(
    client,
    channelId,
    messageIds.length,
    "Could not fetch channel for agent session message sync, skipping",
  );
  if (!channelResolution.ok) {
    return channelResolution.result;
  }
  const { deletedIds, skipped } = await findDeletedMessagesInBatches(
    channelResolution.channel,
    messageIds,
  );

  if (deletedIds.length > 0) {
    await sessionManager.invalidateIfTrackedMessagesDeleted(
      channelId,
      deletedIds,
    );
  }

  return { channelId, deleted: deletedIds.length, skipped };
}

class MessageSyncService {
  private async runSync(client: Client): Promise<void> {
    if (isMessageSyncRunning()) {
      syncLogger.warn("Message sync already in progress; skipping sweep");
      return;
    }

    setMessageSyncRunning(true);
    const startTime = Date.now();
    syncLogger.info("Starting message sync sweep");

    try {
      const conversations = await Conversation.find(
        {},
        { channelId: 1, "messages.messageId": 1 },
      ).lean<SyncConversation[]>();
      const agentSessions = await AgentSession.find(
        {
          isActive: true,
          provider: "openai-agents",
          $or: [
            { assistantMessageIds: { $exists: true, $ne: [] } },
            { userMessageIds: { $exists: true, $ne: [] } },
          ],
        },
        { channelId: 1, assistantMessageIds: 1, userMessageIds: 1, _id: 0 },
      ).lean<SyncAgentSession[]>();
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

      for (const session of agentSessions) {
        const result = await syncAgentSessionMessages(client, session);
        totalDeleted += result.deleted;
        totalSkipped += result.skipped;
        channelsProcessed++;

        if (channelsProcessed < conversations.length + agentSessions.length) {
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
    } finally {
      setMessageSyncRunning(false);
    }
  }

  start(client: Client): void {
    if (getMessageSyncInterval()) {
      syncLogger.warn("Message sync already running");
      return;
    }

    syncLogger.info(
      { intervalMs: SYNC_INTERVAL_MS },
      "Starting message sync service",
    );

    void this.runSync(client);
    const syncInterval = setInterval(
      () => this.runSync(client),
      SYNC_INTERVAL_MS,
    );
    setMessageSyncInterval(syncInterval);
  }

  stop(): void {
    const syncInterval = getMessageSyncInterval();
    if (syncInterval) {
      clearInterval(syncInterval);
      setMessageSyncInterval(null);
      syncLogger.info("Message sync service stopped");
    }
  }

  async trigger(client: Client): Promise<void> {
    await this.runSync(client);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.deleteMessages(channelId, [messageId]);
  }

  async deleteMessages(channelId: string, messageIds: string[]): Promise<void> {
    const normalizedIds = normalizeMessageIds(messageIds);
    if (normalizedIds.length === 0) return;

    try {
      const { conversationModified, sessionInvalidated } =
        await removeDeletedMessageReferences(channelId, normalizedIds);

      if (conversationModified) {
        syncLogger.info(
          { channelId, messageIds: normalizedIds },
          "Deleted archived Discord message and invalidated agent session",
        );
      } else if (sessionInvalidated) {
        syncLogger.info(
          { channelId, messageIds: normalizedIds },
          "Deleted tracked agent session message and invalidated agent session",
        );
      } else {
        syncLogger.debug(
          { channelId, messageIds: normalizedIds },
          "Message not found in tracked DB state",
        );
      }
    } catch (error) {
      syncLogger.error(
        { error, channelId, messageIds: normalizedIds },
        "Failed to delete message from DB",
      );
    }
  }
}

export const messageSyncService = new MessageSyncService();
