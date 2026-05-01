import { CopilotClient } from "@github/copilot-sdk";
import { aiLogger } from "../logger";
import { env } from "../env";

export class CopilotClientManager {
  private copilotClient: CopilotClient | null = null;
  readonly model = env.MODEL_NAME;

  getProviderConfig() {
    return {
      type: "openai" as const,
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: env.MODEL_TOKEN,
    };
  }

  async initialize(): Promise<void> {
    if (this.copilotClient?.getState() === "connected") {
      aiLogger.info("CopilotClient already initialized");
      return;
    }

    this.copilotClient = new CopilotClient({
      autoStart: false,
      autoRestart: true,
      logLevel: "warning",
    });

    await this.copilotClient.start();
    aiLogger.info("CopilotClient initialized and started");
  }

  async getClient(): Promise<CopilotClient> {
    if (this.copilotClient?.getState() !== "connected") {
      await this.initialize();
    }
    return this.copilotClient!;
  }

  async stop(): Promise<void> {
    if (!this.copilotClient) return;

    try {
      await this.copilotClient.stop();
    } catch (error) {
      aiLogger.warn(
        { error: (error as Error).message },
        "Error stopping client",
      );
    }
    this.copilotClient = null;
  }

  isConnected(): boolean {
    return this.copilotClient?.getState() === "connected";
  }
}

export const copilotClientManager = new CopilotClientManager();
