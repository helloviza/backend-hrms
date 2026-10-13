// apps/backend/src/migrations/2026-07-26-backfill-cstep-traveller-logins.ts
//
// Backfills a workspace login for existing CSTEP TravellerProfiles that
// predate the "auto-create login on traveller add" feature (routes/
// workspace.travellers.ts's ensureCstepTravellerLogin, wired into POST /
// and the bulk-import commit path). Travellers added before that change
// (e.g. Imran Ali, CSTEP-003) have no User document, so they don't appear
// in the Approver/Official user/Finance user dropdowns (which read from
// User.find({workspaceId}) — GET /tour-approver-candidates) and can't file
// for themselves.
//
// Reuses the EXACT same helper the live "add traveller" flow now uses —
// ensureCstepTravellerLogin (which itself calls customerUsers.ts's
// ensureAuthUserForCustomer) — imported directly from routes/workspace.
// travellers.ts. No second account-creation path is written here. The one
// difference from a live traveller-add: this migration always passes
// `sendInvite: false` (an additive opt-out parameter added to
// ensureCstepTravellerLogin specifically for this migration — the single
// Add Traveller / Bulk Import call sites don't pass it, so they keep
// sending invite emails exactly as before). A one-time backfill over
// potentially many already-active people should not re-invite them by
// email — they should use the existing, working Forgot Password flow
// (POST /auth/forgot-password) to set a real password the first time they
// need to log in; see this migration's Step-0 write-up in conversation for
// why that path was chosen over the (currently dead-end) "customer_invite"
// magic link.
//
// What it does, per active TravellerProfile with a non-empty email, in a
// target workspace:
//   1. Already claimedBy someone -> SKIP (never touched; a different login
//      is already linked, or this migration already ran and linked one).
//   2. No email -> SKIP.
//   3. Otherwise -> ensureCstepTravellerLogin({ ..., sendInvite: false }).
//      Idempotent: if a User already exists for this email in the
//      workspace, it's reused (no duplicate, no email) and just linked;
//      only a genuinely new email gets a brand-new User (random temp
//      password, same as the live flow — recoverable via Forgot Password).
//      claimedBy/claimedAt are set on the profile only when a userId comes
//      back (never overwriting an existing different claim, matching #1).
//
// Target workspace(s):
//   --workspaceId=<CustomerWorkspace._id>   scope to exactly one workspace
//   (no flag)                                every workspace with
//                                             config.features.cstepEnabled
//                                             === true
//
// Dry-run by default — prints what WOULD happen (create / link-existing /
// skip-already-linked / skip-no-email / skip-conflict) without writing
// anything. Safe to run repeatedly; idempotent even under --apply (a
// second run finds every previously-linked profile already claimedBy and
// skips it).
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/2026-07-26-backfill-cstep-traveller-logins.ts                                   # dry-run, all cstepEnabled workspaces
//   pnpm -C apps/backend tsx src/migrations/2026-07-26-backfill-cstep-traveller-logins.ts --workspaceId=<id>                 # dry-run, one workspace
//   pnpm -C apps/backend tsx src/migrations/2026-07-26-backfill-cstep-traveller-logins.ts --apply                           # write, all cstepEnabled workspaces
//   pnpm -C apps/backend tsx src/migrations/2026-07-26-backfill-cstep-traveller-logins.ts --workspaceId=<id> --apply        # write, one workspace
//
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import TravellerProfile from "../models/TravellerProfile.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import { normalizeEmail } from "../utils/travellerMatch.js";
import { ensureCstepTravellerLogin } from "../routes/workspace.travellers.js";

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply");
const workspaceIdArg = args.find((a) => a.startsWith("--workspaceId="))?.split("=")[1] || null;

type Candidate = {
  workspaceId: string;
  customerId: string;
  travellerDocId: string;
  travelerCode: string;
  name: string;
  email: string;
};

type SkipRow = { workspaceId: string; travelerCode: string; name: string; email?: string; reason: string };

/**
 * READ-ONLY preview of what ensureAuthUserForCustomer (called via
 * ensureCstepTravellerLogin) would do for this email — mirrors its own
 * scoped-then-global lookup exactly, but never writes anything. Used only
 * to make the dry-run report accurate; --apply never calls this, it always
 * calls the real, unmodified helper, so actual behavior is guaranteed
 * identical to the live traveller-add flow regardless of what this
 * predicts.
 */
async function previewLoginOutcome(
  email: string,
  customerId: string,
): Promise<"will-create" | "will-link-existing" | "will-conflict"> {
  const scoped = await User.findOne({
    $or: [{ email }, { officialEmail: email }, { personalEmail: email }],
    customerId,
  })
    .select("_id")
    .lean();
  if (scoped) return "will-link-existing";

  const global = await User.findOne({
    $or: [{ email }, { officialEmail: email }, { personalEmail: email }],
  })
    .select("_id customerId")
    .lean();
  if (!global) return "will-create";
  if ((global as any).customerId && String((global as any).customerId) !== String(customerId)) {
    return "will-conflict";
  }
  return "will-link-existing"; // orphaned match (no customerId yet) — safe to adopt
}

