import { Schema, model, type Document } from "mongoose";

export interface ISBTRequest extends Document {
  customerId: Schema.Types.ObjectId;
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
  }[];
  contactDetails?: {
    email?: string;
    phone?: string;
  };
  bookerNotes?: string;
  requestedAt: Date;
  actedAt?: Date;
  cancelledAt?: Date;
}

const SBTRequestSchema = new Schema({
  customerId: { type: Schema.Types.ObjectId, required: true, index: true },
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
  }],
  contactDetails: {
    email: { type: String },
    phone: { type: String },
  },
  bookerNotes: { type: String, default: null },

  requestedAt: { type: Date, default: Date.now },
  actedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
});

SBTRequestSchema.index({ requesterId: 1, status: 1 });
SBTRequestSchema.index({ assignedBookerId: 1, status: 1 });
SBTRequestSchema.index({ customerId: 1, status: 1 });

export default model<ISBTRequest>("SBTRequest", SBTRequestSchema);
