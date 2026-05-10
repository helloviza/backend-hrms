// apps/backend/src/utils/featureToModules.ts
//
// Maps each module key (used in UserPermission.modules) to the workspace
// feature flag(s) that gate its visibility / grantability. A module is
// allowed for a workspace when ANY of its required flags is true.
//
// MUST stay in sync with MODULE_FEATURE_MAP in
// apps/frontend/src/pages/admin/access/AccessConsole.tsx

import type { CustomerWorkspaceDocument, WorkspaceFeatures } from "../models/CustomerWorkspace.js";

const MODULE_FEATURE_MAP: Record<string, Array<keyof WorkspaceFeatures>> = {
  // HR & PEOPLE
  myProfile:         ["hrmsEnabled"],
  attendance:        ["attendanceEnabled", "hrmsEnabled"],
  leaves:            ["leaveEnabled", "hrmsEnabled"],
  leaveApprovals:    ["leaveEnabled", "hrmsEnabled"],
  holidays:          ["hrmsEnabled"],
  holidayManagement: ["hrmsEnabled"],
  orgChart:          ["hrmsEnabled"],
  policies:          ["hrmsEnabled"],
  teamProfiles:      ["hrmsEnabled"],
  teamPresence:      ["attendanceEnabled", "hrmsEnabled"],
  teamCalendar:      ["leaveEnabled", "hrmsEnabled"],
  hrWorkspace:       ["hrmsEnabled"],
  onboarding:        ["onboardingEnabled", "hrmsEnabled"],
  people:            ["hrmsEnabled"],
  masterData:        ["hrmsEnabled"],
  // PAYROLL
  payroll:           ["payrollEnabled"],
  payrollAdmin:      ["payrollEnabled"],
  // BOOKINGS & BILLING — Travel-gated (approvalFlowEnabled excluded; defaults true)
  adminQueue:        ["sbtEnabled", "approvalDirectEnabled"],
  manualBookings:    ["sbtEnabled", "approvalDirectEnabled", "invoicesEnabled"],
  invoices:          ["invoicesEnabled"],
  reports:           ["sbtEnabled", "approvalDirectEnabled", "invoicesEnabled", "vouchersEnabled"],
  companySettings:   ["sbtEnabled", "approvalDirectEnabled"],
  adminVouchers:     ["vouchersEnabled"],
  voucherExtract:    ["vouchersEnabled"],
  // ADMIN & SYSTEM
  analytics:         ["analyticsEnabled", "hrmsEnabled"],
  workspaceSettings: ["hrmsEnabled"],
  accessConsole:     ["hrmsEnabled"],
  sbt:               ["sbtEnabled"],
  // OPERATIONS
  supportTickets:    ["ticketsEnabled"],
  tasks:             ["hrmsEnabled"],
  directCustomers:   ["crmEnabled"],
};

const PLUMTRIPS_HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";

/**
 * Apply SAAS_HRMS defensive defaults to features. Mirrors frontend logic.
 * Workspaces created before Phase 1 Stage B coarse flags may have these
 * undefined; treat them as the natural defaults for SAAS_HRMS tenants.
 */
function effectiveFeatures(
  features: Partial<WorkspaceFeatures> | undefined,
  tenantType: string | undefined,
): Partial<WorkspaceFeatures> {
  const f: any = { ...(features || {}) };
  if (tenantType === "SAAS_HRMS") {
    if (f.hrmsEnabled        === undefined) f.hrmsEnabled        = true;
    if (f.attendanceEnabled  === undefined) f.attendanceEnabled  = true;
    if (f.leaveEnabled       === undefined) f.leaveEnabled       = true;
    if (f.payrollEnabled     === undefined) f.payrollEnabled     = true;
    if (f.onboardingEnabled  === undefined) f.onboardingEnabled  = true;
    if (f.analyticsEnabled   === undefined) f.analyticsEnabled   = true;
  }
  return f;
}

/**
 * Check if a single module key is grantable for a given workspace.
 * Returns true if:
 * - workspace is HOUSE (Plumtrips internal — entitled to all)
 * - module is unmapped (safe default — allow)
 * - any of the required feature flags is enabled
 */
export function isModuleGrantable(
  moduleKey: string,
  workspace: CustomerWorkspaceDocument | { _id: any; tenantType?: string; config?: any } | null | undefined,
): boolean {
  if (!workspace) return false; // Safety: no workspace context, deny

  // HOUSE bypass
  if (String((workspace as any)._id || "") === PLUMTRIPS_HOUSE_WORKSPACE_ID) {
    return true;
  }

  // Unknown module — allow (defensive default for new modules added later)
  const requiredFlags = MODULE_FEATURE_MAP[moduleKey];
  if (!requiredFlags || requiredFlags.length === 0) return true;

  const features = effectiveFeatures(
    (workspace as any).config?.features,
    (workspace as any).tenantType,
  );

  return requiredFlags.some(flag => Boolean((features as any)[flag]));
}

/**
 * Returns the set of module keys that are grantable for a given workspace.
 * Useful for filtering input or for logging.
 */
export function allowedModuleKeysFor(
  workspace: CustomerWorkspaceDocument | { _id: any; tenantType?: string; config?: any } | null | undefined,
): Set<string> {
  const allowed = new Set<string>();
  for (const moduleKey of Object.keys(MODULE_FEATURE_MAP)) {
    if (isModuleGrantable(moduleKey, workspace)) {
      allowed.add(moduleKey);
    }
  }
  return allowed;
}

export { MODULE_FEATURE_MAP };
