// apps/backend/src/scripts/set-profile.ts
import bcrypt from "bcryptjs";
import { connectDb } from "../config/db.js";
import User from "../models/User.js";

async function main() {
  const email = process.argv[2];
  const name = process.argv[3];
  const roles = (process.argv[4] || "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  if (!email || !name) {
    console.log("Usage: pnpm tsx src/scripts/set-profile.ts <email> <name> [rolesCsv]");
    console.log('Example: pnpm tsx src/scripts/set-profile.ts "me@plumtrips.com" "Aarav Patel" Employee');
    console.log('         pnpm tsx src/scripts/set-profile.ts "mgr1@plumtrips.com" "Priya Singh" Manager,Employee');
    process.exit(1);
  }

  await connectDb();
  console.log("✅ Connected to MongoDB");

  let u = await User.findOne({ email });

  // 🧩 Auto-create if missing
  if (!u) {
    console.log(`⚠️ User not found. Creating new profile for ${email}`);
    const defaultPassword = "Welcome@2025";
    const hash = await bcrypt.hash(defaultPassword, 10);

    u = new User({
      email,
      username: email.split("@")[0],
      name,
      displayName: name,
      roles: roles.length ? roles : ["EMPLOYEE"],
      passwordHash: hash,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await u.save();
    console.log(`✅ Created new user with default password: ${defaultPassword}`);
  } else {
    // 🧩 Update existing user
    u.set("name", name);
    u.set("displayName", name);
    if (roles.length) u.set("roles", roles);
    await u.save();
    console.log("✅ Updated existing user:", email);
  }

  const uu: any = u;
  console.log("✔ Final profile:", {
    id: uu._id?.toString(),
    email: uu.email,
    name: uu.name ?? uu.displayName ?? "",
    roles: uu.roles,
  });

  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});
