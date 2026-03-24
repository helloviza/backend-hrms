import mongoose, { Schema, type Document, type Model } from "mongoose";

export interface CustomerWorkspaceDocument extends Document {
  customerId: string;

  // Existing (legacy / workspace resolution + invite gating)
  allowedDomains: string[];
  allowedEmails: string[];

  accessMode: "INVITE_ONLY" | "COMPANY_DOMAIN" | "EMAIL_ALLOWLIST";

  defaultApproverEmails: string[]; // L2
  canApproverCreateUsers: boolean;

  // Admin switch: staff must enable before leaders/approvers can manage users
  userCreationEnabled: boolean;

  // ✅ NEW: User Creation Access Allowlist (workspace-scoped)
  userCreationAllowlistEmails: string[];
  userCreationAllowlistDomains: string[];
  userCreationAllowlistUpdatedBy: string;
  userCreationAllowlistUpdatedAt?: Date;

  travelMode: "SBT" | "FLIGHTS_ONLY" | "HOTELS_ONLY" | "BOTH" | "APPROVAL_FLOW";

  status: "ACTIVE" | "INACTIVE" | "DELETED";

  createdAt?: Date;
  updatedAt?: Date;
}

const CustomerWorkspaceSchema = new Schema<CustomerWorkspaceDocument>(
  {
    customerId: { type: String, required: true, index: true, unique: true },

    allowedDomains: { type: [String], default: [] },
    allowedEmails: { type: [String], default: [] },

    accessMode: { type: String, enum: ["INVITE_ONLY", "COMPANY_DOMAIN", "EMAIL_ALLOWLIST"], default: "INVITE_ONLY" },

    defaultApproverEmails: { type: [String], default: [] },
    canApproverCreateUsers: { type: Boolean, default: true },

    userCreationEnabled: { type: Boolean, default: false, index: true },

    // ✅ NEW allowlist fields
    userCreationAllowlistEmails: { type: [String], default: [] },
    userCreationAllowlistDomains: { type: [String], default: [] },
    userCreationAllowlistUpdatedBy: { type: String, default: "" },
    userCreationAllowlistUpdatedAt: { type: Date },

    travelMode: { type: String, enum: ["SBT", "FLIGHTS_ONLY", "HOTELS_ONLY", "BOTH", "APPROVAL_FLOW"], default: "APPROVAL_FLOW" },

    status: { type: String, default: "ACTIVE", index: true },
  },
  { timestamps: true }
);

const CustomerWorkspace: Model<CustomerWorkspaceDocument> =
  mongoose.models.CustomerWorkspace ||
  mongoose.model<CustomerWorkspaceDocument>("CustomerWorkspace", CustomerWorkspaceSchema);

export default CustomerWorkspace;
