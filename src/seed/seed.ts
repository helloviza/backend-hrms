import bcrypt from "bcryptjs";
import User from "../models/User.js";
import { connectDb } from "../config/db.js";

async function run() {
  await connectDb();
  await User.deleteMany({});
  const mk = (email: string, roles: string[]) => ({
    email,
    passwordHash: bcrypt.hashSync("Pass@123", 12),
    firstName: email.split("@")[0],
    roles,
  });
  await User.insertMany([
    mk("admin@plumtrips.com", ["Admin"]),
    mk("hr1@plumtrips.com", ["HR"]),
    mk("hr2@plumtrips.com", ["HR"]),
    mk("mgr1@plumtrips.com", ["Manager"]),
    mk("mgr2@plumtrips.com", ["Manager"]),
    mk("mgr3@plumtrips.com", ["Manager"]),
    mk("e1@plumtrips.com", ["Employee"]),
    mk("e2@plumtrips.com", ["Employee"]),
    mk("e3@plumtrips.com", ["Employee"]),
    mk("e4@plumtrips.com", ["Employee"]),
    mk("e5@plumtrips.com", ["Employee"]),
  ]);
  console.log("Seeded users");
  process.exit(0);
}
run();
