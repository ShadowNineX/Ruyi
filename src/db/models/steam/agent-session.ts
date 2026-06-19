import type { Model } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

export interface ISteamAgentSession {
  profileId: string;
  sessionId: string;
  provider: 'openai-agents';
  model: string;
  summary?: string;
  summaryUpdatedAt?: Date;
  items: unknown[];
  processedCommentIds: string[];
  createdAt: Date;
  lastUsed: Date;
  isActive: boolean;
  promptVersion?: string;
}

const SteamAgentSessionSchema = new Schema<ISteamAgentSession>({
  profileId: { type: String, required: true, unique: true, index: true },
  sessionId: { type: String, required: true },
  provider: { type: String, enum: ['openai-agents'], default: 'openai-agents' },
  model: { type: String, required: true },
  summary: { type: String },
  summaryUpdatedAt: { type: Date },
  items: { type: [Schema.Types.Mixed], default: [] },
  processedCommentIds: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
  lastUsed: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  promptVersion: { type: String },
});

export const SteamAgentSession: Model<ISteamAgentSession>
  = (mongoose.models.SteamAgentSession as Model<ISteamAgentSession> | undefined)
    ?? mongoose.model<ISteamAgentSession>(
      'SteamAgentSession',
      SteamAgentSessionSchema,
      'steam_agent_sessions',
    );
