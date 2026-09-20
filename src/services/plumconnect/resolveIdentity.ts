// apps/backend/src/services/plumconnect/resolveIdentity.ts
//
// PlumConnect Slice 1 — the ONE phone → identity resolver, and the ONE
// writer of User.waId.
//
// Dormant this slice: nothing calls it yet (the dispatcher in Slice 2 will).
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §3, §9.
//
// Shape of an answer
//   hard  — an ACTIVE User whose User.waId equals the canonical phone exactly.
//           This is the only outcome that may ever confer a tenant
//           (User.workspaceId) or reach the expense chain. Absent → null.
//   soft  — only consulted when hard misses. Fuzzy hits on the free-text phone
//           fields the integration audit lists (§3a/§3c), each capped at 3.
//           Soft hits ROUTE and PROMPT; they never confer a tenant and never
//           enqueue anything. That is the hard invariant (§9).
//   identityState — the Contact.identityState label the dispatcher will store.
//
// Active predicate: utils/userActiveStatus.ts (activeUserFilter /
// isUserActive) — never re-implemented here. An INACTIVE user with a matching
// waId is a MISS, not a hard hit.
//
// The resolver READS. bindWaId / unbindWaId below are the only two functions
// in the codebase (plus the legacy scripts/set-waid.ts CLI, and the
// contingency scripts/plumconnect-waid-cleanup.ts) that write User.waId —
// resolveIdentity.test.ts grep-asserts that list.

import mongoose from "mongoose";
import User from "../../models/User.js";
import TravellerProfile from "../../models/TravellerProfile.js";
import Consumer from "../../models/Consumer.js";
import CRMContact from "../../models/CRMContact.js";
import { activeUserFilter } from "../../utils/userActiveStatus.js";
import { toCanonical, toIndiaNational, looseMatchRegex } from "../../utils/phone.js";
import type { ContactIdentityState } from "../../models/plumconnect/Contact.js";

/** Per-source cap on soft hits — the fields are unindexed free text. */
const SOFT_LIMIT = 3;

export interface HardIdentity {
  userId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  email: string;
  name: string;
  waId: string;
}

export interface SoftUserHit {
  userId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  email: string;
  name: string;
  phone: string;
}

export interface SoftTravellerHit {
  travellerProfileId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  travelerId: string;
  mobile: string;
}

export interface SoftConsumerHit {
  consumerId: mongoose.Types.ObjectId;
  verifiedPhone: string;
}

export interface SoftCrmContactHit {
  crmContactId: mongoose.Types.ObjectId;
  companyId: mongoose.Types.ObjectId | null;
  phone: string;
}

export interface SoftIdentity {
  users: SoftUserHit[];
  travellerProfiles: SoftTravellerHit[];
  consumers: SoftConsumerHit[];
  crmContacts: SoftCrmContactHit[];
}

export interface IdentityResolution {
  /** The canonical phone the lookups ran on; null when the input was unusable. */
  canonical: string | null;
  hard: HardIdentity | null;
  soft: SoftIdentity;
  identityState: ContactIdentityState;
}

const EMPTY_SOFT: SoftIdentity = { users: [], travellerProfiles: [], consumers: [], crmContacts: [] };

function displayName(u: any): string {
  const full = [u?.firstName, u?.middleName, u?.lastName].filter(Boolean).join(" ").trim();
  return String(u?.name || full || "").trim();
}

/**
 * Label precedence when several soft sources hit: an employee-shaped hit
 * (User.phone / TravellerProfile.mobile) outranks a consumer, which outranks
 * a CRM contact — the more a hit implies about a tenant, the more it matters
 * to the router's consent prompt. Documented here because nothing else fixes
 * the order.
 */
function labelFor(hard: HardIdentity | null, soft: SoftIdentity): ContactIdentityState {
  if (hard) return "verified_employee";
  if (soft.users.length || soft.travellerProfiles.length) return "soft_employee";
  if (soft.consumers.length) return "soft_consumer";
  if (soft.crmContacts.length) return "soft_crm";
  return "unknown";
}

/**
 * Resolve a raw phone (any spelling) to an identity. Reads only.
 * Unusable input (toCanonical → null) is an all-miss, never a throw.
 */
