import mongoose, { Schema, type Document } from "mongoose";

/** Supported Smithery server IDs. */
export type SmitheryServerId = "brave" | "github" | "youtube";

export type SmitheryConnectionStatus =
  | "connected"
  | "auth_required"
  | "input_required"
  | "disconnected"
  | "error"
  | "unknown";

export interface ISmitheryConnection extends Document {
  serverId: SmitheryServerId;
  connectionId: string;
  status: SmitheryConnectionStatus;
  setupUrl?: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SmitheryConnectionSchema = new Schema<ISmitheryConnection>(
  {
    serverId: { type: String, required: true, unique: true },
    connectionId: { type: String, required: true, unique: true },
    status: { type: String, required: true, default: "unknown" },
    setupUrl: { type: String },
    errorMessage: { type: String },
  },
  { timestamps: true },
);

export const SmitheryConnection = mongoose.model<ISmitheryConnection>(
  "SmitheryConnection",
  SmitheryConnectionSchema,
);

export async function getSmitheryConnection(
  serverId: SmitheryServerId,
): Promise<ISmitheryConnection | null> {
  return SmitheryConnection.findOne({ serverId });
}

export async function getAllSmitheryConnections(): Promise<
  ISmitheryConnection[]
> {
  return SmitheryConnection.find();
}

export async function countConnectedSmitheryConnections(): Promise<number> {
  return SmitheryConnection.countDocuments({ status: "connected" });
}

export async function saveSmitheryConnection(input: {
  serverId: SmitheryServerId;
  connectionId: string;
  status: SmitheryConnectionStatus;
  setupUrl?: string;
  errorMessage?: string;
}): Promise<ISmitheryConnection> {
  const setFields: Partial<ISmitheryConnection> = {
    serverId: input.serverId,
    connectionId: input.connectionId,
    status: input.status,
  };
  const unsetFields: Record<string, 1> = {};

  if (input.setupUrl) {
    setFields.setupUrl = input.setupUrl;
  } else {
    unsetFields.setupUrl = 1;
  }

  if (input.errorMessage) {
    setFields.errorMessage = input.errorMessage;
  } else {
    unsetFields.errorMessage = 1;
  }

  return SmitheryConnection.findOneAndUpdate(
    { serverId: input.serverId },
    {
      $set: setFields,
      $unset: unsetFields,
    },
    { upsert: true, returnDocument: "after" },
  );
}

export async function clearSmitheryConnection(
  serverId?: SmitheryServerId,
): Promise<void> {
  if (serverId) {
    await SmitheryConnection.deleteOne({ serverId });
    return;
  }

  await SmitheryConnection.deleteMany({});
}
