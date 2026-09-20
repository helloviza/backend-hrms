// apps/backend/src/models/plumconnect/Contact.ts
//
// PlumConnect Slice 0 — one row per external party who has ever messaged the
// WABA number, keyed by canonical phone (utils/phone.ts: E.164 digits, no "+").
//
// A Contact REFERENCES the records that already describe this person — a
// verified employee's User, a D2C Consumer, a CRM contact, the Leads it
// spawned — and copies NONE of their fields beyond the WhatsApp display name.
// Tenant is never stored here: a person is not a tenant. It is derived at read
// time through refs.userId → User.workspaceId, and only for a verified
// employee. There is deliberately no workspaceId and no workspaceScopePlugin.
//
// refs.userId is written by exactly one thing: the Slice-1 identity resolver's
// hard bind, after the employee has answered YES to the expense-capability
// consent prompt. Nothing in Slice 0 writes this model at all.
//
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §2.

import mongoose, { Schema, type Document } from "mongoose";

export const CONTACT_IDENTITY_STATES = [
  "unknown",
  "soft_employee",
  "soft_consumer",
  "soft_crm",
  "verified_employee",
] as const;
export type ContactIdentityState = (typeof CONTACT_IDENTITY_STATES)[number];

export const CONTACT_CONSENT_ANSWERS = ["yes", "no"] as const;
export type ContactConsentAnswer = (typeof CONTACT_CONSENT_ANSWERS)[number];

export interface IPlumConnectContactRefs {
  userId?: mongoose.Types.ObjectId | null;
  consumerId?: mongoose.Types.ObjectId | null;
  crmContactId?: mongoose.Types.ObjectId | null;
  leadIds: mongoose.Types.ObjectId[];
}

export interface IPlumConnectContactConsent {
  expenseBindAskedAt?: Date | null;
  expenseBindAnsweredAt?: Date | null;
  expenseBindAnswer?: ContactConsentAnswer | null;
}

export interface IPlumConnectContact extends Document {
  phone: string; // canonical, unique
  displayName: string; // value.contacts[].profile.name — the only copied field
  refs: IPlumConnectContactRefs;
  identityState: ContactIdentityState;
  consent: IPlumConnectContactConsent;
  firstSeenAt?: Date | null;
  lastSeenAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const RefsSchema = new Schema<IPlumConnectContactRefs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    consumerId: { type: Schema.Types.ObjectId, ref: "Consumer", default: null },
    crmContactId: { type: Schema.Types.ObjectId, ref: "CRMContact", default: null },
    // Append-only; the CURRENT lead lives on the Conversation (leadId).
    leadIds: { type: [{ type: Schema.Types.ObjectId, ref: "Lead" }], default: [] },
  },
  { _id: false },
);

const ConsentSchema = new Schema<IPlumConnectContactConsent>(
  {
    expenseBindAskedAt: { type: Date, default: null },
    expenseBindAnsweredAt: { type: Date, default: null },
    expenseBindAnswer: { type: String, enum: [...CONTACT_CONSENT_ANSWERS, null], default: null },
  },
  { _id: false },
);

const PlumConnectContactSchema = new Schema<IPlumConnectContact>(
  {
    phone: { type: String, required: true, unique: true, trim: true },
    displayName: { type: String, trim: true, default: "" },
    refs: { type: RefsSchema, default: () => ({}) },
    identityState: {
      type: String,
      enum: CONTACT_IDENTITY_STATES,
      default: "unknown",
      index: true,
    },
    consent: { type: ConsentSchema, default: () => ({}) },
    firstSeenAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true },
);

const PlumConnectContact =
  (mongoose.models.PlumConnectContact as mongoose.Model<IPlumConnectContact>) ||
  mongoose.model<IPlumConnectContact>("PlumConnectContact", PlumConnectContactSchema);

export default PlumConnectContact;
