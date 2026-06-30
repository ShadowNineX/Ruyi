import type { OpenAIProvider, Runner } from '@openai/agents';
import type OpenAI from 'openai';
import { createStore } from '@tanstack/store';

interface AgentsRuntimeStoreState {
  openaiClient: OpenAI | null;
  provider: OpenAIProvider | null;
  runner: Runner | null;
}

const agentsRuntimeStore = createStore<AgentsRuntimeStoreState>({
  openaiClient: null,
  provider: null,
  runner: null,
});

export function getOpenAIClient(): OpenAI | null {
  return agentsRuntimeStore.state.openaiClient;
}

export function getAgentsProvider(): OpenAIProvider | null {
  return agentsRuntimeStore.state.provider;
}

export function getAgentsRunner(): Runner | null {
  return agentsRuntimeStore.state.runner;
}

export function setAgentsRuntime(
  provider: OpenAIProvider | null,
  runner: Runner | null,
): void {
  agentsRuntimeStore.setState(state => ({ ...state, provider, runner }));
}

export function setOpenAIClient(openaiClient: OpenAI): void {
  agentsRuntimeStore.setState(state => ({ ...state, openaiClient }));
}

export function resetAgentsRuntime(): void {
  setAgentsRuntime(null, null);
}
