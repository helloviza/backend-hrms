// apps/backend/src/scripts/set-manager.ts
import { connectDb } from "../config/db.js";
import User from "../models/User.js";

async function main() {
  const employeeEmail = process.argv[2];
  const managerEmail = process.argv[3];

  if (!employeeEmail || !managerEmail) {
    console.log("Usage: pnpm tsx src/scripts/set-manager.ts <employeeEmail> <managerEmail>");
    console.log('Example: pnpm tsx src/scripts/set-manager.ts "e1@plumtrips.com" "mgr1@plumtrips.com"');
    process.exit(1);
  }

  await connectDb();
  console.log("✅ Connected to MongoDB");

  let emp = await User.findOne({ email: employeeEmail });
  let mgr = await User.findOne({ email: managerEmail });

  // 🧩 Auto-create manager if missing
  if (!mgr) {
    console.log(`⚠️ Manager not found. Creating new manager user: ${managerEmail}`);
    mgr = new User({
      email: managerEmail,
      username: managerEmail.split("@")[0],
      name: managerEmail.split("@")[0],
      displayName: managerEmail.split("@")[0],
      roles: ["MANAGER"],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await mgr.save();
    console.log(`✅ Created manager: ${managerEmail}`);
  }

  // 🧩 Auto-create employee if missing
  if (!emp) {
    console.log(`⚠️ Employee not found. Creating new employee user: ${employeeEmail}`);
    emp = new User({
      email: employeeEmail,
      username: employeeEmail.split("@")[0],
      name: employeeEmail.split("@")[0],
      displayName: employeeEmail.split("@")[0],
      roles: ["EMPLOYEE"],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await emp.save();
    console.log(`✅ Created employee: ${employeeEmail}`);
  }

  // 🧩 Assign manager
  // 🧩 Assign manager safely (ignore strict TS typing)
  const empDoc: any = emp;
  empDoc.managerId = mgr._id;
  empDoc.updatedAt = new Date();
  await empDoc.save();

  console.log("✔ Manager assigned:", {
    employee: { email: empDoc.email, id: empDoc._id.toString() },
    manager: { email: mgr.email, id: mgr._id.toString() },
  });

  process.exit(0);

}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
