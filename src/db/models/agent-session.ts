import mongoose, { Schema } from "mongoose";

export interface IAgentSession {
  /** Discord channel ID - used as the key */
  channelId: string;
  /** The Ruyi/Agents SDK session ID */
  sessionId: string;
  /** Runtime provider for this session metadata */
  provider: "openai-agents";
  /** Model used when this session was last active */
  model: string;
  /** Compacted older channel context used when raw session items are pruned */
  summary?: string;
  /** When the summary was last refreshed */
  summaryUpdatedAt?: Date;
  /** Persisted Agents SDK session history items */
  items: unknown[];
  /** Discord user message IDs that were sent to this session */
  userMessageIds: string[];
  /** Discord message IDs for final assistant replies sent to the channel */
  assistantMessageIds: string[];
  /** When this session was created */
  createdAt: Date;
  /** When this session was last used */
  lastUsed: Date;
  /** Whether the session is still valid (not manually destroyed) */
  isActive: boolean;
  /**
   * Hash of the system prompt this session was created with. When the
   * prompt changes (new persona text, new tool hints), sessions with a
   * stale version are invalidated on next access so the model picks up
   * the new prompt.
   */
  promptVersion?: string;
}

const AgentSessionSchema = new Schema<IAgentSession>({
  channelId: { type: String, required: true, unique: true, index: true },
  sessionId: { type: String, required: true },
  provider: { type: String, enum: ["openai-agents"], default: "openai-agents" },
  model: { type: String, required: true },
  summary: { type: String },
  summaryUpdatedAt: { type: Date },
  items: { type: [Schema.Types.Mixed], default: [] },
  userMessageIds: { type: [String], default: [] },
  assistantMessageIds: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
  lastUsed: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  promptVersion: { type: String },
});

export const AgentSession = mongoose.model<IAgentSession>(
  "AgentSession",
  AgentSessionSchema,
);
