import pino from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
});

// Child loggers for different modules
export const botLogger = logger.child({ module: "bot" });
export const aiLogger = logger.child({ module: "ai" });
export const toolLogger = logger.child({ module: "tools" });
export const syncLogger = logger.child({ module: "sync" });
export const mcpLogger = logger.child({ module: "mcp" });
export const dbLogger = logger.child({ module: "db" });
