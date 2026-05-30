import { OpenAIProvider, Runner, setTracingDisabled } from "@openai/agents";
import { aiLogger } from "../logger";
import { env } from "../env";

export class AgentsRuntimeManager {
  private provider: OpenAIProvider | null = null;
  private runner: Runner | null = null;
  readonly model = env.MODEL_NAME;

  getProviderConfig() {
    return {
      apiKey: env.MODEL_TOKEN,
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
      modelProvider: this.provider,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      workflowName: "Ruyi Discord chat",
      toolNotFoundBehavior: "return_error_to_model",
    });

    aiLogger.info(
      { model: this.model },
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
