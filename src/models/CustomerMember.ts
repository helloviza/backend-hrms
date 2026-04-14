// apps/backend/src/models/CustomerMember.ts
import mongoose, { Schema, type Document, type Model } from "mongoose";

export type CustomerMemberRole = "WORKSPACE_LEADER" | "APPROVER" | "REQUESTER";

export interface CustomerMemberDocument extends Document {
  customerId: string;
  email: string;
  name?: string;
  role: CustomerMemberRole;

  isActive: boolean;

  bandNumber?: number | null;

  createdBy?: string; // sub/email of creator
  invitedAt?: Date;
  lastInviteAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

const CustomerMemberSchema = new Schema<CustomerMemberDocument>(
  {
    customerId: { type: String, required: true, index: true },
    email: { type: String, required: true, index: true, lowercase: true, trim: true },
    name: { type: String, trim: true },
    role: { type: String, required: true, index: true },

    isActive: { type: Boolean, default: true, index: true },

    bandNumber: { type: Number, default: null, min: 1, max: 10 },

    createdBy: { type: String },
    invitedAt: { type: Date },
    lastInviteAt: { type: Date },
  },
  { timestamps: true }
);

// unique per customer workspace
CustomerMemberSchema.index({ customerId: 1, email: 1 }, { unique: true });

const CustomerMember: Model<CustomerMemberDocument> =
  mongoose.models.CustomerMember ||
  mongoose.model<CustomerMemberDocument>("CustomerMember", CustomerMemberSchema);

export default CustomerMember;