export async function resolveIdentity(rawPhone: unknown): Promise<IdentityResolution> {
  const canonical = toCanonical(rawPhone);
  if (!canonical) {
    return { canonical: null, hard: null, soft: { ...EMPTY_SOFT }, identityState: "unknown" };
  }

  // ── hard: exact waId on an ACTIVE user ──────────────────────────────────
  const hardDoc: any = await User.findOne({ waId: canonical, ...activeUserFilter() })
    .select("_id workspaceId email name firstName middleName lastName waId")
    .lean();

  if (hardDoc) {
    const hard: HardIdentity = {
      userId: hardDoc._id,
      workspaceId: hardDoc.workspaceId,
      email: String(hardDoc.email || ""),
      name: displayName(hardDoc),
      waId: String(hardDoc.waId),
    };
    return { canonical, hard, soft: { ...EMPTY_SOFT }, identityState: "verified_employee" };
  }

  // ── soft: only when hard misses ─────────────────────────────────────────
  const loose = looseMatchRegex(canonical);
  const national = toIndiaNational(canonical);

  const [userDocs, travellerDocs, consumerDocs, crmDocs] = await Promise.all([
    User.find({ phone: loose, ...activeUserFilter() })
      .select("_id workspaceId email name firstName middleName lastName phone")
      .limit(SOFT_LIMIT)
      .lean(),
    TravellerProfile.find({ mobile: loose })
      .select("_id workspaceId travelerId mobile")
      .limit(SOFT_LIMIT)
      .lean(),
    // verifiedPhone is stored 10-digit national (India only); a foreign
    // number can never match it, so skip the query rather than fuzz it.
    national
      ? Consumer.find({ verifiedPhone: national }).select("_id verifiedPhone").limit(SOFT_LIMIT).lean()
      : Promise.resolve([] as any[]),
    CRMContact.find({ phone: loose }).select("_id companyId phone").limit(SOFT_LIMIT).lean(),
  ]);

  const soft: SoftIdentity = {
    users: (userDocs as any[]).map((u) => ({
      userId: u._id,
      workspaceId: u.workspaceId,
      email: String(u.email || ""),
      name: displayName(u),
      phone: String(u.phone || ""),
    })),
    travellerProfiles: (travellerDocs as any[]).map((t) => ({
      travellerProfileId: t._id,
      workspaceId: t.workspaceId,
      travelerId: String(t.travelerId || ""),
      mobile: String(t.mobile || ""),
    })),
    consumers: (consumerDocs as any[]).map((c) => ({
      consumerId: c._id,
      verifiedPhone: String(c.verifiedPhone || ""),
    })),
    crmContacts: (crmDocs as any[]).map((c) => ({
      crmContactId: c._id,
      companyId: c.companyId ?? null,
      phone: String(c.phone || ""),
    })),
  };

  return { canonical, hard: null, soft, identityState: labelFor(null, soft) };
}

/* ───────────────────────── the single writer ─────────────────────────── */

export type BindWaIdResult =
  | { ok: true; userId: string; waId: string }
  | { ok: false; reason: "invalid_phone" | "user_inactive_or_missing" | "waid_taken" };

/**
 * Stamp User.waId on an ACTIVE user. Refuses an INACTIVE or missing user
 * (matchedCount 0 under activeUserFilter), a non-canonical phone, and — once
 * the unique index exists — a phone another user already holds (E11000).
 * The expense chain resolves by this field alone, so this is the one place
 * that grants expense capability over WhatsApp.
 */
export async function bindWaId(userId: mongoose.Types.ObjectId | string, canonical: string): Promise<BindWaIdResult> {
  if (toCanonical(canonical) !== canonical) return { ok: false, reason: "invalid_phone" };
  if (!mongoose.isValidObjectId(userId)) return { ok: false, reason: "user_inactive_or_missing" };

  try {
    const res = await User.updateOne(
      { _id: new mongoose.Types.ObjectId(String(userId)), ...activeUserFilter() },
      { $set: { waId: canonical } },
    );
    if (res.matchedCount === 0) return { ok: false, reason: "user_inactive_or_missing" };
    return { ok: true, userId: String(userId), waId: canonical };
  } catch (err: any) {
    if (err?.code === 11000) return { ok: false, reason: "waid_taken" };
    throw err;
  }
}

/**
 * Remove User.waId. ALWAYS $unset, never `null` and never "": a sparse unique
 * index skips only documents where the field is missing, so a stored null or
 * "" would collide with the next one (plan §9). Allowed on any user, active
 * or not — off-boarding must be able to revoke.
 */
export async function unbindWaId(userId: mongoose.Types.ObjectId | string): Promise<{ ok: boolean; matched: number }> {
  if (!mongoose.isValidObjectId(userId)) return { ok: false, matched: 0 };
  const res = await User.updateOne(
    { _id: new mongoose.Types.ObjectId(String(userId)) },
    { $unset: { waId: "" } },
  );
  return { ok: res.matchedCount > 0, matched: res.matchedCount };
}
