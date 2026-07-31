// apps/backend/src/scripts/erase-traveller-profile.ts
//
// Erases a TravellerProfile and everything derived from it — separate from
// (and narrower in one specific way, broader in another, than)
// erase-visa-request.ts's whole-case deletion:
//
//   - NOT deleted: the VisaApplication/VisaRequest rows themselves. The case
//     skeleton (status, ruleSnapshot, dates, assignment, costs) is left
//     alone — this is "traveller erasure", not "application deletion" (task
//     brief). BUT surviving applications ARE scrubbed, not left untouched:
//     travellerProfileId is set to null (never left dangling — an
//     unexplained missing reference reads as a bug) and travellerErasedAt is
//     stamped, so a null reference here reads as deliberate. actionRequired
//     Reason/SetAt/SetByUserId are also nulled — concierge free text that
//     frequently names the traveller, the same risk already being wiped from
//     VisaActivityLog. `status`/statusBeforeActionRequired are left alone —
//     see scrubApplicationsAfterTravellerErasure's own comment for the one
//     known consequence of that (an application stuck showing
//     "action_required" with no reason text).
//   - Touched: every VisaDocument (+ its S3 object) belonging to one of this
//     traveller's OWN applications. A stored passport photo IS "everything
//     derived from" the traveller — arguably the single most sensitive
//     artifact — and extractedFields (the MRZ/VIZ data "written back by
//     extraction") lives on exactly these rows; scrubbing the profile while
//     leaving the source photo and its extracted fields in place would not
//     be an erasure, it would just be relocating where the same data sits.
//   - Touched: VisaActivityLog rows, but scoped to THIS traveller's OWN
//     applicationIds, never the whole request — a request can hold other
//     travellers whose history must not be touched by one traveller's
//     erasure. Detail wiped, row kept, redactedAt stamped (same as
//     erase-visa-request.ts).
//   - Touched: ManualBooking, found via metadata.visaApplicationId (NOT
//     travellerProfileId — that field doesn't exist on ManualBooking at
//     all). REDACTED, never deleted: passengers[].passportNo/email/phone
//     stripped, name and every pricing field left alone (GST retention).
//   - Reported, never touched: CstepTravelRequest/CstepClaim — a soft,
//     non-enforced reference from the unrelated CSTEP Travel & Claim
//     Portal. Applying against a traveller with CSTEP history requires the
//     separate --acknowledge-cstep-impact flag (on top of --apply) — this
//     never blocks the erasure outright, it only requires the operator to
//     have read the impact first.
//
// SUPERADMIN ONLY / guard model / dry-run-by-default — identical shape to
// erase-visa-request.ts, see that file's header for the full rationale.
//
// Run (dry run): pnpm exec tsx src/scripts/erase-traveller-profile.ts --traveller-id <id> --actor-email <email> --reason "<text>"
// Run (apply):   pnpm exec tsx src/scripts/erase-traveller-profile.ts --traveller-id <id> --actor-email <email> --reason "<text>" --apply [--acknowledge-cstep-impact] [--yes]
import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import TravellerProfile from "../models/TravellerProfile.js";
import { redactVisaActivityForApplications } from "../models/VisaActivityLog.js";
import { recordVisaErasure } from "../models/VisaErasureLog.js";
import {
  assertModelScope,
  targetInfo,
  confirmDatabaseName,
  resolveSuperAdminActor,
  findApplicationIdsForTraveller,
  planDocuments,
  deleteDocumentsAndS3,
  planManualBookings,
  redactManualBookings,
  scrubApplicationsAfterTravellerErasure,
  planCstepImpact,
  assertCstepImpactAcknowledged,
  assertNoDanglingVisaDocuments,
} from "./lib/visaErasureCascade.js";

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

