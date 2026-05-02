import type { ModulePermission } from '../models/UserPermission.js'

// ── Shorthands ────────────────────────────────────────────────────────────────
const FULL_OWN:   ModulePermission = { access: 'FULL',  scope: 'OWN'       }
const FULL_ALL:   ModulePermission = { access: 'FULL',  scope: 'ALL'       }
const FULL_WS:    ModulePermission = { access: 'FULL',  scope: 'WORKSPACE' }
const FULL_TEAM:  ModulePermission = { access: 'FULL',  scope: 'TEAM'      }
const WRITE_OWN:  ModulePermission = { access: 'WRITE', scope: 'OWN'       }
const WRITE_WS:   ModulePermission = { access: 'WRITE', scope: 'WORKSPACE' }
const WRITE_TEAM: ModulePermission = { access: 'WRITE', scope: 'TEAM'      }
const READ_OWN:   ModulePermission = { access: 'READ',  scope: 'OWN'       }
const READ_ALL:   ModulePermission = { access: 'READ',  scope: 'ALL'       }
const READ_WS:    ModulePermission = { access: 'READ',  scope: 'WORKSPACE' }
const READ_TEAM:  ModulePermission = { access: 'READ',  scope: 'TEAM'      }
const NONE:       ModulePermission = { access: 'NONE',  scope: 'NONE'      }

// ── Module map type ───────────────────────────────────────────────────────────
type ModulesTemplate = {
  // HR & People
  myProfile:         ModulePermission
  attendance:        ModulePermission
  leaves:            ModulePermission
  leaveApprovals:    ModulePermission
  holidays:          ModulePermission
  holidayManagement: ModulePermission
  orgChart:          ModulePermission
  policies:          ModulePermission
  teamProfiles:      ModulePermission
  teamPresence:      ModulePermission
  teamCalendar:      ModulePermission
  hrWorkspace:       ModulePermission
  onboarding:        ModulePermission
  people:            ModulePermission
  masterData:        ModulePermission
  // Payroll
  payroll:           ModulePermission
  payrollAdmin:      ModulePermission
  // Bookings & Billing
  adminQueue:        ModulePermission
  manualBookings:    ModulePermission
  invoices:          ModulePermission
  reports:           ModulePermission
  companySettings:   ModulePermission
  adminVouchers:     ModulePermission
  voucherExtract:    ModulePermission
  // Admin & System
  analytics:         ModulePermission
  workspaceSettings: ModulePermission
  accessConsole:     ModulePermission
  sbt:               ModulePermission
  // Travel (Customer universe)
  sbtSearch:         ModulePermission
  sbtBookings:       ModulePermission
  sbtRequest:        ModulePermission
  approvals:         ModulePermission
  travelSpend:       ModulePermission
  // Vendor universe
  vendorProfile:     ModulePermission
  // Operations
  supportTickets:    ModulePermission
}

// ── L1 — Employee (base) ──────────────────────────────────────────────────────
const L1: ModulesTemplate = {
  myProfile:         FULL_OWN,
  attendance:        WRITE_OWN,
  leaves:            WRITE_OWN,
  leaveApprovals:    NONE,
  holidays:          READ_ALL,
  holidayManagement: NONE,
  orgChart:          READ_WS,
  policies:          READ_WS,
  teamProfiles:      NONE,
  teamPresence:      NONE,
  teamCalendar:      READ_WS,
  hrWorkspace:       NONE,
  onboarding:        NONE,
  people:            NONE,
  masterData:        NONE,
  payroll:           READ_OWN,
  payrollAdmin:      NONE,
  adminQueue:        NONE,
  manualBookings:    NONE,
  invoices:          NONE,
  reports:           NONE,
  companySettings:   NONE,
  adminVouchers:     NONE,
  voucherExtract:    NONE,
  analytics:         NONE,
  workspaceSettings: NONE,
  accessConsole:     NONE,
  sbt:               NONE,
  sbtSearch:         NONE,
  sbtBookings:       NONE,
  sbtRequest:        NONE,
  approvals:         NONE,
  travelSpend:       NONE,
  vendorProfile:     NONE,
  supportTickets:    NONE,
}

// ── L2 — Senior Employee ──────────────────────────────────────────────────────
const L2: ModulesTemplate = {
  ...L1,
  teamProfiles: READ_TEAM,
  teamCalendar: READ_TEAM,
}

