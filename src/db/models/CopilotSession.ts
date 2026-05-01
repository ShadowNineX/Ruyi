import mongoose, { Schema, Document } from "mongoose";

export interface ICopilotSession extends Document {
  /** Discord channel ID - used as the key */
  channelId: string;
  /** The Copilot SDK session ID */
  sessionId: string;
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

const CopilotSessionSchema = new Schema<ICopilotSession>({
  channelId: { type: String, required: true, unique: true, index: true },
  sessionId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastUsed: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  promptVersion: { type: String },
});

export const CopilotSession = mongoose.model<ICopilotSession>(
  "CopilotSession",
  CopilotSessionSchema,
);
