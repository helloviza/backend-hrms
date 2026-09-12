// apps/backend/src/models/CrmAssociation.ts
//
// crmassociations — the labelled N—N bridge the PRD's Section N needs
// (Lead N—N Contact, Opportunity N—N Contact with roles, Booking N—N
// Traveller, Company Account → Contact roles …). One collection for every
// association label, so no entity grows a parallel `xIds[]` array on both
// sides (docs/crm/PLUMBOX_CURRENT_STATE_AUDIT.md §7 row 14).
//
// Slice 1 ships the SCHEMA and a thin service (services/crmAssociations.ts)
// only. Nothing in Lead / Contact / Company / Opportunity reads or writes it
// yet — consumers land in Slice 2. The collection is created lazily by the
// first insert, and no insert can happen while CRM_V2_FOUNDATION is off.
//
// HOUSE-only (locked decision A): `workspaceId` is carried, nullable and
// unused — no scoping logic, no filtering, not indexed for scoping. It exists
// so tenancy is a future toggle rather than a rewrite.
import mongoose, { Document, Schema } from "mongoose";

// Entity vocabulary for `fromType` / `toType`. Opportunity and Quote are
// listed now so Slice 2 does not need a schema change to link them; the
// collections themselves do not exist yet.
export const CRM_ENTITY_TYPES = [
  "LEAD",
  "CONTACT",
  "COMPANY", // Company Account (crmcompanies, in place)
  "OPPORTUNITY",
  "QUOTE",
  "BOOKING", // travelbookings._id (the unified mirror)
  "TRAVELLER", // travellerprofiles._id
  "INVOICE",
  "TASK",
  "USER",
  "VENDOR",
  "CUSTOMER",
] as const;
export type CrmEntityType = (typeof CRM_ENTITY_TYPES)[number];

export interface CrmEntityRef {
  type: CrmEntityType;
  id: mongoose.Types.ObjectId;
}

export interface CrmAssociationDoc extends Document {
  fromType: CrmEntityType;
  fromId: mongoose.Types.ObjectId;
  toType: CrmEntityType;
  toId: mongoose.Types.ObjectId;
  // Free-form relationship label (PRD "association label"): e.g.
  // "PRIMARY_CONTACT", "DECISION_MAKER", "TRAVELLER", "CONVERTED_FROM",
  // "FULFILLED_BY". Normalised to upper-case on write by the service. "" means
  // an unlabelled link.
  label: string;
  createdBy?: mongoose.Types.ObjectId | null;
  workspaceId?: mongoose.Types.ObjectId | null; // reserved, unused (decision A)
  createdAt: Date;
  updatedAt: Date;
}

const CrmAssociationSchema = new Schema<CrmAssociationDoc>(
  {
    fromType: { type: String, enum: CRM_ENTITY_TYPES, required: true },
    fromId: { type: Schema.Types.ObjectId, required: true },
    toType: { type: String, enum: CRM_ENTITY_TYPES, required: true },
    toId: { type: Schema.Types.ObjectId, required: true },
    label: { type: String, trim: true, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", default: null },
  },
  { timestamps: true, collection: "crmassociations" }
);

// Lookups in either direction.
CrmAssociationSchema.index({ fromType: 1, fromId: 1 });
CrmAssociationSchema.index({ toType: 1, toId: 1 });
// One row per (from, to, label): the service upserts on this, so a repeated
// create is idempotent and a concurrent double-create cannot fork.
CrmAssociationSchema.index(
  { fromType: 1, fromId: 1, toType: 1, toId: 1, label: 1 },
  { unique: true, name: "crm_association_unique" }
);

const CrmAssociation =
  (mongoose.models.CrmAssociation as mongoose.Model<CrmAssociationDoc>) ||
  mongoose.model<CrmAssociationDoc>("CrmAssociation", CrmAssociationSchema);

export default CrmAssociation;
