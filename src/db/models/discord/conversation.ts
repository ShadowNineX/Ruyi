import type { Document, Model } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

export interface IDiscordConversationMessage {
  messageId: string;
  author: string;
  content: string;
  isBot: boolean;
  timestamp: Date;
  editedAt?: Date | null;
  editCount?: number;
}

export interface IDiscordConversation extends Document {
  channelId: string;
  messages: IDiscordConversationMessage[];
  lastInteraction: Date;
}

const DiscordMessageSchema = new Schema<IDiscordConversationMessage>(
  {
    messageId: { type: String, required: true },
    author: { type: String, required: true },
    content: { type: String, required: true },
    isBot: { type: Boolean, required: true },
    timestamp: { type: Date, default: Date.now },
    editedAt: { type: Date, default: null },
    editCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const DiscordConversationSchema = new Schema<IDiscordConversation>({
  channelId: { type: String, required: true, unique: true },
  messages: { type: [DiscordMessageSchema], default: [] },
  lastInteraction: { type: Date, default: Date.now },
});

export const DiscordConversation: Model<IDiscordConversation>
  = (mongoose.models.DiscordConversation as
  | Model<IDiscordConversation>
  | undefined)
?? mongoose.model<IDiscordConversation>(
  'DiscordConversation',
  DiscordConversationSchema,
  'discord_conversations',
);
