// apps/backend/src/scripts/erase-visa-request.ts
//
// Hard-deletes an entire visa case: VisaRequest -> its VisaApplications ->
// their VisaDocuments -> the S3 objects those documents point at. Nothing
// orphaned afterwards — see assertNoDanglingVisaDocuments() in
// scripts/lib/visaErasureCascade.ts, run at the end of every real
// (--apply) execution.
//
// VisaActivityLog rows for this request survive — DETAIL is wiped and the
// row is stamped redactedAt, but the row itself (eventType, at, actorType)
// stays: "a case existed and was worked" is an audit record, never deleted.
//
// ManualBooking rows created off this case (found via
// metadata.visaApplicationId — see visaBillingSync.ts) are REDACTED, never
// deleted: passengers[].passportNo/email/phone are stripped, everything
// financial and the passenger name are left alone (GST retention applies to
// the invoice; see visaErasureCascade.ts's own comment on why the name
// isn't touched here).
//
// THIS SCRIPT DELIBERATELY DOES NOT CRYPTO-SHRED. erase-traveller-profile.ts
// destroys the subject's data key at the end of its run (the key dies last —
// see destroyErasureSubjectKey in scripts/lib/visaErasureCascade.ts); this
// one must not, and the difference is not an oversight. A key belongs to a
// SUBJECT, not to a case: one traveller can hold applications across several
// requests, so destroying their key while erasing ONE case would make their
// OTHER, still-live cases' extracted passport data permanently unreadable.
// Deleting this case's VisaDocument rows outright — which this script does —
// is the erasure that is actually in scope here.
//
// SUPERADMIN ONLY — enforced by resolving --actor-email against a real User
// document and requiring it carry the SUPERADMIN role (this script runs
// outside any HTTP request, so there is no req.user/JWT to trust instead).
//
// GUARD MODEL — same shape as seed-visa-rules.ts/purge-visa-seed.ts, plus
// the migrations/ dry-run convention:
//   1. Dry run by default — prints the plan, writes nothing, exits 0.
//   2. --apply is required to write anything at all.
//   3. confirmDatabaseName() — operator types the exact database name (or
//      passes --yes for non-interactive runs) before any delete happens.
//   4. assertModelScope() — only the models this erasure is allowed to
//      touch may be registered with mongoose when this runs.
// Every real run is recorded in VisaErasureLog — append-only, never itself
// erased (models/VisaErasureLog.ts).
//
// Run (dry run):   pnpm exec tsx src/scripts/erase-visa-request.ts --request-id <id> --actor-email <email> --reason "<text>"
// Run (apply):     pnpm exec tsx src/scripts/erase-visa-request.ts --request-id <id> --actor-email <email> --reason "<text>" --apply [--yes]
import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaApplication from "../models/VisaApplication.js";
import { redactVisaActivityForRequest } from "../models/VisaActivityLog.js";
import { recordVisaErasure } from "../models/VisaErasureLog.js";
import {
  assertModelScope,
  targetInfo,
  confirmDatabaseName,
  resolveSuperAdminActor,
  findApplicationIdsForRequest,
  planDocuments,
  deleteDocumentsAndS3,
  planManualBookings,
  redactManualBookings,
  assertNoDanglingVisaDocuments,
} from "./lib/visaErasureCascade.js";

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

async function run() {
  const requestId = getArgValue("--request-id");
  const actorEmail = getArgValue("--actor-email");
  const reason = getArgValue("--reason");
  const apply = process.argv.includes("--apply");

  if (!requestId || !mongoose.isValidObjectId(requestId)) {
    console.error("Usage: --request-id <VisaRequest ObjectId> is required.");
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

  const request = await VisaRequest.findById(requestId).lean();
  if (!request) {
    console.error(`No VisaRequest found with id ${requestId}.`);
    process.exit(1);
  }

  const applicationIds = await findApplicationIdsForRequest(requestId);
  const { documentIds, s3Keys } = await planDocuments(applicationIds);
  const manualBookings = await planManualBookings(applicationIds);

  const target = targetInfo();
  console.log("──────────────────────────────────────────────────────");
  console.log(`Target host:       ${target.host}`);
  console.log(`Target database:   ${target.db}`);
  console.log(`VisaRequest:       ${requestId} (${(request as any).referenceNumber})`);
  console.log(`Actor:             ${actor.email} (SUPERADMIN, verified)`);
  console.log(`Reason:            ${reason}`);
  console.log("──────────────────────────────────────────────────────");
  console.log(`VisaApplication:   ${applicationIds.length} to hard-delete`);
  console.log(`VisaDocument:      ${documentIds.length} to hard-delete`);
  console.log(`S3 objects:        ${s3Keys.length} to delete`);
  for (const key of s3Keys) console.log(`  - ${key}`);
  console.log(`VisaActivityLog:   rows for this request will be redacted (detail wiped, row kept)`);
  console.log(`ManualBooking:     ${manualBookings.length} found via metadata.visaApplicationId — REDACTED, never deleted`);
  for (const b of manualBookings) {
    console.log(
      `  - ${b.bookingRef}: passportNo/email/phone will be stripped; name "${b.passengerName}" and all pricing KEPT (GST retention — flagged pending legal review, not erased by this run)`,
    );
  }
  console.log("──────────────────────────────────────────────────────");

  if (!apply) {
    console.log("Dry run — nothing written. Re-run with --apply to execute.");
    process.exit(0);
  }

  await confirmDatabaseName(target.db);

  const { documentsDeleted, s3KeysDeleted } = await deleteDocumentsAndS3(applicationIds);
  const activityRowsRedacted = await redactVisaActivityForRequest(requestId);
  const manualBookingsRedacted = await redactManualBookings(applicationIds);

  const applicationsDeleteResult = await VisaApplication.deleteMany({ _id: { $in: applicationIds } });
  await VisaRequest.deleteOne({ _id: requestId });

  await assertNoDanglingVisaDocuments();

  await recordVisaErasure({
    scope: "VISA_REQUEST",
    targetId: requestId,
    workspaceId: (request as any).workspaceId,
    actorUserId: actor._id,
    actorEmail: actor.email,
    reason,
    counts: {
      visaRequestsDeleted: 1,
      visaApplicationsDeleted: applicationsDeleteResult.deletedCount ?? 0,
      visaDocumentsDeleted: documentsDeleted,
      activityRowsRedacted,
      manualBookingsRedacted,
    },
    s3KeysDeleted,
  });

  console.log(
    `Erased: 1 VisaRequest, ${applicationsDeleteResult.deletedCount ?? 0} VisaApplication(s), ` +
      `${documentsDeleted} VisaDocument(s), ${s3KeysDeleted.length} S3 object(s). ` +
      `${activityRowsRedacted} activity row(s) redacted, ${manualBookingsRedacted} ManualBooking(s) redacted.`,
  );
  process.exit(0);
}

run().catch((err) => {
  console.error("erase-visa-request failed:", err?.message || err);
  process.exit(1);
});
