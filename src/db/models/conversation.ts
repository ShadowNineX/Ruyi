import mongoose, { Schema, type Document } from "mongoose";

export interface IConversationMessage {
  messageId: string;
  author: string;
  content: string;
  isBot: boolean;
  timestamp: Date;
  editedAt: Date | null;
  editCount: number;
}

export interface IConversation extends Document {
  channelId: string;
  messages: IConversationMessage[];
  lastInteraction: Date;
}

const MessageSchema = new Schema<IConversationMessage>(
  {
    messageId: { type: String, required: true, index: true },
    author: { type: String, required: true },
    content: { type: String, required: true },
    isBot: { type: Boolean, required: true },
    timestamp: { type: Date, default: Date.now },
    editedAt: { type: Date, default: null },
    editCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const ConversationSchema = new Schema<IConversation>({
  channelId: { type: String, required: true, unique: true },
  messages: { type: [MessageSchema], default: [] },
  lastInteraction: { type: Date, default: Date.now },
});

export const Conversation = mongoose.model<IConversation>(
  "Conversation",
  ConversationSchema,
);
