import mongoose, { Schema, model, type Document } from "mongoose";

export interface IBillingPermission extends Document {
  userId: string;
  email: string;
  workspaceId: string;
  pages: Array<"manualBookings" | "invoices" | "reports" | "companySettings">;
  grantedBy: string;
  grantedAt: Date;
  updatedBy?: string;
  updatedAt?: Date;
}

const BillingPermissionSchema = new Schema<IBillingPermission>(
  {
    userId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },
    workspaceId: { type: String, required: true },
    pages: [
      {
        type: String,
        enum: ["manualBookings", "invoices", "reports", "companySettings"],
      },
    ],
    grantedBy: { type: String, required: true },
    grantedAt: { type: Date, default: Date.now },
    updatedBy: { type: String },
    updatedAt: { type: Date },
  },
  { timestamps: false }
);

BillingPermissionSchema.index({ userId: 1 }, { unique: true });
BillingPermissionSchema.index({ email: 1 });
BillingPermissionSchema.index({ workspaceId: 1 });

const BillingPermission = model<IBillingPermission>(
  "BillingPermission",
  BillingPermissionSchema
);

export default BillingPermission;
