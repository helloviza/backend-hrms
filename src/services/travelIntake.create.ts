/**
 * services/travelIntake.create.ts
 * ---------------------------------------------------------------------------
 * Single source of truth for turning a mapped travel-intake payload (from any
 * channel) into HOUSE-tenant ManualBooking row(s). Extracted from what was
 * previously inline in routes/intake.travel.ts:125-242 so the dormant HMAC
 * endpoint and the new public /api/public/travel-request endpoint share one
 * creation path instead of two copies that could drift.
 *
 * Callers own their own field validation (required-ness differs per channel —
 * e.g. the public endpoint requires phone-or-email, the HMAC endpoint does
 * not) and their own `intakeRef` namespacing ("gform:<id>" vs
 * "public:<uuid>") — this module trusts `intakeRef` is already the full,
 * namespaced dedup key.
 */
import ManualBooking, { type ManualBookingType } from "../models/ManualBooking.js";

// PlumTrips House Customer._id — created idempotently by
// scripts/seed-intake-system-identities.ts (run 2026-07-08). NOT the
// 69679a7628330a58d29f2254 literal used elsewhere in this codebase for
// HOUSE-workspace checks — that literal is a CustomerWorkspace._id whose
// customerId points at an unrelated external client. See
// infra/audit/manual-bookings-intake-build.md for the full verification.
export const HOUSE_CUSTOMER_ID = "6a4e0d2ea90c293c9e129f48";

// "System Intake" User — same seed script. Used for bookedBy (Mongoose-required
// ObjectId ref User) and createdBy (String) on every intake-created booking.
export const SYSTEM_INTAKE_USER_ID = "6a4e0d2ec678b97e06f9ac3d";
export const SYSTEM_INTAKE_EMAIL = "system-intake@plumtrips.com";

// Form service label -> ManualBooking.type. Any label with no entry here is
// filtered out by recognizedServicesOf(); callers that want an "OTHER"
// catch-all for unmapped-but-present labels handle that themselves (see
// intake.travel.ts's fan-out branch).
//
// The canonical labels (first block) MUST match
// apps/frontend/src/constants/serviceTaxonomy.ts's SERVICE_TAXONOMY exactly —
// there's no shared package between the two apps, so this map is hand-kept
// in lockstep with that file. If a type/label is added/renamed there, mirror
// it here too.
const CANONICAL_SERVICE_TYPE_MAP: Record<string, ManualBookingType> = {
  "Flight": "FLIGHT",
  "Flight Reschedule": "FLIGHT_RESCHEDULE",
  "Dummy Flight": "DUMMY_FLIGHT",
  "Hotel": "HOTEL",
  "Dummy Hotel": "DUMMY_HOTEL",
  "Train": "TRAIN",
  "Transfer": "TRANSFER",
  "Cab": "CAB",
  "Visa": "VISA",
  "Holidays": "HOLIDAYS",
  "Events": "EVENTS",
  "Group Booking": "GROUP_BOOKING",
  "Forex": "FOREX",
  "eSIM": "ESIM",
  "Insurance": "INSURANCE",
  "Trophy": "TROPHY",
  "Gift": "GIFT",
  "Stationery": "STATIONERY",
  "Other": "OTHER",
};

// Legacy aliases — pre-taxonomy public-form labels (superseded 2026-07-11)
// plus the dormant Google-Form/HMAC channel's vocabulary (intake.travel.ts).
// Kept so already-submitted/in-flight/queued payloads using these exact
// strings still resolve; never surfaced as a UI option anymore.
const LEGACY_SERVICE_ALIASES: Record<string, ManualBookingType> = {
  "Tourist Visa": "VISA",
  "Business Visa": "VISA",
  "Study Visa": "VISA",
  "Flight Booking": "FLIGHT",
  "Hotel Booking": "HOTEL",
  "Airport Transfer": "TRANSFER",
  "Cab Services": "CAB",
  "Holiday Package": "HOLIDAYS",
  // Pre-taxonomy public label — mapped to OTHER historically, NOT the new
  // INSURANCE type. Deliberately left as-is so this alias's behavior for
  // already-queued/in-flight payloads doesn't silently change; new
  // submissions use the canonical "Insurance" label -> INSURANCE above.
  "Travel Insurance": "OTHER",
};

export const SERVICE_TYPE_MAP: Record<string, ManualBookingType> = {
  ...LEGACY_SERVICE_ALIASES,
  ...CANONICAL_SERVICE_TYPE_MAP,
};

