import type { BaseMessageOptions, Message, SendableChannels } from 'discord.js';
import { createStore } from '@tanstack/store';

export type PermissionPromptPayload = Pick<
  BaseMessageOptions,
  'embeds' | 'components'
>;

export interface PermissionPromptController {
  showPrompt: (payload: PermissionPromptPayload) => Promise<Message | null>;
  releasePrompt: () => void;
}

export interface PermissionContext {
  channel: SendableChannels;
  promptController: PermissionPromptController;
  turnId: string;
  userId: string;
}

interface PermissionStoreState {
  contextsByChannelId: Map<string, PermissionContext>;
  promptMessagesByTurnId: Map<string, Set<Message>>;
}

const permissionStore = createStore<PermissionStoreState>({
  contextsByChannelId: new Map(),
  promptMessagesByTurnId: new Map(),
});

export function setPermissionContext(
  channelId: string,
  context: PermissionContext,
): void {
  permissionStore.setState((state) => {
    const contextsByChannelId = new Map(state.contextsByChannelId);
    contextsByChannelId.set(channelId, context);
    return { ...state, contextsByChannelId };
  });
}

export function getPermissionContext(
  channelId: string,
): PermissionContext | undefined {
  return permissionStore.state.contextsByChannelId.get(channelId);
}

export function clearPermissionContext(channelId: string): void {
  permissionStore.setState((state) => {
    const contextsByChannelId = new Map(state.contextsByChannelId);
    contextsByChannelId.delete(channelId);
    return { ...state, contextsByChannelId };
  });
}

export function addPermissionPromptMessage(
  turnId: string,
  message: Message,
): void {
  permissionStore.setState((state) => {
    const promptMessagesByTurnId = new Map(state.promptMessagesByTurnId);
    const messages = new Set(promptMessagesByTurnId.get(turnId) ?? []);
    messages.add(message);
    promptMessagesByTurnId.set(turnId, messages);
    return { ...state, promptMessagesByTurnId };
  });
}

export function takePermissionPromptMessages(turnId: string): Set<Message> {
  const messages = permissionStore.state.promptMessagesByTurnId.get(turnId);
  if (!messages) { return new Set<Message>(); }

  permissionStore.setState((state) => {
    const promptMessagesByTurnId = new Map(state.promptMessagesByTurnId);
    promptMessagesByTurnId.delete(turnId);
    return { ...state, promptMessagesByTurnId };
  });
  return messages;
}
