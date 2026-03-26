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

  config: {
    travelFlow: "SBT" | "APPROVAL_FLOW" | "APPROVAL_DIRECT" | "HYBRID";
    approval: {
      requireL2: boolean;
      requireL0: boolean;
      requireProposal: boolean;
    };
    tokenExpiryHours: number;
    features: {
      sbtEnabled: boolean;
      approvalFlowEnabled: boolean;
      approvalDirectEnabled: boolean;
      flightBookingEnabled: boolean;
      hotelBookingEnabled: boolean;
      visaEnabled: boolean;
      miceEnabled: boolean;
      forexEnabled: boolean;
    };
  };

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

    config: {
      travelFlow: { type: String, enum: ["SBT", "APPROVAL_FLOW", "APPROVAL_DIRECT", "HYBRID"], default: "APPROVAL_FLOW" },
      approval: {
        requireL2: { type: Boolean, default: true },
        requireL0: { type: Boolean, default: false },
        requireProposal: { type: Boolean, default: true },
      },
      tokenExpiryHours: { type: Number, default: 12 },
      features: {
        sbtEnabled: { type: Boolean, default: false },
        approvalFlowEnabled: { type: Boolean, default: true },
        approvalDirectEnabled: { type: Boolean, default: false },
        flightBookingEnabled: { type: Boolean, default: true },
        hotelBookingEnabled: { type: Boolean, default: true },
        visaEnabled: { type: Boolean, default: false },
        miceEnabled: { type: Boolean, default: false },
        forexEnabled: { type: Boolean, default: false },
      },
    },

    status: { type: String, default: "ACTIVE", index: true },
  },
  { timestamps: true }
);

const CustomerWorkspace: Model<CustomerWorkspaceDocument> =
  mongoose.models.CustomerWorkspace ||
  mongoose.model<CustomerWorkspaceDocument>("CustomerWorkspace", CustomerWorkspaceSchema);

export default CustomerWorkspace;