// ── L3 — Team Leader ──────────────────────────────────────────────────────────
const L3: ModulesTemplate = {
  ...L2,
  leaveApprovals: WRITE_TEAM,
  teamProfiles:   WRITE_TEAM,
  attendance:     READ_TEAM,
  teamPresence:   READ_TEAM,
}

// ── L4 — Manager ─────────────────────────────────────────────────────────────
const L4: ModulesTemplate = {
  ...L3,
  teamProfiles:   FULL_WS,
  leaveApprovals: FULL_TEAM,
  reports:        READ_TEAM,
  analytics:      READ_TEAM,
}

// ── L5 — HR ───────────────────────────────────────────────────────────────────
const L5: ModulesTemplate = {
  ...L4,
  hrWorkspace:       FULL_WS,
  holidayManagement: WRITE_WS,
  leaveApprovals:    FULL_WS,
  onboarding:        FULL_WS,
  people:            WRITE_WS,
  masterData:        WRITE_WS,
  payrollAdmin:      WRITE_WS,
  attendance:        FULL_WS,
  reports:           READ_WS,
  analytics:         READ_WS,
  workspaceSettings: READ_WS,
}

// ── L6 — Admin ────────────────────────────────────────────────────────────────
const L6: ModulesTemplate = {
  ...L5,
  adminQueue:        FULL_ALL,
  manualBookings:    FULL_ALL,
  invoices:          FULL_ALL,
  reports:           FULL_ALL,
  companySettings:   FULL_ALL,
  adminVouchers:     FULL_ALL,
  voucherExtract:    FULL_ALL,
  analytics:         FULL_ALL,
  workspaceSettings: FULL_WS,
  sbt:               FULL_WS,
  payrollAdmin:      FULL_WS,
  accessConsole:     NONE, // Admin cannot manage access — SuperAdmin only
}

// ── L7 — MIS / Reporting ──────────────────────────────────────────────────────
const L7: ModulesTemplate = {
  ...L1,
  reports:        FULL_ALL,
  analytics:      READ_ALL,
  manualBookings: READ_ALL,
  invoices:       READ_ALL,
  adminVouchers:  READ_ALL,
}

// ── L8 — Super Admin (display-only template) ──────────────────────────────────
const L8: ModulesTemplate = {
  myProfile:         FULL_ALL,
  attendance:        FULL_ALL,
  leaves:            FULL_ALL,
  leaveApprovals:    FULL_ALL,
  holidays:          FULL_ALL,
  holidayManagement: FULL_ALL,
  orgChart:          FULL_ALL,
  policies:          FULL_ALL,
  teamProfiles:      FULL_ALL,
  teamPresence:      FULL_ALL,
  teamCalendar:      FULL_ALL,
  hrWorkspace:       FULL_ALL,
  onboarding:        FULL_ALL,
  people:            FULL_ALL,
  masterData:        FULL_ALL,
  payroll:           FULL_ALL,
  payrollAdmin:      FULL_ALL,
  adminQueue:        FULL_ALL,
  manualBookings:    FULL_ALL,
  invoices:          FULL_ALL,
  reports:           FULL_ALL,
  companySettings:   FULL_ALL,
  adminVouchers:     FULL_ALL,
  voucherExtract:    FULL_ALL,
  analytics:         FULL_ALL,
  workspaceSettings: FULL_ALL,
  accessConsole:     FULL_ALL,
  sbt:               FULL_ALL,
  sbtSearch:         FULL_ALL,
  sbtBookings:       FULL_ALL,
  sbtRequest:        FULL_ALL,
  approvals:         FULL_ALL,
  travelSpend:       FULL_ALL,
  vendorProfile:     FULL_ALL,
  supportTickets:    FULL_ALL,
}

// ── VENDOR template ───────────────────────────────────────────────────────────
const VENDOR: ModulesTemplate = {
  myProfile:         NONE,
  attendance:        NONE,
  leaves:            NONE,
  leaveApprovals:    NONE,
  holidays:          NONE,
  holidayManagement: NONE,
  orgChart:          READ_WS,
  policies:          READ_WS,
  teamProfiles:      NONE,
  teamPresence:      NONE,
  teamCalendar:      NONE,
  hrWorkspace:       NONE,
  onboarding:        NONE,
  people:            NONE,
  masterData:        NONE,
  payroll:           NONE,
  payrollAdmin:      NONE,
  adminQueue:        NONE,
  manualBookings:    NONE,
  invoices:          NONE,
  reports:           NONE,
  companySettings:   NONE,
  adminVouchers:     NONE,
  voucherExtract:    NONE,
  analytics:         NONE,
  workspaceSettings: NONE,
  accessConsole:     NONE,
  sbt:               NONE,
  sbtSearch:         NONE,
  sbtBookings:       NONE,
  sbtRequest:        NONE,
  approvals:         NONE,
  travelSpend:       READ_OWN,
  vendorProfile:     FULL_OWN,
  supportTickets:    NONE,
}

