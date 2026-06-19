import type { Document } from 'mongoose';
import type { ConfigScope } from '../../config';
import mongoose, { Schema } from 'mongoose';

export type ReminderKind = 'reminder' | 'timer';
type ReminderScopeKind = Extract<
  ConfigScope['kind'],
  'discord:guild' | 'discord:dm'
>;
type ReminderStatus
  = | 'scheduled'
    | 'processing';

export interface IReminder extends Document {
  _id: mongoose.Types.ObjectId;
  kind: ReminderKind;
  text: string;
  dueAt: Date;
  status: ReminderStatus;
  scopeKind: ReminderScopeKind;
  scopeId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  createdByMessageId: string | null;
  deliveryAttempts: number;
  processingStartedAt: Date | null;
  lastDeliveryError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ReminderSchema = new Schema<IReminder>(
  {
    kind: {
      type: String,
      enum: ['reminder', 'timer'],
      required: true,
    },
    text: { type: String, required: true },
    dueAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ['scheduled', 'processing'],
      default: 'scheduled',
      required: true,
      index: true,
    },
    scopeKind: {
      type: String,
      enum: ['discord:guild', 'discord:dm'],
      required: true,
    },
    scopeId: { type: String, required: true },
    guildId: { type: String, default: null },
    channelId: { type: String, required: true },
    userId: { type: String, required: true },
    username: { type: String, required: true },
    createdByMessageId: { type: String, default: null },
    deliveryAttempts: { type: Number, default: 0 },
    processingStartedAt: { type: Date, default: null },
    lastDeliveryError: { type: String, default: null },
  },
  { timestamps: true },
);

ReminderSchema.index({ status: 1, dueAt: 1 });
ReminderSchema.index({
  scopeKind: 1,
  scopeId: 1,
  userId: 1,
  status: 1,
  dueAt: 1,
});
ReminderSchema.index({ status: 1, processingStartedAt: 1 });

export const Reminder = mongoose.model<IReminder>('Reminder', ReminderSchema);
