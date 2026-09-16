// apps/backend/src/scripts/migrate-expense-capabilities-to-grants-2026-09-16.ts
//
// ONE-TIME, DELIVERED NOT RUN: move the expense capabilities that today live
// as literal `FINANCE` / `ADMIN` tokens in User.roles[] into the per-person
// grant store (models/ExpenseApproverGrant.ts) — approval-engine sub-step 1,
// audit F-01 + F-21.
//
//   pnpm -C apps/backend tsx src/scripts/migrate-expense-capabilities-to-grants-2026-09-16.ts
//   pnpm -C apps/backend tsx src/scripts/migrate-expense-capabilities-to-grants-2026-09-16.ts --apply
//
// DRY RUN BY DEFAULT. Nothing is written without `--apply`.
//
// ── WHAT IT DOES ─────────────────────────────────────────────────────────
// For every user (any workspace) whose roles[] carries FINANCE and/or the
// bare ADMIN token:
//   • upsert an ExpenseApproverGrant { finance: hasFINANCE, expenseAdmin:
//     hasADMIN } (never lowering a capability an existing grant already has);
//   • $pull the FINANCE token from roles[] — it is expense-local, nothing
//     outside the module reads it (middleware/roles.ts only declares it);
//   • LEAVE the ADMIN token in roles[]. Whether a given ADMIN is a legitimate
//     platform grant (HOUSE staff) or an F-01 escalation minted through the
//     expenses Team page is a decision this script cannot make; it only
//     makes sure nobody loses expense-admin when expense.access.ts stops
//     reading the token. The dry-run flags the suspicious shape — a
//     CUSTOMER-type account (CUSTOMER / WORKSPACE_LEADER / BUSINESS roles)
//     carrying ADMIN — so Imran can strip those by hand.
//
// Also handles CustomerWorkspace.config.seniorApproverId: a workspace that
// named a senior approver gets that person an `approver: true` grant, so the
// engine (next steps) inherits the intent. The scalar itself is removed in a
// later step, not here.
//
// Idempotent: re-running proposes nothing for users already migrated.

import "../bootstrap/loadSecrets.js";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import ExpenseApproverGrant from "../models/ExpenseApproverGrant.js";
import { upsertGrant } from "../services/expenseGrants.service.js";

const APPLY = process.argv.includes("--apply");
const norm = (v: any) => String(v ?? "").trim().toUpperCase().replace(/[\s\-_]/g, "");
const CUSTOMER_SHAPES = new Set(["CUSTOMER", "WORKSPACELEADER", "BUSINESS", "CLIENT", "CORPORATE"]);

function nameOf(u: any): string {
  return [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.name || u.email || String(u._id);
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGO_URI);
  console.log(`[migrate-expense-caps] ${APPLY ? "APPLY" : "DRY RUN"} — db: ${mongoose.connection.name}`);

  const wsNames = new Map<string, string>();
  for (const w of await CustomerWorkspace.find({}).select("_id name config.seniorApproverId").lean()) {
    wsNames.set(String(w._id), (w as any).name || String(w._id));
  }

  // ── Pass A: FINANCE / ADMIN tokens → grants ─────────────────────────
  const users: any[] = await User.find({ roles: { $in: [/^FINANCE$/i, /^ADMIN$/i] } })
    .select("_id email firstName lastName name roles userType accountType workspaceId status")
    .lean();

  let proposed = 0;
  let noWorkspace = 0;
  let suspicious = 0;
  console.log(`\n══ Pass A · ${users.length} user(s) carry FINANCE and/or ADMIN in roles[] ══`);
  for (const u of users) {
    const roles: string[] = Array.isArray(u.roles) ? u.roles : [];
    const normed = roles.map(norm);
    const hasFinance = normed.includes("FINANCE");
    const hasAdmin = normed.includes("ADMIN");
    const customerShape =
      normed.some((r) => CUSTOMER_SHAPES.has(r)) ||
      CUSTOMER_SHAPES.has(norm(u.userType)) ||
      CUSTOMER_SHAPES.has(norm(u.accountType));
    const ws = u.workspaceId ? String(u.workspaceId) : null;
    const flag = hasAdmin && customerShape ? "  !! SUSPICIOUS: customer-type account carrying platform ADMIN (F-01 shape)" : "";
    if (flag) suspicious++;

    if (!ws) {
      noWorkspace++;
      console.log(`  - ${nameOf(u)} <${u.email}> roles=[${roles.join(",")}] — NO workspaceId, skipped${flag}`);
      continue;
    }
    const existing: any = await ExpenseApproverGrant.findOne({ workspaceId: u.workspaceId, userId: u._id }).lean();
    const wantFinance = hasFinance || !!existing?.capabilities?.finance;
    const wantAdmin = hasAdmin || !!existing?.capabilities?.expenseAdmin;
    const change =
      !existing ||
      existing.active === false ||
      !!existing.capabilities?.finance !== wantFinance ||
      !!existing.capabilities?.expenseAdmin !== wantAdmin;

    console.log(
      `  - ${nameOf(u)} <${u.email}> · ${wsNames.get(ws) || ws} · status=${u.status || "?"} · roles=[${roles.join(",")}]` +
        `\n      → grant { finance: ${wantFinance}, expenseAdmin: ${wantAdmin} }${existing ? " (updates existing grant)" : " (new grant)"}` +
        `${hasFinance ? " · $pull FINANCE from roles[]" : ""}${hasAdmin ? " · ADMIN token LEFT in roles[] (platform decision)" : ""}${flag}`,
    );
    if (!change && !hasFinance) continue;
    proposed++;

    if (APPLY) {
      await upsertGrant({
        workspaceId: u.workspaceId,
        userId: u._id,
        actorId: null,
        reason: "Migration 2026-09-16: moved from User.roles[] (F-01/F-21)",
        patch: { finance: wantFinance, expenseAdmin: wantAdmin },
      });
      if (hasFinance) {
        await User.updateOne({ _id: u._id }, { $pull: { roles: { $in: roles.filter((r) => norm(r) === "FINANCE") } } });
      }
    }
  }

  // ── Pass B: seniorApproverId → approver grant ───────────────────────
  console.log(`\n══ Pass B · config.seniorApproverId → approver grant ══`);
  let seniors = 0;
  for (const w of await CustomerWorkspace.find({ "config.seniorApproverId": { $ne: null } })
    .select("_id name config.seniorApproverId")
    .lean()) {
    const sid = (w as any).config?.seniorApproverId;
    if (!sid) continue;
    const u: any = await User.findOne({ _id: sid, workspaceId: w._id }).select("email firstName lastName name").lean();
    if (!u) {
      console.log(`  - ${(w as any).name}: seniorApproverId ${sid} is not a user of this workspace — skipped`);
      continue;
    }
    seniors++;
    console.log(`  - ${(w as any).name}: ${nameOf(u)} <${u.email}> → grant { approver: true }`);
    if (APPLY) {
      await upsertGrant({
        workspaceId: w._id,
        userId: u._id,
        actorId: null,
        reason: "Migration 2026-09-16: was config.seniorApproverId",
        patch: { approver: true },
      });
    }
  }

  console.log(
    `\n${APPLY ? "WROTE" : "WOULD WRITE"} ${proposed} grant(s) from roles[] + ${seniors} approver grant(s)` +
      `${noWorkspace ? ` · ${noWorkspace} user(s) skipped (no workspaceId)` : ""}` +
      `${suspicious ? ` · ${suspicious} SUSPICIOUS ADMIN holder(s) flagged for manual review` : ""}.`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[migrate-expense-caps] failed:", err?.message || err);
  process.exit(1);
});
