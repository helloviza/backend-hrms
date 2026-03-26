import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx tsx src/scripts/check-user.ts <email>");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI!);
  const db = mongoose.connection.db!;

  const user: any = await db.collection("users").findOne(
    { email: email.trim().toLowerCase() },
    {
      projection: {
        email: 1, roles: 1, role: 1,
        hrmsAccessLevel: 1, hrmsAccessRole: 1,
        sbtEnabled: 1, sbtRole: 1,
        customerId: 1, businessId: 1,
        userType: 1, accountType: 1,
        canRaiseRequest: 1,
      },
    },
  );

  if (!user) {
    console.log(`No user found with email: ${email}`);
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`\nUser: ${user.email}\n`);
  const fields: [string, any][] = [
    ["email",            user.email],
    ["roles",            (user.roles || []).join(", ")],
    ["role",             user.role || "—"],
    ["hrmsAccessLevel",  user.hrmsAccessLevel || "—"],
    ["hrmsAccessRole",   user.hrmsAccessRole || "—"],
    ["sbtEnabled",       user.sbtEnabled ?? "—"],
    ["sbtRole",          user.sbtRole || "—"],
    ["customerId",       user.customerId || "—"],
    ["businessId",       user.businessId || "—"],
    ["userType",         user.userType || "—"],
    ["accountType",      user.accountType || "—"],
    ["canRaiseRequest",  user.canRaiseRequest ?? "—"],
  ];
  for (const [key, val] of fields) {
    console.log(`  ${key.padEnd(20)} ${val}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
