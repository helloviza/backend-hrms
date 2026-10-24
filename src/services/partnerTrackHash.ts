// apps/backend/src/services/partnerTrackHash.ts
//
// The salted email hash "Track my case" looks students up by. Kept apart from
// services/partnerTrack.ts so the intake (services/partnerIntake.create.ts)
// can stamp meta.partnerLead.contactEmailHash at case create without pulling
// in the track service.
import crypto from "crypto";

const salt = () => process.env.PARTNER_LEAD_IP_SALT || process.env.JWT_SECRET || "";

export const trackSalt = salt;
export const trackHmac = (label: string, value: string) => crypto.createHmac("sha256", `${label}:${salt()}`).update(value).digest("hex");

export const normEmail = (v: any) => String(v ?? "").trim().toLowerCase();
export const emailHash = (email: string) => trackHmac("partner-track-email", normEmail(email));

/** The stored lookup hash for a case's contact email, or undefined when there is no email. */
export function contactEmailHashOf(email: any): string | undefined {
  return normEmail(email) ? emailHash(email) : undefined;
}
