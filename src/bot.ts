import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type Interaction,
  type Message,
  type GuildTextBasedChannel,
  type TextChannel,
} from "discord.js";
import { chatService, replyClassifier, conversationContext } from "./ai";
import { runWithToolContext, type ToolContext } from "./utils/types";
import { env } from "./env";
import { selfRespondingToolNames } from "./tools";
import { botLogger } from "./logger";
import { handleCommands } from "./commands";
import {
  slashCommands,
  handleSlashCommand,
  handleSmitherySelect,
  handleSmitheryCodeButton,
  handleSmitheryModal,
} from "./slashCommands";
import { ChatSession } from "./utils/chatSession";
import {
  fetchReplyChain,
  fetchChatHistory,
  fetchReferencedMessage,
  sendReplyChunks,
  getErrorMessage,
} from "./utils/messages";
import { messageSyncService } from "./services/messageSync";

interface ResponseGate {
  isMentioned: boolean;
  isDM: boolean;
  isReplyToBot: boolean;
}

export class RuyiBot {
  readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  // ---- Presence helpers ----------------------------------------------------

  private setDefaultPresence() {
    this.client.user?.setPresence({
      activities: [{ name: "Serving...", type: ActivityType.Watching }],
    });
  }

  private setTypingStatus(username: string) {
    this.client.user?.setActivity(`Assisting ${username}...`, {
      type: ActivityType.Custom,
      state: `Assisting ${username}...`,
    });
  }

  // ---- Reply gating --------------------------------------------------------

  private async computeResponseGate(message: Message): Promise<ResponseGate> {
    const botUser = this.client.user;
    const isMentioned = botUser ? message.mentions.has(botUser) : false;
    const isDM = message.channel.isDMBased();

    let isReplyToBot = false;
    if (botUser && message.reference?.messageId) {
      isReplyToBot = await message.channel.messages
        .fetch(message.reference.messageId)
        .then((msg) => msg.author.id === botUser.id)
        .catch((error: unknown) => {
          botLogger.debug(
            {
              error: (error as Error)?.message,
              referencedMessageId: message.reference?.messageId,
              channelId: message.channel.id,
            },
            "Could not fetch referenced message for reply-to-bot check",
          );
          return false;
        });
    }

    return { isMentioned, isDM, isReplyToBot };
  }

  private async shouldBotRespond(
    message: Message,
    gate: ResponseGate,
  ): Promise<boolean> {
    const username = message.author.username;
    const channelName = "name" in message.channel ? message.channel.name : "DM";

    if (gate.isMentioned || gate.isDM || gate.isReplyToBot) {
      botLogger.info(
        { user: username, channel: channelName, ...gate },
        "Replying to mention/DM/reply",
      );
      return true;
    }

    try {
      const shouldRespond = await replyClassifier.shouldReply(
        message.content.trim(),
        this.client.user?.username ?? "Bot",
        message.channel.id,
      );
      botLogger.debug(
        {
          user: username,
          channel: channelName,
          decision: shouldRespond ? "reply" : "skip",
        },
        "Reply classifier decision",
      );
      return shouldRespond;
    } catch (error) {
      botLogger.error(
        { error: (error as Error)?.message, user: username },
        "Reply classifier failed; skipping",
      );
      return false;
    }
  }

  // ---- Chat handling -------------------------------------------------------

  private async buildToolContext(message: Message): Promise<ToolContext> {
    const referencedMessage = await fetchReferencedMessage(message);
    const channel: TextChannel | null =
      "name" in message.channel && "messages" in message.channel
        ? (message.channel as TextChannel)
        : null;

    return {
      message,
      channel,
      guild: message.guild,
      referencedMessage,
    };
  }

