// apps/backend/src/models/TravellerDocument.ts
//
// Profile-scoped documents — passport front/back, and (gated) PAN/Aadhaar
// card images. Workspace-scoped, metadata only; bytes live in S3.
//
// WHY NOT VisaDocument. That model is applicationId-keyed: applicationId is
// `required: true` and its uniqueness index is {applicationId, docCode,
// version}. A profile-level document has no application, so reusing it
// would mean either inventing a fake applicationId or making a required
// field optional — both worse than a second collection. Everything else
// about it was right, so this is deliberately shaped the SAME way and reads
// the same: versioned on re-upload rather than overwritten, soft-delete
// only, workspaceId in the S3 key path.
// See infra/design/universal-traveller-profile-2026-08-11.md §1.3.
//
// Key prefix (applied by the upload route, routes/workspace.travellers.ts):
//   traveller-profiles/<workspaceId>/<travellerProfileId>/<timestamp>-<random>.<ext>
// workspaceId is IN the path — not just in the workspaceId field — so a key
// can never be reused across tenants even by accident.
//
// Soft delete only (deletedAt/deletedBy) — the S3 object is NEVER removed
// by this model or its routes.
//
// READ IS TIGHTER THAN THE FIELD READ. Any active member may read any
// workspace traveller's FIELDS unmasked (workspace.travellers.ts's
// documented read-vs-write split — booking a colleague's saved traveller
// needs the real passport number). A passport SCAN is a different object:
// it carries the photo page, the signature and everything else printed on
// it, and no booking flow needs it. So every route over this collection —
// list, presign, upload, delete — requires the same access
// ensureTravellerWriteAccess(…, "edit") grants: the subject themselves, or
// WORKSPACE_LEADER/APPROVER. That divergence is deliberate, not an
// oversight.
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

/**
 * PASSPORT_* are capturable today. The three national-ID kinds are GATED on
 * config/platformCapabilities.ts's mrzEncryptionAtRest and every upload of
 * one is refused while it is false — the kinds are declared now so the
 * shape is settled, not because anything can be stored under them.
 *
 * A passport scan is not a regulated national ID and is not gated: passport
 * data already lives in TravellerProfile unencrypted, with the compliance
 * badge honestly saying so.
 */
export const TRAVELLER_DOCUMENT_KINDS = [
  "PASSPORT_FRONT",
  "PASSPORT_BACK",
  "PAN_CARD",
  "AADHAAR_FRONT",
  "AADHAAR_BACK",
] as const;
export type TravellerDocumentKind = (typeof TRAVELLER_DOCUMENT_KINDS)[number];

/** The subset whose capture waits on encryption at rest. */
export const GATED_TRAVELLER_DOCUMENT_KINDS: ReadonlySet<TravellerDocumentKind> =
  new Set<TravellerDocumentKind>(["PAN_CARD", "AADHAAR_FRONT", "AADHAAR_BACK"]);

export const TRAVELLER_DOCUMENT_KIND_LABELS: Record<TravellerDocumentKind, string> = {
  PASSPORT_FRONT: "Passport — front page",
  PASSPORT_BACK: "Passport — back page",
  PAN_CARD: "PAN card",
  AADHAAR_FRONT: "Aadhaar — front",
  AADHAAR_BACK: "Aadhaar — back",
};

export interface TravellerDocumentDocument extends Document {
  workspaceId: mongoose.Types.ObjectId; // CustomerWorkspace._id, via workspaceScopePlugin
  travellerProfileId: mongoose.Types.ObjectId; // ref TravellerProfile
  docKind: TravellerDocumentKind;

  s3Key: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByUserId: mongoose.Types.ObjectId; // ref User
  version: number; // 1-based; a re-upload of the same docKind increments this, never overwrites

  // Soft delete — see file header. Never set one without the other.
  deletedAt?: Date | null;
  deletedBy?: mongoose.Types.ObjectId; // ref User

  createdAt?: Date;
  updatedAt?: Date;
}

const TravellerDocumentSchema = new Schema<TravellerDocumentDocument>(
  {
    travellerProfileId: {
      type: Schema.Types.ObjectId,
      ref: "TravellerProfile",
      required: true,
      index: true,
    },
    docKind: { type: String, enum: TRAVELLER_DOCUMENT_KINDS, required: true },

    s3Key: { type: String, required: true },
    originalFilename: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    uploadedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    version: { type: Number, required: true, default: 1, min: 1 },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

TravellerDocumentSchema.plugin(workspaceScopePlugin);

// Enforces "never overwrite" at the DB level rather than trusting the route
// to compute "next version" carefully — two concurrent uploads of the same
// docKind can never land on the same version number. Also serves the
// "latest version per kind" listing query.
TravellerDocumentSchema.index(
  { travellerProfileId: 1, docKind: 1, version: 1 },
  { unique: true },
);
// General per-profile listing.
TravellerDocumentSchema.index({ workspaceId: 1, travellerProfileId: 1 });
// Soft-deleted rows are excluded from every route's default queries but
// never physically removed — this keeps the listing fast once a profile has
// accumulated replaced versions.
TravellerDocumentSchema.index({ workspaceId: 1, deletedAt: 1 });

const TravellerDocument: Model<TravellerDocumentDocument> =
  mongoose.models.TravellerDocument ||
  mongoose.model<TravellerDocumentDocument>("TravellerDocument", TravellerDocumentSchema);

export default TravellerDocument;
