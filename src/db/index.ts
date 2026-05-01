import mongoose from "mongoose";

import { env } from "../env";
import { dbLogger } from "../logger";
const MONGO_URI = env.MONGO_URI;

export async function connectDB(): Promise<typeof mongoose> {
  try {
    await mongoose.connect(MONGO_URI);
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