  private async runChat(
    message: Message,
    session: ChatSession,
    toolCtx: ToolContext,
  ): Promise<void> {
    const username = message.author.username;
    const guildChannel = message.channel as GuildTextBasedChannel;

    const [replyChain, chatHistory] = await Promise.all([
      fetchReplyChain(message),
      fetchChatHistory(message),
    ]);
    const combinedHistory = [...replyChain, ...chatHistory];

    botLogger.debug(
      {
        replyChainLength: replyChain.length,
        historyCount: chatHistory.length,
      },
      "Fetched message context",
    );

    await session.sendStatusEmbed(message);

    const reply = await runWithToolContext(toolCtx, () =>
      chatService.chat({
        userMessage: message.content.trim(),
        username,
        channelId: message.channel.id,
        channel: guildChannel,
        userId: message.author.id,
        session,
        chatHistory: combinedHistory,
        messageId: message.id,
      }),
    );

    await session.deleteStatusEmbed();

    if (reply) {
      const sentChunks = await sendReplyChunks(message, reply, username);
      // Store the full assembled reply once, anchored to the first chunk's
      // message ID, instead of writing one DB row per Discord chunk. The
      // persistent CopilotSession already retains the full reply server-side;
      // the DB copy exists for the auto-extractor and for restart fallback.
      const anchorId = sentChunks[0]?.id;
      if (anchorId) {
        conversationContext.rememberMessage(
          message.channel.id,
          "Ruyi",
          reply,
          true,
          anchorId,
        );
      }
      return;
    }

    if (!session.usedSelfRespondingTool(selfRespondingToolNames)) {
      botLogger.warn(
        {
          user: username,
          channelId: message.channel.id,
          messageId: message.id,
        },
        "Chat returned empty reply and no self-responding tool was used",
      );
      try {
        await message.reply(
          "Forgive me, my lord — your humble servant could not produce a reply this time. Please try again in a moment.",
        );
      } catch (replyError) {
        botLogger.error(
          {
            error: (replyError as Error).message,
            channelId: message.channel.id,
          },
          "Failed to send empty-reply notice",
        );
      }
    }
  }

  private async handleAIChat(message: Message): Promise<void> {
    const gate = await this.computeResponseGate(message);
    if (!(await this.shouldBotRespond(message, gate))) return;

    const session = new ChatSession(message.channel);
    session.startTyping();
    this.setTypingStatus(message.author.displayName);

    const toolCtx = await this.buildToolContext(message);

    try {
      await this.runChat(message, session, toolCtx);
    } catch (error) {
      const err = error as {
        status?: number;
        code?: number;
        error?: { message?: string };
        message?: string;
        stack?: string;
        name?: string;
      };
      botLogger.error(
        {
          status: err?.status ?? err?.code,
          name: err?.name,
          error: err?.error?.message ?? err?.message,
          stack: err?.stack,
          user: message.author.username,
          channelId: message.channel.id,
          messageId: message.id,
        },
        "Failed to generate reply",
      );
      await session.deleteStatusEmbed();
      try {
        await message.reply(getErrorMessage(error));
      } catch (replyError) {
        botLogger.error(
          {
            error: (replyError as Error).message,
            channelId: message.channel.id,
          },
          "Failed to send error reply to user",
        );
      }
    } finally {
      session.cleanup();
      this.setDefaultPresence();
    }
  }

  // ---- Slash command registration -----------------------------------------

  private async registerSlashCommands() {
    const rest = new REST().setToken(env.DISCORD_TOKEN);
    try {
      const commands = slashCommands.map((cmd) => cmd.toJSON());
      await rest.put(Routes.applicationCommands(this.client.user!.id), {
        body: commands,
      });
      botLogger.info({ count: commands.length }, "Registered slash commands");
    } catch (error) {
      botLogger.error({ error }, "Failed to register slash commands");
    }
  }

  private readonly dispatchInteraction = async (
    interaction: Interaction,
  ): Promise<void> => {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "smithery_select_server"
    ) {
      await handleSmitherySelect(interaction);
    } else if (
      interaction.isButton() &&
      interaction.customId === "smithery_enter_code"
    ) {
      await handleSmitheryCodeButton(interaction);
    } else if (
      interaction.isModalSubmit() &&
      interaction.customId === "smithery_code_modal"
    ) {
      await handleSmitheryModal(interaction);
    }
  };

  registerEvents() {
    this.client.once(Events.ClientReady, async (readyClient) => {
      botLogger.info({ tag: readyClient.user.tag }, "Bot logged in");
      this.setDefaultPresence();
      await this.registerSlashCommands();
      messageSyncService.start(this.client);
    });

    this.client.on(Events.InteractionCreate, this.dispatchInteraction);

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      if (await handleCommands(message)) return;
      await this.handleAIChat(message);
    });

    this.client.on(Events.MessageDelete, async (message) => {
      if (message.id && message.channelId) {
        await messageSyncService.deleteMessage(message.channelId, message.id);
      }
    });
  }

  start() {
    botLogger.info("Starting bot...");
    return this.client.login(env.DISCORD_TOKEN);
  }
}

export const ruyiBot = new RuyiBot();
