// apps/backend/src/models/Itinerary.ts
//
// Phase 5 (Assemble) — a workspace-scoped DRAFT trip assembled from concierge
// selections (outbound flight + inbound flight + hotel). policySummary is the
// worst-of the item policies; total is the sum of item prices. One DRAFT per
// (workspace, conversationId) — the assembly endpoint is idempotent on that key.

import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type ItineraryItemKind = "FLIGHT_OUTBOUND" | "FLIGHT_INBOUND" | "HOTEL";
export type ItineraryPolicyStatus = "IN_POLICY" | "NEEDS_APPROVAL" | "OUT_OF_POLICY";
export type ItineraryStatus = "DRAFT" | "SUBMITTED" | "BOOKED" | "DISCARDED";

export interface IItineraryItem {
  kind: ItineraryItemKind;
  payload: any; // the selected result object (flight _tboResult / typed hotel item)
  policy: { status: ItineraryPolicyStatus; reasons: string[] };
  priceINR: number;
}

export interface IItinerary extends Document {
  workspaceId: mongoose.Types.ObjectId;
  conversationId?: string | null;
  createdByUserId: mongoose.Types.ObjectId;
  title: string;
  destinationCity?: string | null;
  destinationIata?: string | null;
  dates: { start?: string | null; end?: string | null };
  items: IItineraryItem[];
  totalPriceINR: number;
  policySummary: ItineraryPolicyStatus;
  status: ItineraryStatus;
  sbtRequestId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const ItineraryItemSchema = new Schema<IItineraryItem>(
  {
    kind: { type: String, enum: ["FLIGHT_OUTBOUND", "FLIGHT_INBOUND", "HOTEL"], required: true },
    payload: { type: Schema.Types.Mixed, default: null },
    policy: {
      status: { type: String, enum: ["IN_POLICY", "NEEDS_APPROVAL", "OUT_OF_POLICY"], default: "IN_POLICY" },
      reasons: { type: [String], default: [] },
    },
    priceINR: { type: Number, default: 0 },
  },
  { _id: false },
);

const ItinerarySchema = new Schema<IItinerary>(
  {
    // workspaceId added by workspaceScopePlugin (ObjectId, required, indexed).
    // Lookup is served by the compound { workspaceId, conversationId, status } index below.
    conversationId: { type: String, default: null },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, default: "" },
    destinationCity: { type: String, default: null },
    destinationIata: { type: String, default: null },
    dates: {
      start: { type: String, default: null },
      end: { type: String, default: null },
    },
    items: { type: [ItineraryItemSchema], default: [] },
    totalPriceINR: { type: Number, default: 0 },
    policySummary: { type: String, enum: ["IN_POLICY", "NEEDS_APPROVAL", "OUT_OF_POLICY"], default: "IN_POLICY" },
    status: { type: String, enum: ["DRAFT", "SUBMITTED", "BOOKED", "DISCARDED"], default: "DRAFT", index: true },
    sbtRequestId: { type: Schema.Types.ObjectId, ref: "SBTRequest", default: null, index: true },
  },
  { timestamps: true },
);

ItinerarySchema.plugin(workspaceScopePlugin);
// Idempotent DRAFT lookup by conversation.
ItinerarySchema.index({ workspaceId: 1, conversationId: 1, status: 1 });

const Itinerary =
  (mongoose.models.Itinerary as mongoose.Model<IItinerary>) ||
  mongoose.model<IItinerary>("Itinerary", ItinerarySchema);

export default Itinerary;