// ── CUSTOMER_SBT template ─────────────────────────────────────────────────────
const CUSTOMER_SBT: ModulesTemplate = {
  myProfile:         NONE,
  attendance:        NONE,
  leaves:            NONE,
  leaveApprovals:    NONE,
  holidays:          NONE,
  holidayManagement: NONE,
  orgChart:          NONE,
  policies:          NONE,
  teamProfiles:      NONE,
  teamPresence:      NONE,
  teamCalendar:      NONE,
  hrWorkspace:       NONE,
  onboarding:        NONE,
  people:            NONE,
  masterData:        NONE,
  payroll:           NONE,
  payrollAdmin:      NONE,
  adminQueue:        NONE,
  manualBookings:    NONE,
  invoices:          NONE,
  reports:           NONE,
  companySettings:   NONE,
  adminVouchers:     NONE,
  voucherExtract:    NONE,
  analytics:         NONE,
  workspaceSettings: NONE,
  accessConsole:     NONE,
  sbt:               NONE,
  sbtSearch:         WRITE_OWN,
  sbtBookings:       READ_OWN,
  sbtRequest:        WRITE_OWN,
  approvals:         NONE,
  travelSpend:       READ_WS,
  vendorProfile:     NONE,
  supportTickets:    NONE,
}

// ── CUSTOMER_APPROVAL template ────────────────────────────────────────────────
const CUSTOMER_APPROVAL: ModulesTemplate = {
  myProfile:         NONE,
  attendance:        NONE,
  leaves:            NONE,
  leaveApprovals:    NONE,
  holidays:          NONE,
  holidayManagement: NONE,
  orgChart:          NONE,
  policies:          NONE,
  teamProfiles:      NONE,
  teamPresence:      NONE,
  teamCalendar:      NONE,
  hrWorkspace:       NONE,
  onboarding:        NONE,
  people:            NONE,
  masterData:        NONE,
  payroll:           NONE,
  payrollAdmin:      NONE,
  adminQueue:        NONE,
  manualBookings:    NONE,
  invoices:          NONE,
  reports:           NONE,
  companySettings:   NONE,
  adminVouchers:     NONE,
  voucherExtract:    NONE,
  analytics:         NONE,
  workspaceSettings: NONE,
  accessConsole:     NONE,
  sbt:               NONE,
  sbtSearch:         NONE,
  sbtBookings:       NONE,
  sbtRequest:        NONE,
  approvals:         WRITE_OWN,
  travelSpend:       READ_WS,
  vendorProfile:     NONE,
  supportTickets:    NONE,
}

// ── Exports ───────────────────────────────────────────────────────────────────

export const LEVEL_TEMPLATES: Record<string, ModulesTemplate> = {
  L1,
  L2,
  L3,
  L4,
  L5,
  L6,
  L7,
  L8,
  VENDOR,
  CUSTOMER_SBT,
  CUSTOMER_APPROVAL,
}

export interface LevelMetadata {
  code: string
  name: string
  description: string
}

export const LEVEL_METADATA: LevelMetadata[] = [
  { code: 'L1', name: 'Employee',        description: 'Basic staff access' },
  { code: 'L2', name: 'Senior Employee', description: 'Basic staff access with team visibility' },
  { code: 'L3', name: 'Team Leader',     description: 'Can manage team attendance and leave approvals' },
  { code: 'L4', name: 'Manager',         description: 'Full team management with reporting access' },
  { code: 'L5', name: 'HR',              description: 'HR workspace, onboarding, payroll, and people ops' },
  { code: 'L6', name: 'Admin',           description: 'Full operational access including billing and bookings' },
  { code: 'L7', name: 'MIS / Reporting', description: 'Read-only reporting and analytics access' },
  { code: 'L8', name: 'Super Admin',     description: 'Unrestricted access to all modules (bypasses DB lookup)' },
  { code: 'VENDOR',            name: 'Vendor',            description: 'Vendor profile and limited workspace visibility' },
  { code: 'CUSTOMER_SBT',      name: 'Customer (SBT)',    description: 'Self-booking tool access for travel customers' },
  { code: 'CUSTOMER_APPROVAL', name: 'Customer (Approver)', description: 'Travel approval and spend visibility' },
]