export function parseIntakeDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (dmy) {
    const d = new Date(`${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}T00:00:00.000Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Filters a raw service-label list down to the ones with a known ManualBooking.type mapping. */
export function recognizedServicesOf(services: unknown): string[] {
  const raw: string[] = Array.isArray(services)
    ? services.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
    : [];
  return raw.filter((s) => SERVICE_TYPE_MAP[s]);
}

export interface TravelIntakeInput {
  /** Already fully namespaced dedup key, e.g. "gform:<responseId>" or "public:<uuid>". */
  intakeRef: string;
  fullName: string;
  mobile?: string;
  email?: string;
  originCity?: string;
  destination?: string;
  travelDate: unknown;
  returnDate?: unknown;
  purpose?: string;
  travelerCount?: unknown;
  notes?: string;
  /** Raw service labels as submitted — this module re-derives the recognized subset. */
  services: unknown;
  submittedAt?: string;
}

export interface TravelIntakeResult {
  ok: true;
  deduped: boolean;
  count: number;
  bookingIds: string[];
}

function buildCommonFields(input: TravelIntakeInput) {
  const fullName = String(input.fullName ?? "").trim();
  const mobile = String(input.mobile ?? "").trim();
  const email = String(input.email ?? "").trim();
  const originCity = String(input.originCity ?? "").trim();
  const destination = String(input.destination ?? "").trim();
  const travelDate = parseIntakeDate(input.travelDate)!;
  const returnDate = parseIntakeDate(input.returnDate) || undefined;
  const purpose = String(input.purpose ?? "").trim();
  const travelerCount = Number(input.travelerCount) || undefined;
  const freeNotes = String(input.notes ?? "").trim();

  const notesParts: string[] = [];
  if (purpose) notesParts.push(`Purpose: ${purpose}`);
  if (travelerCount) notesParts.push(`Travelers: ${travelerCount}`);
  if (freeNotes) notesParts.push(freeNotes);

  return {
    workspaceId: HOUSE_CUSTOMER_ID,
    bookedBy: SYSTEM_INTAKE_USER_ID,
    createdBy: SYSTEM_INTAKE_USER_ID,
    createdByEmail: SYSTEM_INTAKE_EMAIL,
    source: "MANUAL" as const, // no dedicated "INTAKE" value in the source enum — channel identity lives in metadata below
    travelDate,
    returnDate,
    sector: originCity && destination ? `${originCity}-${destination}` : destination || undefined,
    itinerary: {
      origin: originCity || undefined,
      destination: destination || undefined,
    },
    passengers: [
      {
        name: fullName,
        email: email || undefined,
        phone: mobile || undefined,
        type: "ADULT" as const,
      },
    ],
    pricing: {
      actualPrice: 0,
      quotedPrice: 0,
      gstMode: "ON_MARKUP" as const,
      gstPercent: 18,
      currency: "INR",
    },
    notes: notesParts.length ? notesParts.join(" | ") : undefined,
    metadata: {
      intakeRef: input.intakeRef,
      channel: "TRAVEL_INTAKE_FORM",
      submittedAt: input.submittedAt || undefined,
    },
  };
}

/**
 * Creates HOUSE-tenant ManualBooking(s) for a mapped intake payload, deduping
 * on `input.intakeRef` (exact match) and fanning out per INTAKE_FANOUT_MODE.
 * Callers must validate required fields (fullName, travelDate, >=1 recognized
 * service, plus any channel-specific requirements) BEFORE calling this.
 */
export async function createIntakeBookings(input: TravelIntakeInput): Promise<TravelIntakeResult> {
  const intakeRef = String(input.intakeRef ?? "").trim();

  if (intakeRef) {
    const existing = await ManualBooking.find({ "metadata.intakeRef": intakeRef })
      .select("_id")
      .lean();
    if (existing.length) {
      return { ok: true, deduped: true, count: existing.length, bookingIds: existing.map((b: any) => String(b._id)) };
    }
  }

  const recognizedServices = recognizedServicesOf(input.services);
  const common = buildCommonFields(input);
  const fanoutMode = process.env.INTAKE_FANOUT_MODE === "single" ? "single" : "fanout";

  const created: any[] = [];

  if (fanoutMode === "single") {
    const doc = await ManualBooking.create({
      ...common,
      type: "OTHER",
      metadata: { ...common.metadata, services: recognizedServices },
    });
    created.push(doc);
  } else {
    for (const service of recognizedServices) {
      const doc = await ManualBooking.create({
        ...common,
        type: SERVICE_TYPE_MAP[service],
        metadata: { ...common.metadata, services: recognizedServices },
      });
      created.push(doc);
    }
  }

  return { ok: true, deduped: false, count: created.length, bookingIds: created.map((d) => String(d._id)) };
}
