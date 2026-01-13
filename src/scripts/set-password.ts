// apps/backend/src/scripts/set-password.ts
import bcrypt from "bcryptjs";
import { connectDb } from "../config/db.js";
import User from "../models/User.js";

async function main() {
  const email = process.argv[2];
  const newPassword = process.argv[3];

  if (!email || !newPassword) {
    console.log("Usage: pnpm tsx src/scripts/set-password.ts <email> <newPassword>");
    console.log('Example: pnpm tsx src/scripts/set-password.ts "admin@plumtrips.com" "admin123"');
    process.exit(1);
  }

  await connectDb();
  console.log("✅ Connected to MongoDB");

  let user = await User.findOne({ email });
  const hash = await bcrypt.hash(newPassword, 10);

  if (!user) {
    console.log(`⚠️ User not found. Creating new ADMIN user: ${email}`);
    user = new User({
      email,
      username: email.split("@")[0],
      passwordHash: hash,
      role: "ADMIN",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await user.save();
    console.log(`✅ Created new ADMIN user: ${email}`);
  } else {
    user.set("passwordHash", hash);
    await user.save();
    console.log(`✅ Password updated for: ${email}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
