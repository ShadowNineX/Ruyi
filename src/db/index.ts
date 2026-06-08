import mongoose, { type ConnectOptions } from "mongoose";

import { env } from "../env";
import { dbLogger } from "../logger";
const MONGO_URI = env.MONGO_URI;

function getMongoConnectOptions(uri: string): ConnectOptions {
  const parsedUri = new URL(uri);
  const tlsEnabled =
    parsedUri.searchParams.get("tls") === "true" ||
    parsedUri.searchParams.get("ssl") === "true";
  const tlsCAFile =
    parsedUri.searchParams.get("tlsCAFile") ??
    parsedUri.searchParams.get("sslCAFile") ??
    undefined;
  return {
    ...(tlsEnabled ? { tls: true } : {}),
    ...(tlsCAFile ? { tlsCAFile } : {}),
    ...(tlsEnabled ? { tlsAllowInvalidHostnames: true } : {}),
  };
}

function redactMongoUri(uri: string): string {
  const parsedUri = new URL(uri);
  if (parsedUri.password) {
    parsedUri.password = "****";
  }
  return parsedUri.toString();
}

export async function connectDB(): Promise<typeof mongoose> {
  const connectOptions = getMongoConnectOptions(MONGO_URI);

  try {
    dbLogger.info(
      {
        mongoUri: redactMongoUri(MONGO_URI),
        tls: connectOptions.tls ?? false,
        tlsCAFile: connectOptions.tlsCAFile,
        tlsAllowInvalidHostnames:
          connectOptions.tlsAllowInvalidHostnames ?? false,
      },
      "Connecting to MongoDB",
    );

    await mongoose.connect(MONGO_URI, connectOptions);
    dbLogger.info("Connected to MongoDB");

    // Force exit on connection errors after initial connect
    mongoose.connection.on("error", (error) => {
      dbLogger.error({ error }, "MongoDB connection error");
      process.exit(1);
    });

    mongoose.connection.on("disconnected", () => {
      dbLogger.error("MongoDB disconnected unexpectedly");
      process.exit(1);
    });

    return mongoose;
  } catch (error) {
    dbLogger.error({ error }, "MongoDB connection error");
    process.exit(1);
  }
}