async function main() {
  console.log("=== Backfill CSTEP traveller logins migration ===");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "APPLY"}`);
  console.log(workspaceIdArg ? `Scope: single workspace ${workspaceIdArg}` : "Scope: all workspaces with config.features.cstepEnabled=true");
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    let workspaces: any[];
    if (workspaceIdArg) {
      if (!mongoose.Types.ObjectId.isValid(workspaceIdArg)) {
        console.error(`FATAL: --workspaceId=${workspaceIdArg} is not a valid ObjectId.`);
        process.exit(1);
      }
      const ws = await CustomerWorkspace.findById(workspaceIdArg)
        .select("_id customerId companyName config.features")
        .lean();
      if (!ws) {
        console.error(`FATAL: workspace ${workspaceIdArg} not found.`);
        process.exit(1);
      }
      workspaces = [ws];
    } else {
      workspaces = await CustomerWorkspace.find({ "config.features.cstepEnabled": true })
        .select("_id customerId companyName config.features")
        .lean();
    }

    console.log(`Found ${workspaces.length} target workspace(s).`);
    for (const ws of workspaces as any[]) {
      console.log(`  - ${ws.companyName || "(no name)"} (_id=${ws._id}, customerId=${ws.customerId || "(none)"})`);
    }
    console.log("");

    const candidates: Candidate[] = [];
    const skipNoEmail: SkipRow[] = [];
    const skipAlreadyLinked: SkipRow[] = [];

    for (const ws of workspaces as any[]) {
      const workspaceId = String(ws._id);
      const customerId = String(ws.customerId || "");

      if (!customerId) {
        console.warn(`  [SKIP WORKSPACE] ${ws.companyName || workspaceId}: no customerId set — cannot provision logins.`);
        continue;
      }

      const travellers = await TravellerProfile.find({
        workspaceId: ws._id,
        isActive: true,
        email: { $exists: true, $nin: ["", null] },
      })
        .select("_id travelerId firstName lastName email claimedBy")
        .lean();

      for (const t of travellers as any[]) {
        const travelerCode = t.travelerId || "(no code)";
        const name = [t.firstName, t.lastName].filter(Boolean).join(" ") || "(unnamed)";
        const email = normalizeEmail(t.email);

        if (!email) {
          skipNoEmail.push({ workspaceId, travelerCode, name, reason: "No email" });
          continue;
        }
        if (t.claimedBy) {
          skipAlreadyLinked.push({ workspaceId, travelerCode, name, email, reason: "Already linked (claimedBy set)" });
          continue;
        }

        candidates.push({
          workspaceId,
          customerId,
          travellerDocId: String(t._id),
          travelerCode,
          name,
          email,
        });
      }
    }

    console.log(`Active travellers with an email, not yet linked: ${candidates.length}`);
    console.log(`Already linked (skipped):                        ${skipAlreadyLinked.length}`);
    console.log(`No email (skipped):                               ${skipNoEmail.length}`);
    console.log("");

    if (DRY_RUN) {
      let willCreate = 0;
      let willLink = 0;
      let willConflict = 0;

      console.log("Preview (read-only — no writes in dry-run):");
      console.log("-".repeat(90));
      for (const c of candidates) {
        const outcome = await previewLoginOutcome(c.email, c.customerId);
        if (outcome === "will-create") willCreate++;
        else if (outcome === "will-link-existing") willLink++;
        else willConflict++;

        const label =
          outcome === "will-create"
            ? "CREATE new login"
            : outcome === "will-link-existing"
              ? "LINK existing login"
              : "CONFLICT — email belongs to a different workspace, will NOT link";

        console.log(`  [${c.travelerCode}] ${c.name} <${c.email}> — ${label}`);
      }
      console.log("-".repeat(90));
      console.log("");

      for (const s of skipAlreadyLinked) {
        console.log(`  [SKIP] [${s.travelerCode}] ${s.name} <${s.email}> — ${s.reason}`);
      }
      for (const s of skipNoEmail) {
        console.log(`  [SKIP] [${s.travelerCode}] ${s.name} — ${s.reason}`);
      }
      console.log("");

      console.log(
        `DRY RUN summary: ${willCreate} new login(s) would be created, ${willLink} existing login(s) would be linked, ` +
          `${willConflict} would conflict and be skipped, ${skipAlreadyLinked.length} already linked, ${skipNoEmail.length} have no email.`,
      );
      console.log("No invite emails are ever sent by this migration (sendInvite: false).");
      console.log("Re-run with --apply to write these changes.");
      return;
    }

    // ── APPLY ──
    let created = 0;
    let linkedExisting = 0;
    let conflicts = 0;
    let failures = 0;

    console.log("Applying...");
    console.log("-".repeat(90));
    for (const c of candidates) {
      try {
        const result = await ensureCstepTravellerLogin({
          email: c.email,
          name: c.name,
          customerId: c.customerId,
          workspaceId: new mongoose.Types.ObjectId(c.workspaceId),
          sendInvite: false, // backfill — never emails existing people
        });

        if (!result.userId) {
          conflicts++;
          console.log(`  [${c.travelerCode}] ${c.name} <${c.email}> — NOT LINKED: ${result.note || "unknown reason"}`);
          continue;
        }

        await TravellerProfile.updateOne(
          { _id: c.travellerDocId, claimedBy: { $exists: false } }, // re-check at write time — never clobber a claim set since the scan
          { $set: { claimedBy: result.userId, claimedAt: new Date() } },
        );

        if (result.created) {
          created++;
          console.log(`  [${c.travelerCode}] ${c.name} <${c.email}> — CREATED new login and linked.`);
        } else {
          linkedExisting++;
          console.log(`  [${c.travelerCode}] ${c.name} <${c.email}> — LINKED existing login.`);
        }
      } catch (err: any) {
        failures++;
        console.error(`  [${c.travelerCode}] ${c.name} <${c.email}> — FAILED: ${err?.message || err}`);
      }
    }
    console.log("-".repeat(90));
    console.log("");
    console.log(
      `APPLY complete. created=${created} linkedExisting=${linkedExisting} conflicts=${conflicts} failures=${failures} ` +
        `alreadyLinkedSkipped=${skipAlreadyLinked.length} noEmailSkipped=${skipNoEmail.length}`,
    );
  } finally {
    await mongoose.connection.close();
  }
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
