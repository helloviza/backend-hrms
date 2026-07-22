// apps/backend/src/utils/travellerMatch.ts
//
// Strong-match-only dedup for TravellerProfile. Duplicates are annoying;
// merging two different people is dangerous — it puts one person's passport
// on another person's booking. So: auto-link ONLY on an exact normalized
// email match, or an exact normalized (firstName, lastName) + exact DOB
// match, and even the latter is refused if an already-populated field
// (nationality, passport issue country) contradicts the candidate. Anything
// weaker returns null — callers must create a new profile rather than guess.
// Always scoped to a single workspace; never matches across workspaces.
//
// Wired into workspace.travellers.ts's bulk import (Phase 3) and
// services/travellerAutoCapture.ts (Phase 4) — the explicit "Add Traveller"
// create endpoint does NOT call this; a human who explicitly chose to add a
// new record gets a new record.
import mongoose from "mongoose";
import TravellerProfile from "../models/TravellerProfile.js";

export function normalizeName(v: unknown): string {
  return String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeEmail(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

export interface TravellerMatchCandidate {
  email?: string;
  firstName?: string;
  lastName?: string;
  dob?: string; // "YYYY-MM-DD"
  nationality?: string;
  passportIssueCountry?: string;
}

export interface TravellerMatchResult {
  profile: any;
  tier: 1 | 2;
}

function hasConflict(existing: any, candidate: TravellerMatchCandidate): boolean {
  const existingNat = normalizeName(existing.nationality);
  const candidateNat = normalizeName(candidate.nationality);
  if (existingNat && candidateNat && existingNat !== candidateNat) return true;

  const existingIssue = normalizeName(existing.passportIssueCountry);
  const candidateIssue = normalizeName(candidate.passportIssueCountry);
  if (existingIssue && candidateIssue && existingIssue !== candidateIssue) return true;

  return false;
}

export async function findMatchingTraveller(
  workspaceId: mongoose.Types.ObjectId | string,
  candidate: TravellerMatchCandidate,
): Promise<TravellerMatchResult | null> {
  const email = normalizeEmail(candidate.email);

  if (email) {
    const byEmail = await TravellerProfile.findOne({ workspaceId, email, isActive: true }).exec();
    if (byEmail) return { profile: byEmail, tier: 1 };
  }

  const firstName = normalizeName(candidate.firstName);
  const lastName = normalizeName(candidate.lastName);
  const dob = String(candidate.dob ?? "").trim();
  if (!firstName || !lastName || !dob) return null;

  // Same DOB is usually a small set even at full workspace scale — filter
  // the name tuple in JS rather than requiring a case-insensitive index.
  const sameDob = await TravellerProfile.find({ workspaceId, dob, isActive: true }).exec();
  const tier2 = sameDob.find(
    (p: any) => normalizeName(p.firstName) === firstName && normalizeName(p.lastName) === lastName,
  );
  if (!tier2) return null;

  if (hasConflict(tier2, candidate)) return null;

  return { profile: tier2, tier: 2 };
}

/* ── Applying an update once matched ──────────────────────────────────
 *
 * Shared by bulk import and booking auto-capture so "what does an update
 * mean" has exactly one definition. A blank/absent candidate field NEVER
 * clears existing data — only non-blank fields are written. Values are
 * trimmed before assignment so a value re-assigned to itself (including
 * after trimming stray whitespace) never marks the document dirty; callers
 * that care whether anything actually changed should check
 * doc.isModified() themselves after calling this (Mongoose's own
 * dirty-tracking already accounts for schema-level trim/lowercase setters,
 * so this doesn't need to hand-roll a field-by-field comparison).
 * ──────────────────────────────────────────────────────────────────── */

export interface TravellerFieldCandidate {
  title?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  gender?: string;
  dob?: string;
  nationality?: string;
  passportNo?: string;
  passportExpiry?: string;
  passportIssueCountry?: string;
  passportIssueDate?: string;
  mobile?: string;
  email?: string;
}

const UPDATABLE_TRAVELLER_FIELDS: (keyof TravellerFieldCandidate)[] = [
  "title", "firstName", "middleName", "lastName", "gender", "dob", "nationality",
  "passportNo", "passportExpiry", "passportIssueCountry", "passportIssueDate", "mobile", "email",
];

export function applyTravellerFields(doc: any, candidate: TravellerFieldCandidate): void {
  for (const field of UPDATABLE_TRAVELLER_FIELDS) {
    const raw = candidate[field];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (value) doc[field] = value;
  }
}
