import mongoose, { Schema, type Document } from "mongoose";

export type MemoryScope = "user";

export interface IMemory extends Document {
  key: string;
  value: string;
  scope: MemoryScope;
  personId: string;
  username: string | null;
  createdBy: string;
  pinned: boolean;
  source: "user" | "auto";
  createdAt: Date;
  updatedAt: Date;
}

const MemorySchema = new Schema<IMemory>(
  {
    key: { type: String, required: true },
    value: { type: String, required: true },
    scope: { type: String, enum: ["user"], required: true },
    personId: { type: String, required: true },
    username: { type: String, default: null },
    createdBy: { type: String, required: true },
    pinned: { type: Boolean, default: false, index: true },
    source: { type: String, enum: ["user", "auto"], default: "user" },
  },
  { timestamps: true },
);

// Compound index for unique key per platform-linked person.
MemorySchema.index({ key: 1, personId: 1 }, { unique: true });
// Fast lookups for pinned memories per platform-linked person.
MemorySchema.index({ personId: 1, pinned: 1 });

export const Memory = mongoose.model<IMemory>("Memory", MemorySchema);
