// Assignment-driven seller-GST profile resolver.
//
// Selection order: per-invoice override → per-client default (lands on
// Customer in a later step; accepted here but currently always undefined) →
// global isDefault profile. If the registry is empty (or has no active
// isDefault profile), synthesizes a profile from the flat CompanySettings
// fields so behaviour is identical to pre-registry invoices.
import type { ICompanySettings, IGstProfile } from "../models/CompanySettings.js";

export interface SellerGstProfile {
  gstin: string;
  legalName: string;
  state: string;
  stateCode: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  pincode: string;
  country: string;
  isDefault: boolean;
}

// Typed error — an explicit override that doesn't match any ACTIVE company
// registration must fail loudly (400), never silently fall back. Falling
// back here would issue an invoice under a GSTIN the caller did not choose.
export class SellerGstinNotFoundError extends Error {
  constructor(public gstin: string) {
    super(`seller GSTIN ${gstin} is not an active company registration`);
    this.name = "SellerGstinNotFoundError";
  }
}

function toSellerProfile(p: IGstProfile, companySettings: ICompanySettings): SellerGstProfile {
  return {
    gstin: p.gstin,
    legalName: p.legalName || companySettings.companyName || "",
    state: p.state,
    stateCode: p.stateCode,
    addressLine1: p.addressLine1 || "",
    addressLine2: p.addressLine2 || "",
    city: p.city || "",
    pincode: p.pincode || "",
    country: (companySettings as any).country || "India",
    isDefault: !!p.isDefault,
  };
}

function synthesizeFromFlatFields(companySettings: ICompanySettings): SellerGstProfile {
  return {
    gstin: companySettings.gstin || "",
    legalName: companySettings.companyName || "",
    state: companySettings.supplierState || (companySettings as any).state || "Karnataka",
    stateCode: companySettings.supplierStateCode || "",
    addressLine1: (companySettings as any).addressLine1 || "",
    addressLine2: (companySettings as any).addressLine2 || "",
    city: (companySettings as any).city || "",
    pincode: (companySettings as any).pincode || "",
    country: (companySettings as any).country || "India",
    isDefault: true,
  };
}

export function resolveSellerGstProfile(input: {
  overrideGstin?: string;
  customerDefaultGstin?: string;
  companySettings: ICompanySettings;
}): SellerGstProfile {
  const { overrideGstin, customerDefaultGstin, companySettings } = input;
  const allProfiles = (companySettings.gstProfiles || []) as unknown as IGstProfile[];
  const activeProfiles = allProfiles.filter((p) => p.active);

  // (b) Explicit per-invoice override — must match an ACTIVE profile or throw.
  if (overrideGstin) {
    const found = activeProfiles.find((p) => p.gstin.toUpperCase() === overrideGstin.toUpperCase());
    if (!found) throw new SellerGstinNotFoundError(overrideGstin);
    return toSellerProfile(found, companySettings);
  }

  // (c) Per-client default — config drift (stale/renamed GSTIN) falls through
  // to the global default rather than blocking invoice generation.
  if (customerDefaultGstin) {
    const found = activeProfiles.find((p) => p.gstin.toUpperCase() === customerDefaultGstin.toUpperCase());
    if (found) return toSellerProfile(found, companySettings);
    console.warn(
      `[sellerGstResolver] customerDefaultGstin "${customerDefaultGstin}" is not an active company registration — falling through to global default`,
    );
  }

  // (d) Global default.
  const defaultProfile = activeProfiles.find((p) => p.isDefault);
  if (defaultProfile) return toSellerProfile(defaultProfile, companySettings);

  // (e) Registry empty (or no active default found) — backward-compat path,
  // identical to pre-registry behaviour.
  return synthesizeFromFlatFields(companySettings);
}
