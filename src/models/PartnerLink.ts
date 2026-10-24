// apps/backend/src/models/PartnerLink.ts
//
// A partner lead link: the public code a partner (Amber Student, Ambition, …)
// puts on its site, which opens the Plumtrips lead form. The code picks the
// partner — workspaceId / customerId are only ever read from here, never
// from a request body (services/partnerIntake.create.ts).
//
// A partner is an ordinary Customer + CustomerWorkspace pair:
//   workspaceId = CustomerWorkspace._id   (the ticket's workspaceId)
//   customerId  = CustomerWorkspace.customerId = Customer._id (the ticket's
//                 customerId; re-checked against the live workspace on every
//                 resolve and submit)
//
// The code is an attribution token, not a secret: it is public once it is on
// a partner's page. 8 random base62 characters, so the resolve endpoint can't
// be walked. Links are deactivated, never deleted (cases keep pointing here).
import crypto from "crypto";
import mongoose, { Schema, type Model } from "mongoose";
import { VisaUtmSchema, type VisaUtm } from "./visaUtm.js";

export const PARTNER_LINK_SERVICES = ["flight", "hotel", "visa"] as const;
export type PartnerLinkService = (typeof PARTNER_LINK_SERVICES)[number];
export const DEFAULT_DAILY_CAP = 200;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 8 random base62 characters (rejection-sampled, so every character is equally likely). */
export function newPartnerLinkCode(length = 8): string {
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out += BASE62[byte % 62]; // 248 = 4 × 62
    }
  }
  return out;
}

export const PARTNER_LINK_CODE_RE = /^[0-9A-Za-z]{8}$/;

export interface PartnerLinkDoc {
  code: string;
  workspaceId: mongoose.Types.ObjectId;
  customerId: string;
  label: string;
  placement: string;
  services: PartnerLinkService[];
  active: boolean;
  embedAllowed: boolean;
  allowedOrigins: string[];
  utmDefaults?: VisaUtm;
  dailyCap: number;
  /** Per-code daily submission counter (IST day, "YYYY-MM-DD"). */
  dailyCount: number;
  dailyCountDay: string;
  clicks: number;
  submissions: number;
  createdBy?: string;
  createdByEmail?: string;
  deactivatedAt?: Date | null;
  deactivatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const PartnerLinkSchema = new Schema<PartnerLinkDoc>(
  {
    code: { type: String, required: true, unique: true, match: PARTNER_LINK_CODE_RE },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    customerId: { type: String, required: true },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    placement: { type: String, default: "", trim: true, maxlength: 80 },
    services: {
      type: [{ type: String, enum: PARTNER_LINK_SERVICES }],
      default: () => [...PARTNER_LINK_SERVICES],
    },
    active: { type: Boolean, default: true },
    embedAllowed: { type: Boolean, default: false },
    allowedOrigins: { type: [String], default: [] },
    utmDefaults: { type: VisaUtmSchema, default: undefined },
    dailyCap: { type: Number, default: DEFAULT_DAILY_CAP, min: 1, max: 10000 },
    dailyCount: { type: Number, default: 0 },
    dailyCountDay: { type: String, default: "" },
    clicks: { type: Number, default: 0 },
    submissions: { type: Number, default: 0 },
    createdBy: { type: String },
    createdByEmail: { type: String },
    deactivatedAt: { type: Date, default: null },
    deactivatedBy: { type: String },
  },
  { timestamps: true },
);

const PartnerLink: Model<PartnerLinkDoc> =
  (mongoose.models.PartnerLink as Model<PartnerLinkDoc>) || mongoose.model<PartnerLinkDoc>("PartnerLink", PartnerLinkSchema);

export default PartnerLink;
