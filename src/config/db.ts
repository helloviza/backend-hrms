import mongoose from "mongoose";
import { env } from "./env.js";

export async function connectDb() {
  if (!env.MONGO_URI) {
    throw new Error("MONGO_URI is empty");
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGO_URI);
  console.log("✅ Mongo connected");
}
