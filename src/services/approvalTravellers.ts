// apps/backend/src/services/approvalTravellers.ts
//
// Travellers on an approval request (Flow 2 / Flow 3), cartItems[].meta.travellers.
//
//   kind "self"   — the request owner. ALWAYS rebuilt here from the owner's own
//                   profile (the TravellerProfile they have claimed, the record
//                   /profile/customer?tab=my-profile edits). Whatever the client
//                   sent for it is discarded; only the fact that self is included
//                   is taken from the request.
//   kind "manual" — typed on the form for this request only. Stored on the
//                   request and nowhere else: nothing here writes to
//                   TravellerProfile, CustomerMember, User or any other
//                   collection, and the company travellers list is never read.
//
// The only TravellerProfile read is resolveMyTravellerProfiles — claimedBy ===
// the owner — the same strict resolve the My Profile tab uses.

import crypto from "crypto";
import TravellerProfile from "../models/TravellerProfile.js";
import { resolveMyTravellerProfiles } from "./travellerIdentity.service.js";
import { maskTailId } from "../utils/piiMask.js";

export type TravellerKind = "self" | "manual";

export type RequestTraveller = {
  travellerId: string;
  kind: TravellerKind;
  firstName: string;
  middleName?: string;
  lastName: string;
  dob?: string;
  gender?: string;
  nationality?: string;
  passportNumber?: string;
  passportExpiry?: string;
  phone?: string;
  email?: string;
};

export class TravellerError extends Error {
  status = 400;
  constructor(public code: string, message: string, public missing?: string[]) {
    super(message);
  }
}

const SELF_ALWAYS = ["firstName", "lastName", "dob"] as const;
const INTERNATIONAL = ["passportNumber", "passportExpiry", "nationality"] as const;

function str(v: any, max = 120): string {
  return String(v ?? "").trim().slice(0, max);
}

function isMasked(v: string) {
  return v.includes("*");
}

export type SelfTravellerResult = {
  /** ok = exactly one claimed profile; none / duplicate_claims = nothing usable. */
  status: "ok" | "none" | "duplicate_claims";
  traveller: RequestTraveller | null;
  /** Missing for any trip (name + DOB). */
  missing: string[];
  /** Additionally missing for an international trip. */
  missingInternational: string[];
};

export async function loadSelfTraveller(workspaceId: any, userId: string): Promise<SelfTravellerResult> {
  const empty = { traveller: null, missing: [...SELF_ALWAYS], missingInternational: [...INTERNATIONAL] };
  if (!workspaceId || !userId) return { status: "none", ...empty };

  const resolved = await resolveMyTravellerProfiles(workspaceId, userId);
  // ResolveMeResult does not narrow here (strictNullChecks is off).
  if (!resolved.resolved) return { status: (resolved as any).reason, ...empty };

  const p: any = await TravellerProfile.findOne({ _id: (resolved as any).traveller.id, workspaceId })
    .select("firstName middleName lastName dob gender nationality passportNo passportExpiry mobile mobileCountryCode email")
    .lean();
  if (!p) return { status: "none", ...empty };

  const traveller: RequestTraveller = {
    travellerId: `self-${String(p._id)}`,
    kind: "self",
    firstName: str(p.firstName),
    middleName: str(p.middleName) || undefined,
    lastName: str(p.lastName),
    dob: str(p.dob) || undefined,
    gender: str(p.gender) || undefined,
    nationality: str(p.nationality) || undefined,
    passportNumber: str(p.passportNo) || undefined,
    passportExpiry: str(p.passportExpiry) || undefined,
    phone: [str(p.mobileCountryCode), str(p.mobile)].filter(Boolean).join(" ") || undefined,
    email: str(p.email) || undefined,
  };
  return {
    status: "ok",
    traveller,
    missing: SELF_ALWAYS.filter((k) => !(traveller as any)[k]),
    missingInternational: INTERNATIONAL.filter((k) => !(traveller as any)[k]),
  };
}

/** Every passport stored on these cart items, for restoring masked round-trips. */
function storedTravellers(existingCartItems: any[]): any[] {
  const out: any[] = [];
  for (const it of Array.isArray(existingCartItems) ? existingCartItems : []) {
    const trs = it?.meta?.travellers;
    if (Array.isArray(trs)) out.push(...trs.filter((t: any) => t && typeof t === "object"));
  }
  return out;
}

