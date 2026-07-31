// apps/backend/src/scripts/lib/visaErasureCascade.ts
//
// Shared cascade logic for the two visa-module erasure entry points:
//   scripts/erase-visa-request.ts       — hard-deletes a whole case
//   scripts/erase-traveller-profile.ts  — erases a traveller's PII wherever
//                                          it lives, keeps the case skeleton
//
// Split out of both scripts (rather than duplicated, per seed-visa-rules.ts/
// purge-visa-seed.ts's convention of each script being self-contained) since
// the two entry points share the SAME document+S3+activity-log+
// ManualBooking-redaction cascade, just starting from a different root
// (requestId -> applicationIds vs travellerProfileId -> applicationIds).
//
// EVERY exported function here is a plain async function over the real
// Mongoose models — no CLI/argv/process.exit concerns live in this file,
// so it can be unit-tested with the same "spy on the real Model's static
// methods" convention already used across this codebase (see
// VisaApplication.test.ts, VisaActivityLog.test.ts).
//
// SPELLING HAZARD — read this before touching planCstepImpact() below.
// TravellerProfile / VisaApplication.travellerProfileId spell "traveller"
// with TWO Ls (the visa module's own convention throughout this codebase).
// CstepTravelRequest.travelerProfileId / CstepClaim.travelerProfileId spell
// it with ONE L (an existing, unrelated module's own field name — not
// something this file gets to rename). A `{ travelerProfileId }` object-
// shorthand inside planCstepImpact silently created its own same-named
// variable instead of referencing the function's `travellerProfileId`
// parameter — TypeScript did not catch it (both are valid identifiers), and
// it only surfaced as a `ReferenceError` at test time. Always write the
// CSTEP queries as `{ travelerProfileId: travellerProfileId }`, spelled out,
// never as shorthand — the mismatched spelling is exactly the trap
// shorthand hides.
import mongoose from "mongoose";
import * as readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import { env } from "../../config/env.js";
import VisaRequest from "../../models/VisaRequest.js";
import VisaApplication from "../../models/VisaApplication.js";
import VisaDocument from "../../models/VisaDocument.js";
import ManualBooking from "../../models/ManualBooking.js";
import TravellerProfile from "../../models/TravellerProfile.js";
import User from "../../models/User.js";
import CstepTravelRequest from "../../models/cstep/CstepTravelRequest.js";
import CstepClaim from "../../models/cstep/CstepClaim.js";
import { deleteObject } from "../../utils/s3Upload.js";

/* ─────────────────────────────────────────────────────────────────────
 * Guard 1 — model scope, same shape as seed-visa-rules.ts/purge-visa-seed.ts.
 * Every model either script touches must be listed here; importing (and
 * therefore being able to write to) anything else aborts loudly.
 * ───────────────────────────────────────────────────────────────────── */
export const VISA_ERASURE_ALLOWED_MODELS = [
  "VisaRequest",
  "VisaApplication",
  "VisaDocument",
  "VisaActivityLog",
  "ManualBooking",
  "TravellerProfile",
  "User",
  "CstepTravelRequest",
  "CstepClaim",
  "VisaErasureLog",
] as const;

export function assertModelScope(): void {
  const registered = mongoose.modelNames();
  const unexpected = registered.filter((name) => !(VISA_ERASURE_ALLOWED_MODELS as readonly string[]).includes(name));
  if (unexpected.length > 0) {
    console.error(
      `Refusing to run: this script may only touch ${VISA_ERASURE_ALLOWED_MODELS.join(", ")}, but ` +
        `additional model(s) are registered: ${unexpected.join(", ")}.`,
    );
    process.exit(1);
  }
}

