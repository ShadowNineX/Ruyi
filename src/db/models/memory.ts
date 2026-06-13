import mongoose, { Schema, type Document } from "mongoose";

export type MemoryScope = "user";
export type MemoryScopeKind = "guild" | "dm";

export interface IMemory extends Document {
  key: string;
  value: string;
  scope: MemoryScope;
  scopeKind: MemoryScopeKind;
  scopeId: string;
  userId: string;
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
    scopeKind: { type: String, enum: ["guild", "dm"], required: true },
    scopeId: { type: String, required: true },
    userId: { type: String, required: true },
    username: { type: String, default: null },
    createdBy: { type: String, required: true },
    pinned: { type: Boolean, default: false, index: true },
    source: { type: String, enum: ["user", "auto"], default: "user" },
  },
  { timestamps: true },
);

// Compound index for unique key per guild/DM + Discord user memory scope.
MemorySchema.index(
  { key: 1, scopeKind: 1, scopeId: 1, userId: 1 },
  { unique: true },
);
// Fast lookups for pinned memories per guild/DM + Discord user memory scope.
MemorySchema.index({ scopeKind: 1, scopeId: 1, userId: 1, pinned: 1 });

export const Memory = mongoose.model<IMemory>("Memory", MemorySchema);
