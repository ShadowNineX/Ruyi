import {
  getDefaultModelSettings,
  OpenAIProvider,
  Runner,
  setTracingDisabled,
  type ModelSettings,
} from "@openai/agents";
import { aiLogger } from "../logger";
import { env } from "../env";
import { configManager, type ConfigScope } from "../config";
import { BACKGROUND_TASK_MODEL } from "../constants";
import {
  getAgentsProvider,
  getAgentsRunner,
  resetAgentsRuntime,
  setAgentsRuntime,
} from "../stores";

type ReasoningEffort = NonNullable<ModelSettings["reasoning"]>["effort"];
type TextVerbosity = NonNullable<ModelSettings["text"]>["verbosity"];

const BACKGROUND_TASK_REASONING_EFFORT: ReasoningEffort = "low";
const BACKGROUND_TASK_TEXT_VERBOSITY: TextVerbosity = "low";

function buildBackgroundTaskModelSettings(): ModelSettings {
  const defaults = getDefaultModelSettings(BACKGROUND_TASK_MODEL);

  return {
    ...defaults,
    reasoning: {
      ...defaults.reasoning,
      effort: BACKGROUND_TASK_REASONING_EFFORT,
    },
    text: {
      ...defaults.text,
      verbosity: BACKGROUND_TASK_TEXT_VERBOSITY,
    },
  };
}

class AgentsRuntimeManager {
  get model(): string {
    return configManager.getChatModel(null);
  }

  get modelSettings(): ModelSettings {
    return configManager.getModelSettings(null);
  }

  getModel(scope: ConfigScope | null | undefined): string {
    return configManager.getChatModel(scope);
  }

  getModelSettings(scope: ConfigScope | null | undefined): ModelSettings {
    return configManager.getModelSettings(scope);
  }

  getBackgroundTaskModel(): string {
    return BACKGROUND_TASK_MODEL;
  }

  getBackgroundTaskModelSettings(): ModelSettings {
    return buildBackgroundTaskModelSettings();
  }

  getProviderConfig() {
    return {
      apiKey: env.OPENAI_API_KEY,
      useResponses: true,
      strictFeatureValidation: false,
    } as const;
  }

  initialize(): void {
    if (getAgentsRunner()) {
      aiLogger.info("OpenAI Agents runtime already initialized");
      return;
    }

    setTracingDisabled(true);
    const provider = new OpenAIProvider(this.getProviderConfig());
    const runner = new Runner({
      model: this.model,
      modelSettings: this.modelSettings,
      modelProvider: provider,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      workflowName: "Ruyi Discord chat",
      toolNotFoundBehavior: "return_error_to_model",
    });
    setAgentsRuntime(provider, runner);

    aiLogger.info(
      {
        model: this.model,
        preset: configManager.getModelPreset(null),
        modelSettings: this.modelSettings,
      },
      "OpenAI Agents runtime initialized",
    );
  }

  getRunner(): Runner {
    let runner = getAgentsRunner();
    if (!runner) {
      this.initialize();
      runner = getAgentsRunner();
    }
    if (!runner) throw new Error("OpenAI Agents runner was not initialized");
    return runner;
  }

  async stop(): Promise<void> {
    const provider = getAgentsProvider();
    if (!provider) return;

    try {
      await provider.close();
    } catch (error) {
      aiLogger.warn(
        { error: (error as Error).message },
        "Error stopping OpenAI Agents provider",
      );
    }
    resetAgentsRuntime();
  }

  isConnected(): boolean {
    return getAgentsRunner() !== null;
  }
}

export const agentsRuntimeManager = new AgentsRuntimeManager();
