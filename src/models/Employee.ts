// apps/backend/src/models/Employee.ts
import { Schema, model, Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface EmployeeDoc extends Document {
  workspaceId: Schema.Types.ObjectId;
  fullName?: string;
  name?: string;
  email?: string;
  phone?: string;
  employeeCode?: string;
  employeeId?: string;

  department?: string;
  location?: string;
  jobTitle?: string;
  designation?: string;

  status?: string; // ACTIVE / INACTIVE / EXITED
  isActive?: boolean;
  joiningDate?: Date;

  // 🔗 onboarding linkage
  onboardingId?: Schema.Types.ObjectId;
  onboardingSnapshot?: any;

  // reporting
  managerId?: Schema.Types.ObjectId | null;

  // ownership
  ownerId?: Schema.Types.ObjectId;
}

const EmployeeSchema = new Schema<EmployeeDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },

    /* ============================================================
       CORE IDENTITY
       ============================================================ */
    fullName: { type: String, trim: true },
    name: { type: String, trim: true },

    email: { type: String, trim: true, lowercase: true, index: true },
    phone: { type: String, trim: true },

    employeeCode: { type: String, index: true },
    employeeId: { type: String, index: true },

    /* ============================================================
       ORG DETAILS
       ============================================================ */
    department: { type: String, trim: true },
    location: { type: String, trim: true },
    jobTitle: { type: String, trim: true },
    designation: { type: String, trim: true },

    /* ============================================================
       STATUS
       ============================================================ */
    status: {
      type: String,
      default: "ACTIVE",
      set: (v: string) => String(v || "ACTIVE").toUpperCase(),
    },

    isActive: { type: Boolean, default: true },

    joiningDate: { type: Date },

    /* ============================================================
       REPORTING / ORG CHART
       ============================================================ */
    managerId: { type: Schema.Types.ObjectId, ref: "Employee", default: null },

    /* ============================================================
       ONBOARDING LINKAGE (CONSISTENT WITH VENDOR & CUSTOMER)
       ============================================================ */
    onboardingId: { type: Schema.Types.ObjectId, ref: "Onboarding" },

    onboardingSnapshot: {
      type: Schema.Types.Mixed, // full formPayload snapshot
    },

    /* ============================================================
       OWNERSHIP
       ============================================================ */
    ownerId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

EmployeeSchema.plugin(workspaceScopePlugin);
EmployeeSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

// Indexes for performance
EmployeeSchema.index({ employeeCode: 1 });
EmployeeSchema.index({ employeeId: 1 });
EmployeeSchema.index({ status: 1 });
EmployeeSchema.index({ department: 1 });
EmployeeSchema.index({ location: 1 });

EmployeeSchema.methods.toJSON = function () {
  const obj: any = this.toObject();
  if (obj.status) obj.status = String(obj.status).toUpperCase();
  return obj;
};

export default model<EmployeeDoc>("Employee", EmployeeSchema);
