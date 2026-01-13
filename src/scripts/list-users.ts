// apps/backend/src/scripts/list-users.ts
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import User from "../models/User.js";

async function main() {
  console.log("🔌 Connecting to MongoDB...");
  try {
    await mongoose.connect(env.MONGO_URI);
    console.log("✅ Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);

    const users = await User.find({}, { email: 1, roles: 1, name: 1, displayName: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .lean();

    if (!users.length) {
      console.log("⚠️ No users found in database.");
      return;
    }

    console.log("\n📋 PlumTrips HRMS – User Directory\n");
    console.table(
      users.map((u: any) => ({
        id: u._id?.toString(),
        name: u.name || u.displayName || "",
        email: u.email,
        roles: Array.isArray(u.roles) ? u.roles.join(", ") : u.roles || "",
        createdAt: u.createdAt
          ? new Date(u.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
          : "-",
      }))
    );

    console.log(`\nTotal Users: ${users.length}\n`);
  } catch (e) {
    console.error("❌ Error listing users:", e);
  } finally {
    await mongoose.connection.close();
    console.log("🔒 Connection closed.");
  }
}

main();
