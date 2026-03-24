import { connectDb } from "../config/db.js";
import User from "../models/User.js";

async function main() {
  await connectDb();
  const users = await User.find({});
  for (const u of users) {
    if (Array.isArray(u.roles)) {
      u.roles = u.roles.map((r: string) => r.toUpperCase());
      await u.save();
      console.log(`✔ Updated ${u.email} roles → ${u.roles}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
