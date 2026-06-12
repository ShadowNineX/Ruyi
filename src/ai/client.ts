import {
  OpenAIProvider,
  Runner,
  setTracingDisabled,
  type ModelSettings,
} from "@openai/agents";
import { aiLogger } from "../logger";
import { env } from "../env";
import { configManager } from "../config";

export class AgentsRuntimeManager {
  private provider: OpenAIProvider | null = null;
  private runner: Runner | null = null;

  get model(): string {
    return configManager.getChatModel();
  }

  get modelSettings(): ModelSettings {
    return configManager.getModelSettings();
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
        preset: configManager.getModelPreset(),
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
