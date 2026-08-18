// apps/backend/src/models/VisaD2CLead.ts
//
// THE MASTER SHEET ROW — one per consumer per corridor they started.
//
// ══════════════════════════════════════════════════════════════════════
// WHY THIS IS ITS OWN COLLECTION AND NOT A VisaApplication
// ══════════════════════════════════════════════════════════════════════
// The whole point of the Master Sheet is Scenario 1: someone who STARTED
// and has not submitted. There is no application for those people — that
// is the fact being tracked — and there must not be one, because a
// VisaApplication is an ops ticket. Creating a ticket the moment a
// stranger clicks Continue would flood the concierge queue with cases
// nobody has committed to, and would make "how many real cases do we
// have" unanswerable.
//
// So: a lead row is CHEAP and EARLY, an application is EXPENSIVE and
// LATE, and `applicationId` below is the seam between them.
//
// ── THE ROW IS UPSERTED, NEVER APPENDED ──────────────────────────────
// Unique on {consumerId, destinationIso2}. Someone who starts Thailand,
// wanders off, and comes back a week later must land on the SAME row —
// otherwise the sheet counts one person three times and every funnel
// number derived from it is inflated. The same key is why a started row
// BECOMES a submitted row rather than sitting beside a duplicate.
//
// ── ISOLATION ────────────────────────────────────────────────────────
// Same posture as models/ConsumerProfile.ts, and for the same reason: the
// workspaceScopePlugin is deliberately NOT applied. Every D2C consumer
// shares one synthetic workspace, so workspaceId is a STAMP and not a
// boundary; consumerId is the boundary. Ops reads here are cross-consumer
// BY DESIGN (it is a sheet of everyone), gated by the visaApplication
// permission — exactly like the concierge queue.
import mongoose, { Schema, type Document, type Model } from "mongoose";
import {
  D2C_PAYMENT_STATUSES,
  D2C_STAGES,
  D2C_TRACKING_STATUSES,
  type D2CPaymentStatus,
  type D2CStage,
  type D2CTrackingStatus,
} from "./visaD2CLifecycle.js";
import { VisaUtmSchema, type VisaUtm } from "./visaUtm.js";

export interface VisaD2CLeadDocument extends Document {
  consumerId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;

  destinationIso2: string;
  destinationName: string;
  /** Null until the reader has actually chosen one. */
  purpose: string | null;

  status: D2CTrackingStatus;
  stage: D2CStage;
  paymentStatus: D2CPaymentStatus;

  /**
   * THE SEAM. Null while the person is still filling things in; set to the
   * ticket the moment they submit. A row with an applicationId is a
   * converted lead; a row without one is Scenario 1.
   */
  applicationId: mongoose.Types.ObjectId | null;
  referenceNumber: string | null;

  utm: VisaUtm;

  startedAt: Date;
  submittedAt: Date | null;
}

const VisaD2CLeadSchema = new Schema<VisaD2CLeadDocument>(
  {
    consumerId: { type: Schema.Types.ObjectId, ref: "Consumer", required: true, index: true },
    // Stamped, not scoped — see the file header.
    workspaceId: { type: Schema.Types.ObjectId, required: true, index: true },

    destinationIso2: { type: String, required: true, uppercase: true, trim: true, index: true },
    destinationName: { type: String, required: true, trim: true },
    purpose: { type: String, default: null },

    status: { type: String, enum: D2C_TRACKING_STATUSES, default: "IN_PROGRESS", index: true },
    stage: {
      type: String,
      enum: D2C_STAGES,
      // The honest starting point: they are filling in documents and have
      // not submitted. This is the ONE place DOC_SUBMISSION_IN_PROGRESS is
      // ever written — an application can never carry it, because an
      // application does not exist until submit.
      default: "DOC_SUBMISSION_IN_PROGRESS",
      index: true,
    },
    // TODO(milestone-2): the payment webhook moves this (and `stage`) on
    // from PENDING. Nothing in Milestone 1 writes anything else.
    paymentStatus: { type: String, enum: D2C_PAYMENT_STATUSES, default: "PENDING", index: true },

    applicationId: {
      type: Schema.Types.ObjectId,
      ref: "VisaApplication",
      default: null,
      index: true,
    },
    referenceNumber: { type: String, default: null, trim: true },

    utm: { type: VisaUtmSchema, default: () => ({}) },

    startedAt: { type: Date, default: Date.now, index: true },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * ONE ROW PER PERSON PER CORRIDOR. See the file header — without this a
 * returning visitor becomes a second lead and every conversion rate
 * computed off this sheet is wrong in the flattering direction.
 */
VisaD2CLeadSchema.index({ consumerId: 1, destinationIso2: 1 }, { unique: true });

/** The sheet's default read: newest first. */
VisaD2CLeadSchema.index({ startedAt: -1 });

const VisaD2CLead: Model<VisaD2CLeadDocument> =
  mongoose.models.VisaD2CLead ||
  mongoose.model<VisaD2CLeadDocument>("VisaD2CLead", VisaD2CLeadSchema);

export default VisaD2CLead;
