import { createStore } from "@tanstack/store";
import type { OpenAIProvider, Runner } from "@openai/agents";

interface AgentsRuntimeStoreState {
  provider: OpenAIProvider | null;
  runner: Runner | null;
}

const agentsRuntimeStore = createStore<AgentsRuntimeStoreState>({
  provider: null,
  runner: null,
});

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
  agentsRuntimeStore.setState(() => ({ provider, runner }));
}

function setAgentsRunner(runner: Runner | null): void {
  agentsRuntimeStore.setState((state) => ({ ...state, runner }));
}

export function resetAgentsRuntime(): void {
  setAgentsRuntime(null, null);
}
