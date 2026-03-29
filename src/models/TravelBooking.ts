// apps/backend/src/models/TravelBooking.ts
import { Schema, model, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface ITravelBooking extends Document {
  tenantId: string;
  service:
    | "FLIGHT"
    | "HOTEL"
    | "VISA"
    | "CAB"
    | "FOREX"
    | "ESIM"
    | "HOLIDAY"
    | "MICE"
    | "GIFTING"
    | "DECOR";
  amount: number;
  userId: Schema.Types.ObjectId;
  status: "CONFIRMED" | "CANCELLED" | "PENDING" | "FAILED";
  paymentMode: "OFFICIAL" | "PERSONAL";
  source: "SBT" | "CONCIERGE";
  reference?: Schema.Types.ObjectId;
  referenceModel?: "SBTBooking" | "SBTHotelBooking" | "ApprovalRequest";
  destination: string;
  origin: string;
  bookedAt: Date;
  travelDate?: Date;
  travelDateEnd?: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const SERVICE_ENUM = [
  "FLIGHT",
  "HOTEL",
  "VISA",
  "CAB",
  "FOREX",
  "ESIM",
  "HOLIDAY",
  "MICE",
  "GIFTING",
  "DECOR",
] as const;

const TravelBookingSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    tenantId: { type: String, default: "default", index: true }, // legacy
    service: { type: String, enum: SERVICE_ENUM, required: true },
    amount: { type: Number, required: true, default: 0 },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["CONFIRMED", "CANCELLED", "PENDING", "FAILED"],
      default: "PENDING",
    },
    paymentMode: {
      type: String,
      enum: ["OFFICIAL", "PERSONAL"],
      default: "OFFICIAL",
    },
    source: { type: String, enum: ["SBT", "CONCIERGE"], required: true },
    reference: { type: Schema.Types.ObjectId, refPath: "referenceModel" },
    referenceModel: {
      type: String,
      enum: ["SBTBooking", "SBTHotelBooking", "ApprovalRequest"],
    },
    destination: { type: String, default: "" },
    origin: { type: String, default: "" },
    bookedAt: { type: Date, default: Date.now },
    travelDate: { type: Date, default: null },
    travelDateEnd: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

TravelBookingSchema.plugin(workspaceScopePlugin);
TravelBookingSchema.index({ workspaceId: 1, userId: 1 });
TravelBookingSchema.index({ userId: 1, bookedAt: -1 });
TravelBookingSchema.index({ tenantId: 1, bookedAt: -1 });
TravelBookingSchema.index({ service: 1, bookedAt: -1 });
TravelBookingSchema.index({ status: 1 });
TravelBookingSchema.index({ reference: 1 }, { unique: true, sparse: true });
TravelBookingSchema.index({ travelDate: -1 });

export default model<ITravelBooking>("TravelBooking", TravelBookingSchema);
