import type { Document, Model } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

export interface ISteamConversationMessage {
  commentId: string;
  profileId: string;
  authorSteamId: string;
  authorName: string;
  content: string;
  isBot: boolean;
  timestamp: Date;
}

export interface ISteamConversation extends Document {
  accountId: string;
  profileId: string;
  messages: ISteamConversationMessage[];
  lastInteraction: Date;
}

const SteamMessageSchema = new Schema<ISteamConversationMessage>(
  {
    commentId: { type: String, required: true },
    profileId: { type: String, required: true },
    authorSteamId: { type: String, required: true },
    authorName: { type: String, required: true },
    content: { type: String, required: true },
    isBot: { type: Boolean, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const SteamConversationSchema = new Schema<ISteamConversation>({
  accountId: { type: String, required: true, index: true },
  profileId: { type: String, required: true, index: true },
  messages: { type: [SteamMessageSchema], default: [] },
  lastInteraction: { type: Date, default: Date.now },
});

SteamConversationSchema.index(
  { accountId: 1, profileId: 1 },
  { unique: true },
);

export const SteamConversation: Model<ISteamConversation>
  = (mongoose.models.SteamConversation as Model<ISteamConversation> | undefined)
    ?? mongoose.model<ISteamConversation>(
      'SteamConversation',
      SteamConversationSchema,
      'steam_conversations',
    );
