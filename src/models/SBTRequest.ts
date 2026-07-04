import { Schema, model, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface ISBTRequest extends Document {
  workspaceId: Schema.Types.ObjectId;
  customerId: Schema.Types.ObjectId; // legacy
  requesterId: Schema.Types.ObjectId;
  assignedBookerId: Schema.Types.ObjectId;
  type: "flight" | "hotel";
  searchParams: Record<string, any>;
  selectedOption: Record<string, any>;
  status: "PENDING" | "BOOKED" | "REJECTED" | "CANCELLED";
  bookingId?: Schema.Types.ObjectId;
  hotelBookingId?: Schema.Types.ObjectId;
  rejectionReason?: string;
  alternativeSuggestion?: string;
  requesterNotes?: string;
  passengerDetails?: {
    firstName: string;
    lastName: string;
    gender: "Male" | "Female" | "Other";
    dateOfBirth?: string;
    passportNumber?: string;
    passportExpiry?: string;
    nationality?: string;
    isLeadPassenger?: boolean;
    paxType?: "adult" | "child" | "infant";
  }[];
  contactDetails?: {
    email?: string;
    phone?: string;
  };
  bookerNotes?: string;
  // Origin channel. Absent on legacy records (which carry searchParams.source).
  source?: string; // "CONCIERGE" | "CONCIERGE_AI" | ...
  conversationId?: string;
  // Richer concierge handoff (Phase 2). NEW subdocument — never repurpose
  // searchParams, which is load-bearing in sbt.requests.ts.
  tripBundle?: {
    outboundFlight?: Record<string, any>;
    inboundFlight?: Record<string, any>;
    hotel?: Record<string, any>;
    policyStatus?: string;
    conversationSummary?: string;
    lockedDecisions?: Record<string, any>;
  };
  requestedAt: Date;
  actedAt?: Date;
  cancelledAt?: Date;
}

const SBTRequestSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
  customerId: { type: Schema.Types.ObjectId, index: true }, // legacy
  requesterId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  assignedBookerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  type: { type: String, enum: ["flight", "hotel"], required: true },

  searchParams: { type: Object, required: true },
  selectedOption: { type: Object, required: true },

  status: {
    type: String,
    enum: ["PENDING", "BOOKED", "REJECTED", "CANCELLED"],
    default: "PENDING",
    index: true,
  },

  bookingId: { type: Schema.Types.ObjectId, ref: "SBTBooking", default: null },
  hotelBookingId: { type: Schema.Types.ObjectId, ref: "SBTHotelBooking", default: null },

  rejectionReason: { type: String, default: null },
  alternativeSuggestion: { type: String, default: null },

  requesterNotes: { type: String, default: null },
  passengerDetails: [{
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    gender: { type: String, enum: ["Male", "Female", "Other"], required: true },
    dateOfBirth: { type: String },
    passportNumber: { type: String },
    passportExpiry: { type: String },
    nationality: { type: String },
    isLeadPassenger: { type: Boolean, default: false },
    paxType: { type: String, enum: ["adult", "child", "infant"] },
  }],
  contactDetails: {
    email: { type: String },
    phone: { type: String },
  },
  bookerNotes: { type: String, default: null },

  source: { type: String, default: null, index: true },
  conversationId: { type: String, default: null, index: true },
  // NEW subdocument for the richer concierge handoff. Optional; existing
  // single-flight raise-request calls simply omit it.
  tripBundle: {
    outboundFlight: { type: Object, default: null },
    inboundFlight: { type: Object, default: null },
    hotel: { type: Object, default: null },
    policyStatus: { type: String, default: null },
    conversationSummary: { type: String, default: null },
    lockedDecisions: { type: Object, default: null },
  },

  requestedAt: { type: Date, default: Date.now },
  actedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
});

SBTRequestSchema.plugin(workspaceScopePlugin);
SBTRequestSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
SBTRequestSchema.index({ requesterId: 1, status: 1 });
SBTRequestSchema.index({ assignedBookerId: 1, status: 1 });
SBTRequestSchema.index({ customerId: 1, status: 1 });

export default model<ISBTRequest>("SBTRequest", SBTRequestSchema);
