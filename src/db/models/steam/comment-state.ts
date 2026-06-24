import type { Document, Model } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

export interface ISteamCommentState extends Document {
  accountId: string;
  profileId: string;
  seenCommentIds: string[];
  lastCheckedAt: Date;
  updatedAt: Date;
}

const SteamCommentStateSchema = new Schema<ISteamCommentState>(
  {
    accountId: { type: String, required: true, index: true },
    profileId: { type: String, required: true, index: true },
    seenCommentIds: { type: [String], default: [] },
    lastCheckedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

SteamCommentStateSchema.index(
  { accountId: 1, profileId: 1 },
  { unique: true },
);

export const SteamCommentState: Model<ISteamCommentState>
  = (mongoose.models.SteamCommentState as Model<ISteamCommentState> | undefined)
    ?? mongoose.model<ISteamCommentState>(
      'SteamCommentState',
      SteamCommentStateSchema,
      'steam_comment_states',
    );
