// apps/backend/src/seed/seed-expense-engine-dev.ts
//
// RERUNNABLE local seed for QC-ing the EXPENSE APPROVAL ENGINE.
//   pnpm -C apps/backend seed:expenses
//
// Stands up one workspace ("Plum Test Co") with a rank table, a spread of
// approvers whose effective limits come from different inputs (rank default
// vs personal grant — including two people at the SAME rank with DIFFERENT
// personal limits), a finance person, two ordinary employees with line
// managers, expense categories, and the rulebook: Approval Bot ON at ₹2,000,
// Travel counting ×2. The ENGINE SWITCH IS LEFT OFF — turning it on from the
// Team › "Rulebook & engine" screen is the first QC step.
//
// Same safety shape as seed-dev.ts: refuses any non-local MONGO_URI, deletes
// only this workspace's own rows, safe to run again and again.

import "../bootstrap/loadSecrets.js";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { assertLocalDatabase } from "./assertLocalDatabase.js";

import Customer from "../models/Customer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import User from "../models/User.js";
import Department from "../models/Department.js";
import ExpenseBand from "../models/ExpenseBand.js";
import ExpenseCategory from "../models/ExpenseCategory.js";
import ExpenseApproverGrant from "../models/ExpenseApproverGrant.js";
import ExpenseApprovalPolicy from "../models/ExpenseApprovalPolicy.js";
import Expense from "../models/Expense.js";
import Report from "../models/Report.js";
import ExpenseAdvance from "../models/ExpenseAdvance.js";
import ExpenseActivity from "../models/ExpenseActivity.js";
import { upsertGrant } from "../services/expenseGrants.service.js";
import { updatePolicy } from "../services/expensePolicy.service.js";

// Fixed so a re-seed finds and tears down the previous run (see seed-dev.ts
// on why this must be a real ObjectId — CustomerWorkspace.customerId is read
// as a Customer._id).
const CUSTOMER_ID = "e0e0e0e0e0e0e0e0e0e0e0e1";
const CUSTOMER_LEGAL_NAME = "Plum Test Co Private Limited";
const WORKSPACE_SLUG = "plum-test-co";
const PASSWORD = "Passw0rd!";
const DOMAIN = "plumtest.test";

type Person = {
  key: string;
  first: string;
  last: string;
  roles: string[];
  memberRole: "WORKSPACE_LEADER" | "REQUESTER";
  bandNumber: number | null;
  department: string;
  managerKey?: string;
  grant?: { approver?: boolean; limitBase?: number | null; finance?: boolean };
  note: string;
};

// Rank table: the DEFAULT approval limit for everyone at that rank.
const RANKS = [
  { bandNumber: 2, bandName: "Associate", defaultApprovalLimitBase: null },
  { bandNumber: 4, bandName: "Manager", defaultApprovalLimitBase: 50_000 },
  { bandNumber: 6, bandName: "Senior Manager", defaultApprovalLimitBase: 100_000 },
  { bandNumber: 8, bandName: "Director", defaultApprovalLimitBase: 500_000 },
];

