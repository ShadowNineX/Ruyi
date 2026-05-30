import { Agent } from "@openai/agents";
import { z } from "zod";
import { aiLogger } from "../logger";
import { CLASSIFIER_TIMEOUT_MS } from "../constants";
import { conversationContext } from "./context";
import { agentsRuntimeManager } from "./client";

const ReplyDecisionSchema = z.object({
  shouldReply: z.boolean(),
});

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

    const systemPromptText = `You are a context analyzer for "${botName}", a friendly Discord bot assistant (Ruyi from Nine Sols). Decide whether Ruyi should reply.

Set shouldReply to true if:
- Greetings like "hey", "hi", "hello", "yo", "sup", "good morning", etc.
- Questions directed at the chat/room
- Someone asking for help, advice, or opinions
- Messages that invite conversation or responses
- Someone seems lonely or wants to chat
- Interesting topics worth engaging with
- Somebody mentions your name or the bot's name (Ruyi/Abacus)
- If it's a continuation of an ongoing conversation with the bot, even without direct mention like "as we were saying..., back to our previous topic..., continuing our chat about..., yes, please do, etc.

Set shouldReply to false if:
- Message is clearly directed at another specific person
- Private conversation between others
- Just emojis, reactions, or "lol/lmao" type responses
- Spam or nonsense
- Very short messages with no substance (like just "ok" or "yeah" unless it's part of user's answer to the bot)${historySection}
`;

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      CLASSIFIER_TIMEOUT_MS,
    );

    try {
      const agent = new Agent({
        name: "Ruyi reply classifier",
        instructions: systemPromptText,
        model: agentsRuntimeManager.model,
        outputType: ReplyDecisionSchema,
      });

      const result = await agentsRuntimeManager.getRunner().run(agent, message, {
        maxTurns: 1,
        signal: abortController.signal,
      });

      const decision = result.finalOutput?.shouldReply ?? false;
      aiLogger.debug(
        { messagePreview: message.slice(0, 50), decision },
        "shouldReply decision",
      );
      return decision;
    } catch (error) {
      const err = error as Error;
      aiLogger.warn(
        {
          error: err.message,
          stack: err.stack,
          name: err.name,
          messagePreview: message.slice(0, 50),
        },
        "shouldReply failed, defaulting to no",
      );
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const replyClassifier = new ReplyClassifier();
