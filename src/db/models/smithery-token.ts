import mongoose, { Schema, type Document } from "mongoose";

/** Supported Smithery server IDs */
export type SmitheryServerId = "brave" | "youtube";

export interface ISmitheryToken extends Document {
  serverId: SmitheryServerId;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SmitheryTokenSchema = new Schema<ISmitheryToken>(
  {
    serverId: { type: String, required: true, unique: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String },
    tokenType: { type: String, default: "Bearer" },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

export const SmitheryToken = mongoose.model<ISmitheryToken>(
  "SmitheryToken",
  SmitheryTokenSchema,
);

/**
 * Get Smithery tokens for a specific server.
 */
export async function getSmitheryTokens(
  serverId: SmitheryServerId,
): Promise<ISmitheryToken | null> {
  return SmitheryToken.findOne({ serverId });
}

/**
 * Get all Smithery tokens.
 */
export async function getAllSmitheryTokens(): Promise<ISmitheryToken[]> {
  return SmitheryToken.find();
}

/**
 * Save or update Smithery tokens for a specific server.
 */
export async function saveSmitheryTokens(
  serverId: SmitheryServerId,
  tokens: {
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    expiresIn?: number;
  },
): Promise<ISmitheryToken> {
  const expiresAt = tokens.expiresIn
    ? new Date(Date.now() + tokens.expiresIn * 1000)
    : undefined;

  // Upsert by serverId - each server has its own tokens
  const result = await SmitheryToken.findOneAndUpdate(
    { serverId },
    {
      serverId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType ?? "Bearer",
      expiresAt,
    },
    { upsert: true, returnDocument: "after" },
  );

  return result;
}

/**
 * Check if tokens are expired or about to expire (within 5 minutes).
 */
export function isTokenExpired(token: ISmitheryToken): boolean {
  if (!token.expiresAt) return false; // No expiry means it doesn't expire
  const bufferMs = 5 * 60 * 1000; // 5 minute buffer
  return new Date(token.expiresAt).getTime() - bufferMs < Date.now();
}

/**
 * Delete Smithery tokens for a specific server (or all if no serverId).
 */
export async function clearSmitheryTokens(
  serverId?: SmitheryServerId,
): Promise<void> {
  if (serverId) {
    await SmitheryToken.deleteOne({ serverId });
  } else {
    await SmitheryToken.deleteMany({});
  }
}
