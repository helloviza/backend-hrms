// apps/backend/src/config/visaFeaturedDestinations.ts
//
// Ops-editable ordered list of "frequently requested" visa destinations —
// shown ahead of the full published catalogue on the destination picker
// (apps/frontend/src/pages/visa/select/DestinationGrid.tsx). This is a
// curated shortlist, not a demand ranking: Plumtrips doesn't have the
// booking volume to support a real "most popular" computation, and a
// "trending"/"popular this week" label or a refresh schedule would imply
// one that doesn't exist. Edit this array by hand to change what ops
// considers frequently requested; array order is preserved in the UI.
//
// A code listed here with no PUBLISHED VisaRule is silently dropped by
// GET /visa/destinations (routes/visa.ts) rather than erroring — this list
// does not need to stay in lockstep with what's currently published, and
// re-publishing/unpublishing a destination doesn't require touching it.
//
// Seeded 2026-08-05 against Plumtrips' actual published catalogue (default
// nationality IN): Gulf business/leisure, Southeast Asia leisure, Schengen/
// UK/US long-haul, Australia, and Türkiye's recent surge in Indian outbound
// demand. Ops should replace this with real corridor data as it becomes
// available.
export const VISA_FEATURED_DESTINATIONS: readonly string[] = [
  "AE", // United Arab Emirates
  "SG", // Singapore
  "MY", // Malaysia
  "TR", // Türkiye
  "GB", // United Kingdom
  "DE", // Germany (Schengen)
  "FR", // France (Schengen)
  "IT", // Italy (Schengen)
  "US", // United States
  "AU", // Australia
  "SA", // Saudi Arabia
  "VN", // Vietnam
];
