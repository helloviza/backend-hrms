import mongoose from "mongoose";
import { env } from "./env.js";
import logger from "../utils/logger.js";

export async function connectDb() {
  if (!env.MONGO_URI) {
    throw new Error("MONGO_URI is empty");
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGO_URI);
  logger.info("MongoDB connected");

  mongoose.connection.on("disconnected", () => {
    logger.warn("MongoDB disconnected");
  });

  mongoose.connection.on("error", (err) => {
    logger.error("MongoDB connection error", { error: err.message });
  });

  mongoose.connection.on("reconnected", () => {
    logger.info("MongoDB reconnected");
  });
}
