// apps/backend/src/config/platformCapabilities.ts
//
// PLATFORM CAPABILITIES — build state, not workspace toggles.
//
// These say whether the PLATFORM can answer a question at all. They are
// deliberately NOT CustomerWorkspace feature flags: a per-tenant toggle
// would imply the capability exists and is merely switched off, which
// would be a lie for both of these today.
//
// Each is the SINGLE place to flip when the corresponding feature ships.
//
// Lifted out of routes/visa.ts (where it was a private const) so a second
// consumer can read it without importing a Router: routes/workspace.travellers.ts
// gates PAN/Aadhaar capture on mrzEncryptionAtRest, and it must be the SAME
// flag the visa compliance badge reads, not a copy that can drift out of step
// with it. routes/visa.ts imports this and its behaviour is unchanged.
// See infra/design/universal-traveller-profile-2026-08-11.md §4.

export const VISA_PLATFORM_CAPABILITIES = {
  /**
   * Visa readiness scoring (the "AURA" engine in the design references).
   * FALSE — the engine does not exist and there is no calculator route
   * anywhere in the codebase. While false, the dashboard renders the
   * scoring section and its launch control in a disabled/unavailable
   * state and shows "—" in the per-traveller score column. It must never
   * render a mean or a per-person score: that would be a false approval
   * prediction about a real person's visa.
   */
  visaScoreEngine: false,

  /**
   * Encryption at rest for identity numbers. FALSE — passport MRZ is
   * stored unencrypted; encryption-at-rest was split out of the
   * traveller-profiles work as its own unscheduled proposal and has not
   * been built.
   *
   * TWO things key off this flag, and both must stay honest:
   *
   *   1. /visa/workspace's compliance slot. While false it shows an
   *      honest in-progress state; it must NOT render the design
   *      reference's "100% DPDP 2023 Compliant / Zero unencrypted MRZ
   *      storage" claim, because that claim would be false and it is
   *      exactly the assurance a customer would rely on when deciding
   *      whether to upload passports.
   *
   *   2. PAN / Aadhaar capture on TravellerProfile (number AND card
   *      image). While false the FIELDS exist but every write is refused
   *      — for every role, SUPERADMIN included, because this is a
   *      build-state gate and not a permission — and the UI says so
   *      plainly instead of promising encryption it does not have.
   *      Passport front/back images are NOT gated: a passport scan is not
   *      a regulated national ID number, and passport data already lives
   *      in this collection unencrypted with the badge saying as much.
   *
   * Flipping this to true is necessary but NOT sufficient for the DPDP
   * wording — "we encrypt at rest" and "we are DPDP compliant" are
   * different statements and the second needs its own sign-off. It earns
   * the "encrypted at rest" sentence and the PAN/Aadhaar capture, and
   * nothing else.
   */
  mrzEncryptionAtRest: false,
} as const;

/**
 * The one question both PAN/Aadhaar gates ask. A named helper rather than
 * reading the boolean at each call site, so the reason a write is refused
 * is stated once and every refusal message can point at the same place.
 */
export function isIdentityNumberCaptureEnabled(): boolean {
  return VISA_PLATFORM_CAPABILITIES.mrzEncryptionAtRest;
}

/**
 * The refusal, worded once. Says what is true (not encrypted, so not
 * collected) rather than "unavailable", which reads as a bug.
 */
export const IDENTITY_CAPTURE_DISABLED_MESSAGE =
  "Secure capture is not available yet — PAN and Aadhaar are stored unencrypted today, so we are not collecting them.";
