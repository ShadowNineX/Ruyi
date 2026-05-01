import {
  CopilotClient,
  approveAll,
  type AssistantMessageEvent,
} from "@github/copilot-sdk";
import { aiLogger } from "../logger";
import { CLASSIFIER_TIMEOUT_MS } from "../constants";
import { conversationContext } from "./context";
import { copilotClientManager } from "./client";

export class ReplyClassifier {
  async shouldReply(
    message: string,
    botName: string,
    channelId?: string,
  ): Promise<boolean> {
    let historyContext = "";
    if (channelId) {
      historyContext = await conversationContext.getMemoryContext(
        channelId,
        15,
      );
    }

    const historySection = historyContext
      ? `\nPrevious chat history:\n${historyContext}`
      : "";

    const systemPromptText = `You are a context analyzer for "${botName}", a friendly Discord bot assistant (Ruyi from Nine Sols). Reply ONLY with "yes" or "no".

Reply "yes" if:
- Greetings like "hey", "hi", "hello", "yo", "sup", "good morning", etc.
- Questions directed at the chat/room
- Someone asking for help, advice, or opinions
- Messages that invite conversation or responses
- Someone seems lonely or wants to chat
- Interesting topics worth engaging with
- Somebody mentions your name or the bot's name (Ruyi/Abacus)
- If it's a continuation of an ongoing conversation with the bot, even without direct mention like "as we were saying..., back to our previous topic..., continuing our chat about..., yes, please do, etc.

Reply "no" if:
- Message is clearly directed at another specific person
- Private conversation between others
- Just emojis, reactions, or "lol/lmao" type responses
- Spam or nonsense
- Very short messages with no substance (like just "ok" or "yeah" unless it's part of user's answer to the bot)${historySection}
`;

    let classifyClient: CopilotClient | null = null;
    try {
      classifyClient = new CopilotClient({
        autoStart: true,
        autoRestart: false,
        logLevel: "warning",
      });
      await classifyClient.start();

      const session = await classifyClient.createSession({
        model: copilotClientManager.model,
        provider: copilotClientManager.getProviderConfig(),
        systemMessage: { mode: "replace", content: systemPromptText },
        streaming: true,
        infiniteSessions: { enabled: false },
        onPermissionRequest: approveAll,
      });

      const resultEvent: AssistantMessageEvent | undefined =
        await session.sendAndWait({ prompt: message }, CLASSIFIER_TIMEOUT_MS);
      const responseContent = resultEvent?.data.content ?? "";

      await session.disconnect();
      await classifyClient.stop();
      classifyClient = null;

      const result = responseContent.toLowerCase().trim() === "yes";
      aiLogger.debug(
        { messagePreview: message.slice(0, 50), result },
        "shouldReply decision",
      );
      return result;
    } catch (error) {
      aiLogger.warn(
        {
          error: (error as Error)?.message,
          messagePreview: message.slice(0, 50),
        },
        "shouldReply failed, defaulting to no",
      );
      try {
        await classifyClient?.stop();
      } catch {
        // ignore cleanup error
      }
      return false;
    }
  }
}

export const replyClassifier = new ReplyClassifier();
