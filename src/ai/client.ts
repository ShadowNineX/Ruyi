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
  private provider: OpenAIProvider | null = null;
  private runner: Runner | null = null;

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
    if (this.runner) {
      aiLogger.info("OpenAI Agents runtime already initialized");
      return;
    }

    setTracingDisabled(true);
    this.provider = new OpenAIProvider(this.getProviderConfig());
    this.runner = new Runner({
      model: this.model,
      modelSettings: this.modelSettings,
      modelProvider: this.provider,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      workflowName: "Ruyi Discord chat",
      toolNotFoundBehavior: "return_error_to_model",
    });

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
    if (!this.runner) {
      this.initialize();
    }
    return this.runner!;
  }

  async stop(): Promise<void> {
    if (!this.provider) return;

    try {
      await this.provider.close();
    } catch (error) {
      aiLogger.warn(
        { error: (error as Error).message },
        "Error stopping OpenAI Agents provider",
      );
    }
    this.provider = null;
    this.runner = null;
  }

  isConnected(): boolean {
    return this.runner !== null;
  }
}

export const agentsRuntimeManager = new AgentsRuntimeManager();
