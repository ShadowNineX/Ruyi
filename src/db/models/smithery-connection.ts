import type { Document, Model } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

/** Supported Smithery server IDs. */
export type SmitheryServerId = 'youtube';
export type SmitheryConnectionScopeKind = 'discord:guild' | 'discord:dm';

export interface SmitheryConnectionScope {
  kind: SmitheryConnectionScopeKind;
  id: string;
}

export type SmitheryConnectionStatus
  = | 'connected'
    | 'auth_required'
    | 'input_required'
    | 'disconnected'
    | 'error'
    | 'unknown';

export interface ISmitheryConnection extends Document {
  scopeKind: SmitheryConnectionScopeKind;
  scopeId: string;
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
    scopeKind: {
      type: String,
      enum: ['discord:guild', 'discord:dm'],
      required: true,
    },
    scopeId: { type: String, required: true },
    serverId: { type: String, required: true },
    connectionId: { type: String, required: true, unique: true },
    status: { type: String, required: true, default: 'unknown' },
    setupUrl: { type: String },
    errorMessage: { type: String },
  },
  { timestamps: true },
);

SmitheryConnectionSchema.index(
  { scopeKind: 1, scopeId: 1, serverId: 1 },
  { unique: true },
);
SmitheryConnectionSchema.index({ scopeKind: 1, scopeId: 1, status: 1 });

const SmitheryConnection: Model<ISmitheryConnection>
  = (mongoose.models.SmitheryConnection as
  | Model<ISmitheryConnection>
  | undefined)
?? mongoose.model<ISmitheryConnection>(
  'SmitheryConnection',
  SmitheryConnectionSchema,
);

export function isSmitheryConnectionScope(
  scope: { kind: string; id: string },
): scope is SmitheryConnectionScope {
  return scope.kind === 'discord:guild' || scope.kind === 'discord:dm';
}

function scopeFilter(scope: SmitheryConnectionScope) {
  return { scopeKind: scope.kind, scopeId: scope.id };
}

export async function getSmitheryConnection(
  scope: SmitheryConnectionScope,
  serverId: SmitheryServerId,
): Promise<ISmitheryConnection | null> {
  return SmitheryConnection.findOne({ ...scopeFilter(scope), serverId });
}

export async function getAllSmitheryConnections(
  scope?: SmitheryConnectionScope,
): Promise<ISmitheryConnection[]> {
  return SmitheryConnection.find(scope ? scopeFilter(scope) : {});
}

export async function countConnectedSmitheryConnections(): Promise<number> {
  return SmitheryConnection.countDocuments({ status: 'connected' });
}

export async function saveSmitheryConnection(input: {
  scope: SmitheryConnectionScope;
  serverId: SmitheryServerId;
  connectionId: string;
  status: SmitheryConnectionStatus;
  setupUrl?: string;
  errorMessage?: string;
}): Promise<ISmitheryConnection> {
  const setFields: Partial<ISmitheryConnection> = {
    scopeKind: input.scope.kind,
    scopeId: input.scope.id,
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
    { ...scopeFilter(input.scope), serverId: input.serverId },
    {
      $set: setFields,
      $unset: unsetFields,
    },
    { upsert: true, returnDocument: 'after' },
  );
}

export async function clearSmitheryConnection(
  scope: SmitheryConnectionScope,
  serverId?: SmitheryServerId,
): Promise<void> {
  if (serverId) {
    await SmitheryConnection.deleteOne({ ...scopeFilter(scope), serverId });
    return;
  }

  await SmitheryConnection.deleteMany(scopeFilter(scope));
}
