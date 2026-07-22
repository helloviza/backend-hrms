import mongoose from "mongoose";
import { env } from "./env.js";
import logger from "../utils/logger.js";

export async function connectDb() {
  if (!env.MONGO_URI) {
    throw new Error("MONGO_URI is empty");
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGO_URI, {
    // Bounds how long an operation on an already-open socket can hang before
    // erroring — the driver default is unbounded, so a stalled Atlas socket
    // (rare, but seen in prod via the shared NAT-gateway egress path) would
    // otherwise hang a request forever instead of failing fast.
    socketTimeoutMS: 45_000,
    // Bounds the initial TCP+TLS handshake per server in the connection string.
    connectTimeoutMS: 10_000,
    // How long to wait for a suitable server before giving up. Lowered from
    // the driver's 30s default — a normal Atlas replica-set election finishes
    // in a few seconds, so 10s still rides that out while failing a genuinely
    // unreachable cluster well before a user-facing request would time out.
    serverSelectionTimeoutMS: 10_000,
  });
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
