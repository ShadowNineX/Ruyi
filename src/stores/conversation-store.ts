import { createStore } from '@tanstack/store';

interface ConversationStoreState {
  lastInteractionAtByChannel: Map<string, number>;
  userMessageCountByKey: Map<string, number>;
  lastExtractionAtByKey: Map<string, number>;
}

const conversationStore = createStore<ConversationStoreState>({
  lastInteractionAtByChannel: new Map(),
  userMessageCountByKey: new Map(),
  lastExtractionAtByKey: new Map(),
});

export function getLastInteractionAt(channelId: string): number | undefined {
  return conversationStore.state.lastInteractionAtByChannel.get(channelId);
}

export function setLastInteractionAt(
  channelId: string,
  timestamp: number,
): void {
  conversationStore.setState((state) => {
    const lastInteractionAtByChannel = new Map(
      state.lastInteractionAtByChannel,
    );
    lastInteractionAtByChannel.set(channelId, timestamp);
    return { ...state, lastInteractionAtByChannel };
  });
}

export function incrementUserMessageCount(key: string): number {
  const nextCount
    = (conversationStore.state.userMessageCountByKey.get(key) ?? 0) + 1;
  conversationStore.setState((state) => {
    const userMessageCountByKey = new Map(state.userMessageCountByKey);
    userMessageCountByKey.set(key, nextCount);
    return { ...state, userMessageCountByKey };
  });
  return nextCount;
}

export function resetUserMessageCount(key: string): void {
  conversationStore.setState((state) => {
    const userMessageCountByKey = new Map(state.userMessageCountByKey);
    userMessageCountByKey.set(key, 0);
    return { ...state, userMessageCountByKey };
  });
}

export function getLastExtractionAt(key: string): number {
  return conversationStore.state.lastExtractionAtByKey.get(key) ?? 0;
}

export function setLastExtractionAt(key: string, timestamp: number): void {
  conversationStore.setState((state) => {
    const lastExtractionAtByKey = new Map(state.lastExtractionAtByKey);
    lastExtractionAtByKey.set(key, timestamp);
    return { ...state, lastExtractionAtByKey };
  });
}
