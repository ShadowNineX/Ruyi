import type { Document, Model } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

export interface ISteamCommentState extends Document {
  profileId: string;
  seenCommentIds: string[];
  lastCheckedAt: Date;
  updatedAt: Date;
}

const SteamCommentStateSchema = new Schema<ISteamCommentState>(
  {
    profileId: { type: String, required: true, unique: true, index: true },
    seenCommentIds: { type: [String], default: [] },
    lastCheckedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

export const SteamCommentState: Model<ISteamCommentState>
  = (mongoose.models.SteamCommentState as Model<ISteamCommentState> | undefined)
    ?? mongoose.model<ISteamCommentState>(
      'SteamCommentState',
      SteamCommentStateSchema,
      'steam_comment_states',
    );
