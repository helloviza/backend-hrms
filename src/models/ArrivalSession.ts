// apps/backend/src/models/ArrivalSession.ts
//
// A post-arrival WhatsApp concierge session, opened when a WHATSAPP-channel
// TripWatch is detected as LANDED. Workspace-scoped. Exactly ONE session per
// TripWatch, ever (unique index on tripWatchId) — this uniqueness IS the
// idempotency guard that stops the worker re-greeting a landed flight every
// cycle.
//
// SECURITY: inbound WhatsApp is unauthenticated; the ACTIVE session row (matched
// by the traveler's own phone) is the ONLY scope for any reply. Data is never
// resolved by phone number across sessions/workspaces.

import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type ArrivalSessionStatus = "PENDING" | "ACTIVE" | "EXPIRED" | "OPTED_OUT";

export interface IArrivalSessionHotel {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  checkInDate?: string | null;
}

export interface IArrivalSession extends Document {
  workspaceId: mongoose.Types.ObjectId;
  tripWatchId: mongoose.Types.ObjectId;
  bookingId?: mongoose.Types.ObjectId | null;
  sbtRequestId?: mongoose.Types.ObjectId | null;
  travelerUserId?: mongoose.Types.ObjectId | null;
  phone: string; // E.164 ("+…") — the sole inbound identity signal
  destinationIata: string;
  destinationCity: string;
  hotel?: IArrivalSessionHotel | null;
  // Booker contact resolved ONCE at session creation (no per-message User lookups).
  bookerUserId?: mongoose.Types.ObjectId | null;
  bookerName?: string | null;
  bookerEmail?: string | null;
  bookerPhone?: string | null;
  status: ArrivalSessionStatus;
  greetingAttempts: number; // greeting send retries (max 2, then EXPIRED)
  openedAt?: Date | null;
  expiresAt: Date;
  messageCount: number;
  lastInboundAt?: Date | null;
  // Inbound rate-limit window (max 20 processed msgs / session / hour).
  rateWindowStart?: Date | null;
  rateWindowCount: number;
  rateLimitNotifiedAt?: Date | null;
  // Unknown-command menu cap (max 3 / session / day).
  menuWindowStart?: Date | null;
  menuCount: number;
  // messageId idempotency for inbound handling (mirrors the expense upsert).
  processedMessageIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const HotelSchema = new Schema<IArrivalSessionHotel>(
  {
    name: { type: String, default: null },
    address: { type: String, default: null },
    phone: { type: String, default: null },
    checkInDate: { type: String, default: null },
  },
  { _id: false },
);

const ArrivalSessionSchema = new Schema<IArrivalSession>(
  {
    // workspaceId added by workspaceScopePlugin (ObjectId, required, indexed).
    tripWatchId: { type: Schema.Types.ObjectId, ref: "TripWatch", required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "SBTBooking", default: null },
    sbtRequestId: { type: Schema.Types.ObjectId, ref: "SBTRequest", default: null },
    travelerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    phone: { type: String, required: true, index: true },
    destinationIata: { type: String, default: "" },
    destinationCity: { type: String, default: "" },
    hotel: { type: HotelSchema, default: null },
    bookerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    bookerName: { type: String, default: null },
    bookerEmail: { type: String, default: null },
    bookerPhone: { type: String, default: null },
    status: {
      type: String,
      enum: ["PENDING", "ACTIVE", "EXPIRED", "OPTED_OUT"],
      default: "PENDING",
      index: true,
    },
    greetingAttempts: { type: Number, default: 0 },
    openedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: true },
    messageCount: { type: Number, default: 0 },
    lastInboundAt: { type: Date, default: null },
    rateWindowStart: { type: Date, default: null },
    rateWindowCount: { type: Number, default: 0 },
    rateLimitNotifiedAt: { type: Date, default: null },
    menuWindowStart: { type: Date, default: null },
    menuCount: { type: Number, default: 0 },
    processedMessageIds: { type: [String], default: [] },
  },
  { timestamps: true },
);

ArrivalSessionSchema.plugin(workspaceScopePlugin);
// Exactly one session per watch — the landing-detection idempotency guard.
ArrivalSessionSchema.index({ tripWatchId: 1 }, { unique: true });
// Inbound dispatch: resolve the ACTIVE session for a sender phone fast.
ArrivalSessionSchema.index({ phone: 1, status: 1 });
// Lifecycle sweep: find sessions past expiry fast.
ArrivalSessionSchema.index({ status: 1, expiresAt: 1 });

const ArrivalSession =
  (mongoose.models.ArrivalSession as mongoose.Model<IArrivalSession>) ||
  mongoose.model<IArrivalSession>("ArrivalSession", ArrivalSessionSchema);

export default ArrivalSession;
