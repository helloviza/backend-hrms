// apps/backend/src/scripts/report-user-name-sources.ts
//
// READ-ONLY. For one email, prints every place a person's name can come from,
// and what each screen shows:
//   • User: name, firstName, middleName, lastName, fullName (every User row with
//     that email — duplicates are listed, see the login-shadowing note)
//   • the profile page (GET /users/profile): name || firstName || email local part
//   • Employee rows (HR records): name, fullName, firstName, lastName
//   • the claimed TravellerProfile name (My Profile)
//   • the shared resolver (services/actorNames.ts): personName, resolveRealName,
//     userNames — what the margins page, approvals, Travel Desk etc. show
// Emails are masked. Nothing is written.
//
//   npx tsx --env-file=.env src/scripts/report-user-name-sources.ts --expect-db=<db> --email=<email>
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User.js";
import Employee from "../models/Employee.js";
import TravellerProfile from "../models/TravellerProfile.js";
import { personName, resolveRealName, userNames } from "../services/actorNames.js";

const maskEmail = (e: unknown) => {
  const s = String(e || "");
  const [local, domain] = s.split("@");
  if (!domain) return s ? "***" : "";
  return `${local.slice(0, 2)}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
};
const show = (v: unknown) => (v === undefined ? "(absent)" : v === null ? "(null)" : JSON.stringify(v));

async function main() {
  const args = process.argv.slice(2);
  const expectDb = args.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const email = String(args.find((a) => a.startsWith("--email="))?.split("=")[1] || "").trim().toLowerCase();
  if (!email) throw new Error("--email=<email> is required");
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  const users = (await User.find({ $or: [{ email }, { officialEmail: email }] })
    .select("name firstName middleName lastName email officialEmail workspaceId roles createdAt")
    .sort({ createdAt: 1 })
    .lean()) as any[];
  console.log(`db: ${db} · email: ${maskEmail(email)} · User rows: ${users.length}${users.length > 1 ? " (DUPLICATES — login uses the older one)" : ""}`);
  if (!users.length) return;

  for (const u of users) {
    const id = String(u._id);
    console.log(`\n── User ${id} (created ${u.createdAt ? new Date(u.createdAt).toISOString() : "?"}, roles ${JSON.stringify(u.roles || [])})`);
    console.log(`  User.name         ${show(u.name)}`);
    console.log(`  User.firstName    ${show(u.firstName)}`);
    console.log(`  User.middleName   ${show(u.middleName)}`);
    console.log(`  User.lastName     ${show(u.lastName)}`);
    console.log(`  User.fullName     ${show([u.firstName, u.lastName].filter(Boolean).join(" ") || undefined)} (virtual: first + last)`);
    console.log(`  email / official  ${maskEmail(u.email)} / ${maskEmail(u.officialEmail)}`);
    console.log(`  Profile page      ${show(u.name || u.firstName || String(u.email || "").split("@")[0] || "")} (GET /users/profile: name || firstName || email)`);

    const emps = (await Employee.find({ $or: [{ ownerId: u._id }, { email }] }).select("name fullName firstName lastName ownerId").lean()) as any[];
    if (!emps.length) console.log("  Employee (HR)     none");
    for (const e of emps) {
      console.log(`  Employee ${String(e._id)}  name ${show(e.name)} · fullName ${show(e.fullName)} · first ${show(e.firstName)} · last ${show(e.lastName)}`);
    }

    const tps = (await TravellerProfile.find({ claimedBy: u._id }).select("firstName lastName claimedAt").lean()) as any[];
    if (!tps.length) console.log("  TravellerProfile  none claimed");
    for (const t of tps) console.log(`  TravellerProfile ${String(t._id)}  ${show([t.firstName, t.lastName].filter(Boolean).join(" "))}`);

    const real = await resolveRealName(u, { allowEmail: false });
    const names = await userNames([id]);
    console.log(`  resolver personName      ${show(personName(u))}`);
    console.log(`  resolver resolveRealName ${show(real.name)} (source ${real.source})`);
    console.log(`  resolver userNames(id)   ${show(names.get(id))}  ← margins page, approvals, Travel Desk, booking history`);
  }
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