/**
 * Customers get passports back masked, so an edit sends "****4567" for an
 * unchanged passport. Put the stored number back: same travellerId first, then
 * (requests saved before travellerId existed) same name with the same mask.
 */
function restorePassport(incoming: string, t: any, stored: any[]): string {
  if (!isMasked(incoming)) return incoming;
  const sameMask = (s: any) => {
    const v = str(s?.passportNumber);
    return v && !isMasked(v) && maskTailId(v) === incoming;
  };
  const byId = t.travellerId ? stored.find((s) => str(s.travellerId) === t.travellerId && sameMask(s)) : null;
  const byName =
    byId ||
    stored.find(
      (s) =>
        str(s.firstName).toLowerCase() === t.firstName.toLowerCase() &&
        str(s.lastName).toLowerCase() === t.lastName.toLowerCase() &&
        sameMask(s),
    );
  if (byName) return str(byName.passportNumber);
  throw new TravellerError(
    "PASSPORT_REENTER",
    `Traveller ${t.firstName} ${t.lastName}: please re-enter the full passport number.`,
  );
}

/** Same person (name + DOB + passport) on several items of one request → one id. */
function personKey(raw: any) {
  return [raw?.firstName, raw?.lastName, raw?.dob, raw?.passportNumber ?? raw?.passportNo].map((v) => str(v).toLowerCase()).join("|");
}

function manualTraveller(raw: any, stored: any[], ids: Map<string, string> = new Map()): RequestTraveller {
  const idIn = str(raw?.travellerId, 64);
  const key = personKey(raw);
  const id = /^m-[a-f0-9]{16}$/.test(idIn) ? idIn : ids.get(key) || `m-${crypto.randomBytes(8).toString("hex")}`;
  if (!ids.has(key)) ids.set(key, id);
  const t: RequestTraveller = {
    travellerId: id,
    kind: "manual",
    firstName: str(raw?.firstName),
    middleName: str(raw?.middleName) || undefined,
    lastName: str(raw?.lastName),
    dob: str(raw?.dob, 10) || undefined,
    gender: str(raw?.gender, 20) || undefined,
    nationality: str(raw?.nationality, 60) || undefined,
    passportNumber: str(raw?.passportNumber ?? raw?.passportNo, 20).toUpperCase() || undefined,
    passportExpiry: str(raw?.passportExpiry, 10) || undefined,
    phone: str(raw?.phone ?? raw?.mobile, 30) || undefined,
    email: str(raw?.email, 120).toLowerCase() || undefined,
  };
  if (t.passportNumber) t.passportNumber = restorePassport(t.passportNumber, t, stored);
  return t;
}

/**
 * Rebuilds meta.travellers on every cart item: self (from the owner's profile)
 * when the client marked it included, then the manual travellers. Which
 * fields each service needs, and whether a traveller is needed at all, is
 * checked afterwards per item (approvalCartItems.checkCartItems), so a forex,
 * eSIM, holiday or MICE item isn't held to flight rules.
 */
export async function prepareCartTravellers(opts: {
  cartItems: any[];
  workspaceId: any;
  ownerUserId: string;
  existingCartItems?: any[];
}): Promise<any[]> {
  const stored = storedTravellers(opts.existingCartItems || []);
  let self: SelfTravellerResult | null = null;
  const ids = new Map<string, string>();

  const out: any[] = [];
  for (const item of opts.cartItems) {
    const meta = item?.meta && typeof item.meta === "object" ? item.meta : {};
    const incoming: any[] = Array.isArray(meta.travellers) ? meta.travellers.filter((t: any) => t && typeof t === "object") : [];
    const includeSelf = incoming.some((t) => t.kind === "self");

    const travellers: RequestTraveller[] = [];
    if (includeSelf) {
      self = self || (await loadSelfTraveller(opts.workspaceId, opts.ownerUserId));
      if (self.status === "duplicate_claims") {
        throw new TravellerError(
          "SELF_PROFILE_DUPLICATE",
          "More than one traveller profile is linked to your login. Fix this in My Profile, or untick yourself.",
        );
      }
      // No profile yet: an empty self, which the item rules report as
      // "Complete your profile" for the services that need one.
      travellers.push(self.traveller ? { ...self.traveller } : { travellerId: "self", kind: "self", firstName: "", lastName: "" });
    }

    for (const raw of incoming.filter((t) => t.kind !== "self")) travellers.push(manualTraveller(raw, stored, ids));

    out.push({ ...item, meta: { ...meta, travellers } });
  }
  return out;
}
