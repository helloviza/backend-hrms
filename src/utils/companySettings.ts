import CompanySettings from "../models/CompanySettings.js";

export interface ResolvedCompanySettings {
  supportEmail: string;
  opsEmail: string;
  accountManagerEmail: string;
  reportsFromEmail: string;
  reportsFromName: string;
  companyName: string;
}

const DEFAULTS: ResolvedCompanySettings = {
  supportEmail: "hello@plumtrips.com",
  opsEmail: "neelb@plumtrips.com",
  accountManagerEmail: "",
  reportsFromEmail: "",
  reportsFromName: "Plumtrips",
  companyName: "Plumtrips",
};

let _cache: ResolvedCompanySettings | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000;

export async function getCompanySettings(): Promise<ResolvedCompanySettings> {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;

  const doc = await CompanySettings.findOne().lean();

  _cache = {
    supportEmail: doc?.supportEmail || DEFAULTS.supportEmail,
    opsEmail: doc?.opsEmail || DEFAULTS.opsEmail,
    accountManagerEmail: doc?.accountManagerEmail || "",
    reportsFromEmail: doc?.reportsFromEmail || DEFAULTS.reportsFromEmail,
    reportsFromName: doc?.reportsFromName || DEFAULTS.reportsFromName,
    companyName: doc?.companyName || DEFAULTS.companyName,
  };
  _cacheTime = now;
  return _cache;
}

export function invalidateCompanySettingsCache() {
  _cache = null;
  _cacheTime = 0;
}
