import mongoose, { Document, Schema } from 'mongoose'

export type AccessLevel = 'NONE' | 'READ' | 'WRITE' | 'FULL'
export type ScopeLevel = 'NONE' | 'OWN' | 'TEAM' | 'WORKSPACE' | 'ALL'

export interface ModulePermission {
  access: AccessLevel
  scope: ScopeLevel
}

const modulePermissionSchema = new Schema<ModulePermission>(
  {
    access: { type: String, enum: ['NONE', 'READ', 'WRITE', 'FULL'], default: 'NONE' },
    scope: { type: String, enum: ['NONE', 'OWN', 'TEAM', 'WORKSPACE', 'ALL'], default: 'NONE' },
  },
  { _id: false }
)

export type PermissionStatus = 'active' | 'suspended' | 'revoked'
export type PermissionTier = 0 | 1 | 2 | 3
export type PermissionRoleType = 'EMPLOYEE' | 'CLIENT' | 'VENDOR' | 'SUPERADMIN'
export type PermissionSource = 'onboarding' | 'manual' | 'migration' | 'system'

export interface UserPermissionDoc extends Document {
  userId: string
  email: string
  workspaceId: string
  universe: 'STAFF' | 'CUSTOMER' | 'VENDOR'
  source: PermissionSource

  level: {
    code: string
    name: string
    designation: string
  }

  status: PermissionStatus
  tier: PermissionTier
  grantedModules: string[]
  roleType: PermissionRoleType

  suspendedAt: Date | null
  revokedAt: Date | null
  suspendReason: string
  revokeReason: string

  modules: {
    // HR & People
    myProfile: ModulePermission
    attendance: ModulePermission
    leaves: ModulePermission
    leaveApprovals: ModulePermission
    holidays: ModulePermission
    holidayManagement: ModulePermission
    orgChart: ModulePermission
    policies: ModulePermission
    teamProfiles: ModulePermission
    teamPresence: ModulePermission
    teamCalendar: ModulePermission
    hrWorkspace: ModulePermission
    onboarding: ModulePermission
    people: ModulePermission
    masterData: ModulePermission

    // Payroll
    payroll: ModulePermission
    payrollAdmin: ModulePermission

    // Bookings & Billing
    adminQueue: ModulePermission
    manualBookings: ModulePermission
    invoices: ModulePermission
    reports: ModulePermission
    companySettings: ModulePermission
    adminVouchers: ModulePermission
    voucherExtract: ModulePermission

    // Admin & System
    analytics: ModulePermission
    workspaceSettings: ModulePermission
    accessConsole: ModulePermission
    sbt: ModulePermission

    // Travel (Customer universe)
    sbtSearch: ModulePermission
    sbtBookings: ModulePermission
    sbtRequest: ModulePermission
    approvals: ModulePermission
    travelSpend: ModulePermission

    // Vendor universe
    vendorProfile: ModulePermission

    // Operations
    supportTickets: ModulePermission
    tasks: ModulePermission
    directCustomers: ModulePermission

    // Sales CRM
    leads?: ModulePermission
    crmContacts?: ModulePermission
    crmCompanies?: ModulePermission
  }

  grantedBy: string
  grantedAt: Date
  updatedBy?: string
  updatedAt?: Date
}

const modulesSchema = new Schema(
  {
    // HR & People
    myProfile: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    attendance: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    leaves: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    leaveApprovals: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    holidays: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    holidayManagement: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    orgChart: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    policies: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    teamProfiles: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    teamPresence: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    teamCalendar: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    hrWorkspace: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    onboarding: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    people: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    masterData: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },

    // Payroll
    payroll: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    payrollAdmin: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },

    // Bookings & Billing
    adminQueue: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    manualBookings: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    invoices: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    reports: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    companySettings: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    adminVouchers: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    voucherExtract: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },

    // Admin & System
    analytics: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    workspaceSettings: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    accessConsole: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    sbt: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },

    // Travel (Customer universe)
    sbtSearch: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    sbtBookings: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    sbtRequest: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    approvals: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    travelSpend: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },

    // Vendor universe
    vendorProfile: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },

    // Operations
    supportTickets: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    tasks: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'OWN' }) },
    directCustomers: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'OWN' }) },

    // Sales CRM
    leads: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    crmContacts: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
    crmCompanies: { type: modulePermissionSchema, default: () => ({ access: 'NONE', scope: 'NONE' }) },
  },
  { _id: false }
)

const userPermissionSchema = new Schema<UserPermissionDoc>(
  {
    userId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },
    workspaceId: { type: String, required: true },
    universe: { type: String, enum: ['STAFF', 'CUSTOMER', 'VENDOR'], required: true },

    level: {
      code: { type: String, required: true },
      name: { type: String, required: true },
      designation: { type: String, default: '' },
    },

    modules: { type: modulesSchema, default: () => ({}) },

    status: {
      type: String,
      enum: ['active', 'suspended', 'revoked'],
      default: 'active',
    },
    tier: {
      type: Number,
      enum: [0, 1, 2, 3],
      default: 0,
    },
    grantedModules: { type: [String], default: [] },
    roleType: {
      type: String,
      enum: ['EMPLOYEE', 'CLIENT', 'VENDOR', 'SUPERADMIN'],
      default: 'EMPLOYEE',
    },
    suspendedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    suspendReason: { type: String, default: '' },
    revokeReason: { type: String, default: '' },

    source: {
      type: String,
      enum: ['onboarding', 'manual', 'migration', 'system'],
      default: 'manual',
    },

    grantedBy: { type: String, required: true },
    grantedAt: { type: Date, required: true, default: () => new Date() },
    updatedBy: { type: String },
    updatedAt: { type: Date },
  },
  { timestamps: false }
)

userPermissionSchema.index({ userId: 1 }, { unique: true })
userPermissionSchema.index({ email: 1 })
userPermissionSchema.index({ workspaceId: 1 })
userPermissionSchema.index({ universe: 1 })

export const UserPermission = mongoose.model<UserPermissionDoc>('UserPermission', userPermissionSchema)

export const ACCESS_LEVELS: AccessLevel[] = ['NONE', 'READ', 'WRITE', 'FULL']

/**
 * Returns true if `actual` access level is >= `required` access level.
 */
export function hasAccess(actual: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(actual) >= ACCESS_LEVELS.indexOf(required)
}
