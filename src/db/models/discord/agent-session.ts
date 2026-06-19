import type { Model } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

export interface IDiscordAgentSession {
  channelId: string;
  sessionId: string;
  provider: 'openai-agents';
  model: string;
  summary?: string;
  summaryUpdatedAt?: Date;
  items: unknown[];
  userMessageIds: string[];
  assistantMessageIds: string[];
  assistantReplies: IDiscordAssistantReplyLink[];
  createdAt: Date;
  lastUsed: Date;
  isActive: boolean;
  promptVersion?: string;
}

export interface IDiscordAssistantReplyLink {
  userMessageId: string;
  assistantMessageIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const DiscordAssistantReplyLinkSchema
  = new Schema<IDiscordAssistantReplyLink>(
    {
      userMessageId: { type: String, required: true, index: true },
      assistantMessageIds: { type: [String], default: [] },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now },
    },
    { _id: false },
  );

const DiscordAgentSessionSchema = new Schema<IDiscordAgentSession>({
  channelId: { type: String, required: true, unique: true, index: true },
  sessionId: { type: String, required: true },
  provider: { type: String, enum: ['openai-agents'], default: 'openai-agents' },
  model: { type: String, required: true },
  summary: { type: String },
  summaryUpdatedAt: { type: Date },
  items: { type: [Schema.Types.Mixed], default: [] },
  userMessageIds: { type: [String], default: [] },
  assistantMessageIds: { type: [String], default: [] },
  assistantReplies: { type: [DiscordAssistantReplyLinkSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  lastUsed: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  promptVersion: { type: String },
});

export const DiscordAgentSession: Model<IDiscordAgentSession>
  = (mongoose.models.DiscordAgentSession as
  | Model<IDiscordAgentSession>
  | undefined)
?? mongoose.model<IDiscordAgentSession>(
  'DiscordAgentSession',
  DiscordAgentSessionSchema,
  'discord_agent_sessions',
);
