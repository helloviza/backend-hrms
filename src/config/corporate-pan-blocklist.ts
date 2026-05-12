// TBO Hotel API spec lines 2782–2786 forbid using the agency's own PAN or
// TBO's known corporate PAN as the guest's Corporate PAN. TBO returns:
//   "TBO PAN not allowed, Please enter guest PAN Number."
// We block these BEFORE the TBO call so users get a clear in-product error
// instead of a generic supplier rejection after Razorpay has charged them.
//
// To update: add Plumtrips/Peachmint legal entity PAN(s) below in uppercase.
// If multiple legal entities have separate PANs, list all of them. If TBO
// publishes their corporate PAN(s) via support, add to TBO_CORPORATE_PANS.

export const PLUMTRIPS_AGENCY_PANS: ReadonlyArray<string> = [
  "REPLACE_WITH_PEACHMINT_PAN",
];

export const TBO_CORPORATE_PANS: ReadonlyArray<string> = [
  // TBO has not published their corporate PAN; rely on TBO's runtime error
  // until / unless support confirms specific value(s).
];

export const BLOCKED_CORPORATE_PANS: ReadonlySet<string> = new Set<string>(
  [...PLUMTRIPS_AGENCY_PANS, ...TBO_CORPORATE_PANS]
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p && p !== "REPLACE_WITH_PEACHMINT_PAN")
);
