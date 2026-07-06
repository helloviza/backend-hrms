// apps/backend/src/config/demoSeedAllowlist.ts
//
// Hardcoded allowlist for the CUSTOMER-universe Demo Platform extension
// (docs/prd/demo-platform-tracker.md, Phase 2 design 2026-07-06). These three
// plumtrips.com-domain accounts are CUSTOMER-universe demo seeds, not STAFF —
// an unusual pattern (internal email domain on a customer account) that
// warrants a second, independent server-side check beyond isDemoUser:true.
// Enforced at two sites: routes/admin.demo.ts (impersonation mint) and
// routes/permissions.ts (demoAccess grant path).
export const CUSTOMER_DEMO_SEED_EMAILS = [
  "demo1@plumtrips.com",
  "demo2@plumtrips.com",
  "demo3@plumtrips.com",
] as const;

// STAFF SuperAdmins explicitly permitted to hold CUSTOMER-universe demo seeds
// in their own demoAccess.mappedSeedUsers (a deliberate universe-mismatch
// exception for sales-demo reps). Narrow and explicit on purpose — widening
// this list is a decision, not a side effect of some other change.
export const CUSTOMER_DEMO_CROSS_UNIVERSE_GRANTERS = [
  "imran.ali@plumtrips.com",
] as const;
