// apps/backend/src/scripts/create-tbo-cert-user.ts
// One-off script: create temporary TBO certification reviewer account
import bcrypt from "bcryptjs";
import { connectDb } from "../config/db.js";
import User from "../models/User.js";

const EMAIL = "tbocertification@plumtrips.com";
const PASSWORD = "TB@Certific@ti0n";
const NAME = "TBO Certification";

async function main() {
  await connectDb();
  console.log("Connected to MongoDB");

  const existing = await User.findOne({ email: EMAIL });
  if (existing) {
    console.log(`User already exists: ${EMAIL} (_id: ${existing._id})`);
    process.exit(0);
  }

  const hash = await bcrypt.hash(PASSWORD, 10);

  const user = new User({
    email: EMAIL,
    username: "tbocertification",
    name: NAME,
    firstName: "TBO",
    lastName: "Certification",
    passwordHash: hash,
    roles: ["EMPLOYEE"],
    isActive: true,
    status: "ACTIVE",
    sbtEnabled: true,
    sbtBookingType: "both",
    sbtRole: "L2",
    canRaiseRequest: true,
    canViewBilling: false,
    canManageUsers: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await user.save();
  console.log(`User created: ${EMAIL}`);
  console.log(`_id: ${user._id}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
