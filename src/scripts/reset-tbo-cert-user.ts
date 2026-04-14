// apps/backend/src/scripts/reset-tbo-cert-user.ts
// One-off script: reset password and reactivate TBO certification account
import bcrypt from "bcryptjs";
import { connectDb } from "../config/db.js";
import User from "../models/User.js";

const EMAIL = "tbocertification@plumtrips.com";
const PASSWORD = "TB@Certific@ti0n";

async function main() {
  await connectDb();
  console.log("Connected to MongoDB");

  const hash = await bcrypt.hash(PASSWORD, 10);

  const result = await User.updateOne(
    { email: EMAIL },
    { $set: { passwordHash: hash, isActive: true, tempPassword: false } }
  );

  console.log("Updated:", result.modifiedCount);
  console.log("Hash:", hash);
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
