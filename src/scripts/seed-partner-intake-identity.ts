// apps/backend/src/scripts/seed-partner-intake-identity.ts
//
// The "Partner Intake" system user: the one requester (and approver) of every
// partner lead case (services/partnerIntake.create.ts). Modelled on the System
// Intake user (scripts/seed-intake-system-identities.ts):
//   - lives in the HOUSE workspace, role SYSTEM_PARTNER_INTAKE;
//   - a random password nobody is told, so it never logs in;
//   - its address is dropped from every approval email's recipients
//     (services/approvalEmails/dispatch.ts), so nothing is ever sent to it.
// The student's own contact details go on the case (meta.partnerLead.contact),
// never here.
//
// Idempotent: matched on the email. A re-run reports the existing user and
// changes nothing. DRY RUN by default; --apply creates it.
//
//   npx tsx src/scripts/seed-partner-intake-identity.ts --expect-db=<db> [--apply]
import "dotenv/config";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User from "../models/User.js";
import { PARTNER_INTAKE_EMAIL, PARTNER_INTAKE_NAME, PARTNER_INTAKE_ROLE } from "../services/partnerLeadCase.js";

const HOUSE_CUSTOMER_WORKSPACE_ID = "69679a7628330a58d29f2254";

export async function seedPartnerIntakeIdentity(opts: {
  expectDb?: string;
  apply: boolean;
  log?: (line: string) => void;
}): Promise<{ db: string; existed: boolean; created: boolean; userId: string | null }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  log(`db ${db} · ${opts.apply ? "APPLY" : "DRY RUN"}`);

  const existing: any = await User.findOne({ email: PARTNER_INTAKE_EMAIL }).select("_id roles status").lean();
  if (existing) {
    log(`Partner Intake user already exists: ${String(existing._id)} (roles ${JSON.stringify(existing.roles)}, status ${existing.status})`);
    return { db, existed: true, created: false, userId: String(existing._id) };
  }
  if (!opts.apply) {
    log(`Partner Intake user (${PARTNER_INTAKE_EMAIL}) is missing → would create. Re-run with --apply.`);
    return { db, existed: false, created: false, userId: null };
  }
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
  const user: any = await User.create({
    email: PARTNER_INTAKE_EMAIL,
    officialEmail: PARTNER_INTAKE_EMAIL,
    workspaceId: HOUSE_CUSTOMER_WORKSPACE_ID,
    name: PARTNER_INTAKE_NAME,
    passwordHash,
    roles: [PARTNER_INTAKE_ROLE],
    status: "ACTIVE",
  });
  log(`Created Partner Intake user: ${String(user._id)}`);
  return { db, existed: false, created: true, userId: String(user._id) };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
    await seedPartnerIntakeIdentity({ expectDb, apply: process.argv.includes("--apply") });
  } finally {
    await mongoose.disconnect();
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/seed-partner-intake-identity.ts");
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