const PEOPLE: Person[] = [
  { key: "lena", first: "Lena", last: "Kapoor", roles: ["CUSTOMER", "WORKSPACE_LEADER"], memberRole: "WORKSPACE_LEADER", bandNumber: null, department: "Finance", note: "workspace leader = expense admin (structural role); no rank, not an approver" },
  { key: "meera", first: "Meera", last: "Iyer", roles: ["CUSTOMER"], memberRole: "REQUESTER", bandNumber: 4, department: "Engineering", grant: { approver: true }, note: "L4 Manager · approver · effective ₹50,000 from the RANK DEFAULT" },
  { key: "priya", first: "Priya", last: "Nair", roles: ["CUSTOMER"], memberRole: "REQUESTER", bandNumber: 4, department: "Sales", grant: { approver: true, limitBase: 80_000 }, note: "L4 Manager (SAME rank as Meera) · approver · personal ₹80,000 beats the ₹50,000 default" },
  { key: "lata", first: "Lata", last: "Singh", roles: ["CUSTOMER"], memberRole: "REQUESTER", bandNumber: 2, department: "Engineering", grant: { approver: true, limitBase: 20_000 }, note: "L2 Associate (no rank default) · approver · personal ₹20,000 — the LOW limit" },
  { key: "dev", first: "Dev", last: "Sharma", roles: ["CUSTOMER"], memberRole: "REQUESTER", bandNumber: 8, department: "Engineering", grant: { approver: true }, note: "L8 Director · approver · effective ₹5,00,000 from the rank default — the HIGH limit" },
  { key: "chitra", first: "Chitra", last: "Rao", roles: ["CUSTOMER"], memberRole: "REQUESTER", bandNumber: 8, department: "Finance", grant: { approver: true, limitBase: 2_000_000 }, note: "L8 Director (same rank as Dev) · approver · personal ₹20,00,000 — top of the chain" },
  { key: "farah", first: "Farah", last: "Khan", roles: ["CUSTOMER"], memberRole: "REQUESTER", bandNumber: 6, department: "Finance", grant: { finance: true }, note: "L6 Senior Manager · FINANCE (pays claims) · not an approver" },
  { key: "arjun", first: "Arjun", last: "Nair", roles: ["CUSTOMER"], memberRole: "REQUESTER", bandNumber: 2, department: "Engineering", managerKey: "meera", note: "employee · reports to Meera · submits claims" },
  { key: "kavya", first: "Kavya", last: "Menon", roles: ["CUSTOMER"], memberRole: "REQUESTER", bandNumber: 2, department: "Sales", managerKey: "priya", note: "employee · reports to Priya · submits claims" },
];

const CATEGORIES = ["Travel", "Meals", "Office supplies", "Entertainment"];