async function run() {
  const travellerId = getArgValue("--traveller-id");
  const actorEmail = getArgValue("--actor-email");
  const reason = getArgValue("--reason");
  const apply = process.argv.includes("--apply");
  const cstepAcknowledged = process.argv.includes("--acknowledge-cstep-impact");

  if (!travellerId || !mongoose.isValidObjectId(travellerId)) {
    console.error("Usage: --traveller-id <TravellerProfile ObjectId> is required.");
    process.exit(1);
  }
  if (!actorEmail) {
    console.error("Usage: --actor-email <email> is required (must resolve to a SUPERADMIN user).");
    process.exit(1);
  }
  if (!reason || !reason.trim()) {
    console.error("Usage: --reason \"<text>\" is required — recorded on the erasure log.");
    process.exit(1);
  }

  await connectDb();
  assertModelScope();

  const actor = await resolveSuperAdminActor(actorEmail);

  const traveller = await TravellerProfile.findById(travellerId).lean();
  if (!traveller) {
    console.error(`No TravellerProfile found with id ${travellerId}.`);
    process.exit(1);
  }

  const applicationIds = await findApplicationIdsForTraveller(travellerId);
  const { documentIds, s3Keys } = await planDocuments(applicationIds);
  const manualBookings = await planManualBookings(applicationIds);
  const cstepImpact = await planCstepImpact(travellerId);

  const target = targetInfo();
  console.log("──────────────────────────────────────────────────────");
  console.log(`Target host:       ${target.host}`);
  console.log(`Target database:   ${target.db}`);
  console.log(`TravellerProfile:  ${travellerId} (${(traveller as any).firstName} ${(traveller as any).lastName}, ${(traveller as any).travelerId})`);
  console.log(`Actor:             ${actor.email} (SUPERADMIN, verified)`);
  console.log(`Reason:            ${reason}`);
  console.log("──────────────────────────────────────────────────────");
  console.log(`VisaApplication:   ${applicationIds.length} reference this traveller — NOT deleted (case skeleton kept). travellerProfileId will be set to null + travellerErasedAt stamped; actionRequiredReason/actionRequiredSetAt/actionRequiredSetByUserId will be nulled.`);
  console.log(`VisaDocument:      ${documentIds.length} to hard-delete`);
  console.log(`S3 objects:        ${s3Keys.length} to delete`);
  for (const key of s3Keys) console.log(`  - ${key}`);
  console.log(`VisaActivityLog:   rows for this traveller's own applications will be redacted (detail wiped, row kept)`);
  console.log(`ManualBooking:     ${manualBookings.length} found via metadata.visaApplicationId — REDACTED, never deleted`);
  for (const b of manualBookings) {
    console.log(
      `  - ${b.bookingRef}: passportNo/email/phone will be stripped; name "${b.passengerName}" and all pricing KEPT (GST retention — flagged pending legal review, not erased by this run)`,
    );
  }
  console.log("──────────────────────────────────────────────────────");
  console.log(
    `CSTEP Travel & Claim Portal impact: ${cstepImpact.travelRequestCount} travel request(s), ${cstepImpact.claimCount} claim(s) ` +
      `hold a soft reference to this profile. NOT touched by this run — those records will silently stop resolving this ` +
      `traveller's name. ${cstepImpact.travelRequestCount + cstepImpact.claimCount > 0 ? "Requires --acknowledge-cstep-impact to --apply." : ""}`,
  );
  console.log("──────────────────────────────────────────────────────");

  if (!apply) {
    console.log("Dry run — nothing written. Re-run with --apply to execute.");
    process.exit(0);
  }

  assertCstepImpactAcknowledged(cstepImpact, cstepAcknowledged);

  await confirmDatabaseName(target.db);

  const { documentsDeleted, s3KeysDeleted } = await deleteDocumentsAndS3(applicationIds);
  const activityRowsRedacted = await redactVisaActivityForApplications(applicationIds);
  const manualBookingsRedacted = await redactManualBookings(applicationIds);
  const applicationsScrubbed = await scrubApplicationsAfterTravellerErasure(applicationIds);

  await TravellerProfile.deleteOne({ _id: travellerId });

  await assertNoDanglingVisaDocuments();

  await recordVisaErasure({
    scope: "TRAVELLER_PROFILE",
    targetId: travellerId,
    workspaceId: (traveller as any).workspaceId,
    actorUserId: actor._id,
    actorEmail: actor.email,
    reason,
    counts: {
      travellerProfilesDeleted: 1,
      visaDocumentsDeleted: documentsDeleted,
      activityRowsRedacted,
      manualBookingsRedacted,
      applicationsScrubbed,
    },
    s3KeysDeleted,
    cstepImpact: { ...cstepImpact, acknowledged: cstepAcknowledged },
  });

  console.log(
    `Erased: 1 TravellerProfile, ${documentsDeleted} VisaDocument(s), ${s3KeysDeleted.length} S3 object(s). ` +
      `${activityRowsRedacted} activity row(s) redacted, ${manualBookingsRedacted} ManualBooking(s) redacted, ` +
      `${applicationsScrubbed} VisaApplication(s) scrubbed (travellerProfileId nulled, actionRequiredReason cleared).`,
  );
  process.exit(0);
}

run().catch((err) => {
  console.error("erase-traveller-profile failed:", err?.message || err);
  process.exit(1);
});