export function targetInfo(): { host: string; db: string } {
  const url = new URL(env.MONGO_URI);
  return { host: url.hostname, db: url.pathname.replace(/^\//, "") || "(default)" };
}

/* ─────────────────────────────────────────────────────────────────────
 * Guard 2 — typed confirmation, same shape as seed-visa-rules.ts.
 * ───────────────────────────────────────────────────────────────────── */
export async function confirmDatabaseName(expectedDb: string): Promise<void> {
  if (process.argv.includes("--yes")) {
    console.log("--yes passed — skipping interactive confirmation.");
    return;
  }
  const rl = readline.createInterface({ input: rlInput, output: rlOutput });
  try {
    const answer = await rl.question(`Type the database name ("${expectedDb}") to proceed: `);
    if (answer.trim() !== expectedDb) {
      console.error("Aborted: input did not match the database name.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Guard 3 — actor verification. Both scripts are SUPERADMIN-only; since
 * neither runs behind an authenticated HTTP request, "SUPERADMIN" is
 * verified here against a real, current User document rather than trusted
 * from a CLI flag. Every erasure log row's actorUserId/actorEmail comes
 * from this, never from the raw --actor-email string.
 * ───────────────────────────────────────────────────────────────────── */
export class ActorNotSuperAdminError extends Error {}

export async function resolveSuperAdminActor(actorEmail: string): Promise<{ _id: mongoose.Types.ObjectId; email: string }> {
  const email = (actorEmail || "").trim().toLowerCase();
  if (!email) throw new ActorNotSuperAdminError("--actor-email is required");

  const user = await User.findOne({ email }).select("_id email roles").lean();
  if (!user) throw new ActorNotSuperAdminError(`No user found with email "${email}"`);

  const roles: string[] = Array.isArray((user as any).roles) ? (user as any).roles : [];
  if (!roles.includes("SUPERADMIN")) {
    throw new ActorNotSuperAdminError(`User "${email}" is not SUPERADMIN (roles: ${roles.join(", ") || "none"})`);
  }

  return { _id: (user as any)._id, email: (user as any).email };
}

/* ─────────────────────────────────────────────────────────────────────
 * Application discovery — the two different roots the two scripts start
 * cascading from.
 * ───────────────────────────────────────────────────────────────────── */
export async function findApplicationIdsForRequest(requestId: mongoose.Types.ObjectId | string): Promise<string[]> {
  const apps = await VisaApplication.find({ requestId }).select("_id").lean();
  return apps.map((a: any) => String(a._id));
}

export async function findApplicationIdsForTraveller(travellerProfileId: mongoose.Types.ObjectId | string): Promise<string[]> {
  const apps = await VisaApplication.find({ travellerProfileId }).select("_id").lean();
  return apps.map((a: any) => String(a._id));
}

/* ─────────────────────────────────────────────────────────────────────
 * Documents + S3 — plan (read-only) and execute (delete). S3 objects are
 * deleted BEFORE any Mongo row is touched, and if ANY key fails to delete
 * the whole step aborts before touching Mongo at all — the failure mode we
 * most want to avoid is a VisaDocument row gone while its passport image
 * is still sitting in S3, unreferenced and now undiscoverable by anything
 * that lists documents by applicationId.
 * ───────────────────────────────────────────────────────────────────── */
export interface DocumentsPlan {
  documentIds: string[];
  s3Keys: string[];
}

export async function planDocuments(applicationIds: string[]): Promise<DocumentsPlan> {
  if (applicationIds.length === 0) return { documentIds: [], s3Keys: [] };
  const docs = await VisaDocument.find({ applicationId: { $in: applicationIds } })
    .select("_id s3Key")
    .lean();
  return {
    documentIds: docs.map((d: any) => String(d._id)),
    s3Keys: docs.map((d: any) => d.s3Key).filter(Boolean),
  };
}

export interface DocumentsDeleteResult {
  documentsDeleted: number;
  s3KeysDeleted: string[];
}

export async function deleteDocumentsAndS3(applicationIds: string[]): Promise<DocumentsDeleteResult> {
  const { documentIds, s3Keys } = await planDocuments(applicationIds);
  if (documentIds.length === 0) return { documentsDeleted: 0, s3KeysDeleted: [] };

  const failures: Array<{ key: string; error: string }> = [];
  for (const key of s3Keys) {
    try {
      await deleteObject(key);
    } catch (err: any) {
      failures.push({ key, error: err?.message || String(err) });
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Aborting before any database write: ${failures.length} S3 object(s) failed to delete — ` +
        failures.map((f) => `${f.key} (${f.error})`).join("; "),
    );
  }

  const result = await VisaDocument.deleteMany({ _id: { $in: documentIds } });
  return { documentsDeleted: result.deletedCount ?? 0, s3KeysDeleted: s3Keys };
}

/* ─────────────────────────────────────────────────────────────────────
 * ManualBooking — REDACT, NEVER DELETE. Found via metadata.visaApplicationId
 * (a string copy, not a live ref — see services/visaBillingSync.ts), which
 * is why this cannot be a query keyed on travellerProfileId: that field
 * doesn't exist on ManualBooking at all.
 *
 * passengers[].passportNo/email/phone are stripped — nothing in India's GST
 * invoicing rules requires keeping a passport number or contact details on
 * an invoice-linked record. passengers[].name and everything under pricing/
 * itinerary/notes are left exactly as they are: GST retention applies to the
 * financial record, and the traveller's name on an invoice line is treated
 * here as financial/business data, not the kind of "erase on request" PII
 * item 3 is about — flagged in the dry-run plan as a residual, pending a
 * separate legal review, not silently decided by this script.
 * ───────────────────────────────────────────────────────────────────── */
export interface ManualBookingPlanEntry {
  manualBookingId: string;
  bookingRef: string;
  passengerName: string; // kept — flagged in the plan output, not erased here
}

export async function planManualBookings(applicationIds: string[]): Promise<ManualBookingPlanEntry[]> {
  if (applicationIds.length === 0) return [];
  const bookings = await ManualBooking.find({ "metadata.visaApplicationId": { $in: applicationIds } })
    .select("_id bookingRef passengers")
    .lean();
  return bookings.map((b: any) => ({
    manualBookingId: String(b._id),
    bookingRef: b.bookingRef,
    passengerName: b.passengers?.[0]?.name || "(unnamed)",
  }));
}

export async function redactManualBookings(applicationIds: string[]): Promise<number> {
  if (applicationIds.length === 0) return 0;
  const bookings = await ManualBooking.find({
    "metadata.visaApplicationId": { $in: applicationIds },
    piiRedactedAt: { $exists: false },
  }).select("_id passengers");

  let redacted = 0;
  for (const booking of bookings as any[]) {
    booking.passengers = (booking.passengers || []).map((p: any) => ({
      ...(p.toObject ? p.toObject() : p),
      passportNo: undefined,
      email: undefined,
      phone: undefined,
    }));
    booking.piiRedactedAt = new Date();
    await booking.save();
    redacted++;
  }
  return redacted;
}

/* ─────────────────────────────────────────────────────────────────────
 * VisaApplication scrub — used ONLY by scripts/erase-traveller-profile.ts,
 * against applications that are NOT being deleted (the case skeleton
 * survives — see that script's own header). Two things happen together in
 * one update, since both are "PII that lives directly on a surviving
 * application row":
 *
 *   - actionRequiredReason/actionRequiredSetAt/actionRequiredSetByUserId are
 *     nulled. actionRequiredReason is concierge-authored free text and
 *     frequently names the traveller — the exact same risk
 *     redactVisaActivityForApplications above already treats as
 *     unenumerable and wipes wholesale, just living on VisaApplication
 *     instead of VisaActivityLog this time. statusBeforeActionRequired and
 *     `status` itself are DELIBERATELY left alone — nulling those wasn't
 *     asked for, and would touch the application's lifecycle state rather
 *     than its PII. Known consequence: an application left in
 *     status "action_required" after this runs will show that status with
 *     no reason text — surfaced in the erasure report, not silently patched
 *     around here.
 *   - travellerProfileId is set to null and travellerErasedAt is stamped —
 *     see VisaApplication.ts's own field comments for why an explicit null
 *     + timestamp is used instead of leaving the reference dangling.
 * ───────────────────────────────────────────────────────────────────── */
export async function scrubApplicationsAfterTravellerErasure(applicationIds: string[]): Promise<number> {
  if (applicationIds.length === 0) return 0;
  const result = await VisaApplication.updateMany(
    { _id: { $in: applicationIds } },
    {
      $set: {
        travellerProfileId: null,
        travellerErasedAt: new Date(),
        actionRequiredReason: null,
        actionRequiredSetAt: null,
        actionRequiredSetByUserId: null,
      },
    },
  );
  return result.modifiedCount ?? 0;
}

/* ─────────────────────────────────────────────────────────────────────
 * CSTEP impact — REPORT ONLY. CstepTravelRequest.travelerProfileId and
 * CstepClaim.travelerProfileId are a documented SOFT reference from the
 * unrelated CSTEP Travel & Claim Portal (see those models' own file
 * headers) — no schema-level FK, and this erasure never writes to either
 * collection. Reported so an operator erasing a TravellerProfile isn't
 * surprised later when a CSTEP claim's traveller name silently stops
 * resolving.
 * ───────────────────────────────────────────────────────────────────── */
export interface CstepImpact {
  travelRequestCount: number;
  claimCount: number;
}

export async function planCstepImpact(travellerProfileId: mongoose.Types.ObjectId | string): Promise<CstepImpact> {
  const [travelRequestCount, claimCount] = await Promise.all([
    CstepTravelRequest.countDocuments({ travelerProfileId: travellerProfileId }),
    CstepClaim.countDocuments({ travelerProfileId: travellerProfileId }),
  ]);
  return { travelRequestCount, claimCount };
}

/**
 * Gates the --apply path for scripts/erase-traveller-profile.ts: if the
 * traveller has ANY CSTEP history, --apply alone is not enough — the
 * operator must have also passed --acknowledge-cstep-impact, proving they
 * saw the dry-run's CSTEP counts before proceeding. Never blocks outright —
 * the underlying erasure right doesn't disappear because of an unrelated
 * module's soft reference — it only requires the impact be read first.
 */
export function assertCstepImpactAcknowledged(impact: CstepImpact, acknowledged: boolean): void {
  const hasImpact = impact.travelRequestCount > 0 || impact.claimCount > 0;
  if (hasImpact && !acknowledged) {
    throw new Error(
      `This traveller has CSTEP Travel & Claim Portal history (${impact.travelRequestCount} travel request(s), ` +
        `${impact.claimCount} claim(s)) that will be left referencing a deleted profile. Re-run with ` +
        `--acknowledge-cstep-impact to proceed.`,
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Invariant — the check that caught the real orphans last time. Run at the
 * end of every real (--apply) erasure, not scoped to just the ids this run
 * touched: a collection-wide scan is the only version of this check that
 * can catch a PRE-EXISTING orphan too, not just prove this run's own
 * cascade worked. Detection only — there is no multi-collection transaction
 * here, so this cannot roll back an erasure that already happened; it
 * exists to make a dangling reference IMPOSSIBLE TO MISS, not undo one.
 * ───────────────────────────────────────────────────────────────────── */
export async function assertNoDanglingVisaDocuments(): Promise<void> {
  const [documentApplicationIds, existingApplicationIds] = await Promise.all([
    VisaDocument.distinct("applicationId"),
    VisaApplication.distinct("_id"),
  ]);
  const existing = new Set(existingApplicationIds.map((id: any) => String(id)));
  const dangling = documentApplicationIds.map((id: any) => String(id)).filter((id: string) => !existing.has(id));

  if (dangling.length > 0) {
    console.error(
      `INVARIANT VIOLATED: ${dangling.length} VisaDocument applicationId(s) do not resolve to any VisaApplication: ` +
        dangling.join(", "),
    );
    process.exit(1);
  }
}
