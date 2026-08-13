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

  /**
   * UIDAI (Aadhaar) verification. FALSE — and this is a SEPARATE, STRONGER
   * gate than mrzEncryptionAtRest above, declared explicitly (2026-08-11,
   * Tab 6) rather than left absent.
   *
   * WHY IT EXISTS AS A FLAG AT ALL when nothing reads it to enable
   * anything: the design's §7.1 rule is that flipping the encryption flag
   * earns the CAPTURE of PAN/Aadhaar and NOTHING ELSE — in particular it
   * must never light up a "Verified" tick or a "UIDAI Sync" badge. A rule
   * enforced only by nobody having written the badge yet is a rule that
   * lasts until the first person who wants one; a named `false` capability
   * with a test asserting the badge never renders is a rule the codebase
   * actually holds.
   *
   * There is NO UIDAI integration anywhere in this codebase — not stubbed,
   * not configured, not behind a flag. So this cannot be flipped to true by
   * a config change: it would need a real integration that has recorded a
   * real verification event, and the badge may only appear once a specific
   * person's Aadhaar has actually been verified against it — never merely
   * because the platform is capable of it.
   *
   * A "verified" tick over a plaintext or absent store is the single worst
   * element in this design. It is precisely the assurance a person weighs
   * before handing over a national ID.
   */
  uidaiVerification: false,

  /**
   * Profile-level DPDP consent capture. FALSE — no flow anywhere asks a
   * traveller to consent to Plumtrips holding a DOSSIER about them.
   *
   * Real consent DOES exist, but it is REQUEST-scoped: VisaRequest.consents[]
   * records three clauses accepted when a specific visa request was
   * submitted. Tab 6 renders those rows, each naming its own request, and
   * must never aggregate them into a profile-level "you have consented" —
   * consent for one visa request is not blanket consent to hold a dossier.
   * See services/travellerConsent.service.ts.
   */
  profileConsentCapture: false,
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

/**
 * Whether ANY identity-verification badge ("Verified", "UIDAI Sync") may be
 * rendered against a traveller's national IDs.
 *
 * Deliberately NOT `isIdentityNumberCaptureEnabled()`. The two answer
 * different questions and the whole §7.1 rule is that they must not be
 * confused: capture asks "may we store the number", verification asks "has
 * an authority confirmed it belongs to this person". Flipping encryption on
 * earns the first and says nothing about the second.
 *
 * Returns false unconditionally today, and takes no argument on purpose: a
 * per-traveller answer would imply some traveller could be verified, and
 * none can be, because no verification event exists anywhere in this
 * codebase to record one.
 */
export function isIdentityVerificationAvailable(): boolean {
  return VISA_PLATFORM_CAPABILITIES.uidaiVerification;
}

/**
 * Whether a traveller has ever been asked to consent to this PROFILE being
 * held — as opposed to consenting on a specific visa request.
 *
 * The honest empty for the consent tab when a traveller has no request-scoped
 * rows either: "not built yet" is true, where "no consent on file" would
 * imply we asked and they declined.
 */
export function isProfileConsentCaptureEnabled(): boolean {
  return VISA_PLATFORM_CAPABILITIES.profileConsentCapture;
}

// No positional wording ("shown below" / "above") — this string is placed by
// whichever surface renders it, and the panel puts it after the rows.
export const PROFILE_CONSENT_UNBUILT_MESSAGE =
  "Consent capture for the traveller profile isn't built yet. Consent given on individual visa requests is recorded against those requests only.";
