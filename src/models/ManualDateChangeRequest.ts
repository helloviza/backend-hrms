import { Schema, model, type Document } from "mongoose";

export type DCRStatus = "REQUESTED" | "IN_DISCUSSION" | "APPROVED" | "DENIED" | "RESOLVED";

export interface IManualDateChangeRequest extends Document {
  bookingId: string;
  mongoBookingId: string;
  hotelName: string;
  originalCheckIn: string;
  originalCheckOut: string;
  requestedNewCheckIn: string;
  requestedNewCheckOut: string;
  customerNotes: string;
  guestName: string;
  guestEmail?: string;
  workspaceId?: Schema.Types.ObjectId;
  userId?: Schema.Types.ObjectId;
  status: DCRStatus;
  opsNotes: string;
  resolvedBy?: string;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ManualDateChangeRequestSchema = new Schema<IManualDateChangeRequest>(
  {
    bookingId: { type: String, default: "" },
    mongoBookingId: { type: String, required: true, index: true },
    hotelName: { type: String, default: "" },
    originalCheckIn: { type: String, default: "" },
    originalCheckOut: { type: String, default: "" },
    requestedNewCheckIn: { type: String, required: true },
    requestedNewCheckOut: { type: String, required: true },
    customerNotes: { type: String, default: "" },
    guestName: { type: String, default: "" },
    guestEmail: { type: String, default: "" },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    status: {
      type: String,
      enum: ["REQUESTED", "IN_DISCUSSION", "APPROVED", "DENIED", "RESOLVED"],
      default: "REQUESTED",
      index: true,
    },
    opsNotes: { type: String, default: "" },
    resolvedBy: { type: String, default: "" },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ManualDateChangeRequestSchema.index({ status: 1, createdAt: -1 });
ManualDateChangeRequestSchema.index({ workspaceId: 1, createdAt: -1 });

export default model<IManualDateChangeRequest>(
  "ManualDateChangeRequest",
  ManualDateChangeRequestSchema,
);