async function main() {
  const uri = env.MONGO_URI;
  assertLocalDatabase(uri);
  await mongoose.connect(uri);
  console.log(`[seed:expenses] connected to ${uri} (db: ${mongoose.connection.name})`);

  /* ── Teardown, scoped to this seed's own workspace ─────────────────── */
  const existing: any = await CustomerWorkspace.findOne({ customerId: CUSTOMER_ID }).lean();
  if (existing) {
    const wsId = existing._id;
    const removed = await Promise.all([
      ExpenseActivity.collection.deleteMany({ workspaceId: wsId }), // append-only model: raw collection
      Expense.deleteMany({ workspaceId: wsId }),
      Report.deleteMany({ workspaceId: wsId }),
      ExpenseAdvance.deleteMany({ workspaceId: wsId }),
      ExpenseApproverGrant.deleteMany({ workspaceId: wsId }),
      ExpenseApprovalPolicy.deleteMany({ workspaceId: wsId }),
      ExpenseBand.deleteMany({ workspaceId: wsId }),
      ExpenseCategory.deleteMany({ workspaceId: wsId }),
      Department.deleteMany({ workspaceId: wsId }),
      User.deleteMany({ workspaceId: wsId }),
      CustomerMember.deleteMany({ customerId: CUSTOMER_ID }),
      CustomerWorkspace.deleteOne({ _id: wsId }),
    ]);
    const total = removed.reduce((n, r: any) => n + (r.deletedCount ?? 0), 0);
    console.log(`[seed:expenses] cleared ${total} existing doc(s) for customerId=${CUSTOMER_ID}`);
  }

  /* ── Customer + workspace (expenses + advances ON, base currency INR) ── */
  await Customer.deleteMany({ legalName: CUSTOMER_LEGAL_NAME });
  await Customer.create({ _id: new mongoose.Types.ObjectId(CUSTOMER_ID), legalName: CUSTOMER_LEGAL_NAME, isActive: true } as any);
  const workspace: any = await CustomerWorkspace.create({
    customerId: CUSTOMER_ID,
    slug: WORKSPACE_SLUG,
    companyName: "Plum Test Co",
    status: "ACTIVE",
    accessMode: "INVITE_ONLY",
    config: {
      baseCurrency: "INR",
      features: { expensesEnabled: true, advancesEnabled: true, approvalFlowEnabled: true },
    },
  } as any);
  const wsId = workspace._id;
  console.log(`[seed:expenses] workspace "Plum Test Co" (${wsId}), base currency INR`);

  /* ── Departments ────────────────────────────────────────────────────── */
  const deptByName = new Map<string, any>();
  for (const name of ["Engineering", "Sales", "Finance"]) {
    deptByName.set(name, await Department.create({ workspaceId: wsId, name, isActive: true } as any));
  }

  /* ── People ─────────────────────────────────────────────────────────── */
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const userByKey = new Map<string, any>();
  for (const p of PEOPLE) {
    const email = `${p.key}@${DOMAIN}`;
    const u = await User.create({
      email,
      passwordHash,
      firstName: p.first,
      lastName: p.last,
      name: `${p.first} ${p.last}`,
      roles: p.roles,
      workspaceId: wsId,
      customerId: CUSTOMER_ID,
      businessId: CUSTOMER_ID,
      department: p.department, // free-text name → the engine resolves it to the Department row
      bandNumber: p.bandNumber,
      isActive: true,
      status: "ACTIVE",
    } as any);
    userByKey.set(p.key, u);
  }
  // Line managers (User.managerId is what routing reads).
  for (const p of PEOPLE) {
    if (!p.managerKey) continue;
    const mgr = userByKey.get(p.managerKey);
    await User.updateOne({ _id: userByKey.get(p.key)._id }, { $set: { managerId: mgr._id, managerName: `${mgr.firstName} ${mgr.lastName}` } });
  }
  await CustomerMember.insertMany(
    PEOPLE.map((p) => ({ customerId: CUSTOMER_ID, email: `${p.key}@${DOMAIN}`, name: `${p.first} ${p.last}`, role: p.memberRole, isActive: true, travelerId: "" })) as any,
  );

  /* ── Rank table ─────────────────────────────────────────────────────── */
  await ExpenseBand.insertMany(RANKS.map((r) => ({ workspaceId: wsId, ...r })) as any);

  /* ── Grants (approver flag / personal limit / finance) — through the real
   *    service so history + the same validation as the console apply. ── */
  const lena = userByKey.get("lena");
  for (const p of PEOPLE) {
    if (!p.grant) continue;
    await upsertGrant({ workspaceId: wsId, userId: userByKey.get(p.key)._id, patch: p.grant, actorId: lena._id, reason: "seed:expenses" });
  }

  /* ── Categories + rulebook (engine OFF) ─────────────────────────────── */
  const catByName = new Map<string, any>();
  for (const name of CATEGORIES) catByName.set(name, await ExpenseCategory.create({ workspaceId: wsId, name, active: true } as any));
  await updatePolicy({
    workspaceId: wsId,
    actorId: lena._id,
    patch: {
      engineEnabled: false,
      bot: { enabled: true, thresholdBase: 2000 },
      categoryRules: [{ categoryId: String(catByName.get("Travel")._id), weight: 2 }],
    },
  });

  /* ── Report ─────────────────────────────────────────────────────────── */
  console.log("");
  console.log("Logins (password for everyone: " + PASSWORD + ")");
  for (const p of PEOPLE) console.log(`  ${(p.key + "@" + DOMAIN).padEnd(24)} ${(p.first + " " + p.last).padEnd(14)} ${p.note}`);
  console.log("");
  console.log("Rank defaults: " + RANKS.map((r) => `L${r.bandNumber} ${r.bandName} = ${r.defaultApprovalLimitBase == null ? "none" : "₹" + r.defaultApprovalLimitBase.toLocaleString("en-IN")}`).join(" · "));
  console.log("Rulebook: Approval Bot ON at ₹2,000 · Travel counts ×2 · ENGINE SWITCH OFF (turn it on from Team › Rulebook & engine)");
  console.log("Categories: " + CATEGORIES.join(", "));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("[seed:expenses] FAILED:", e?.message || e);
  process.exit(1);
});
