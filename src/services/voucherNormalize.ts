// apps/backend/src/services/voucherNormalize.ts
import type { PlumtripsVoucher, VoucherType, LayoutType } from "../types/index.js";

/**
 * Goals:
 * - Always return a PlumtripsVoucher that matches backend schema types.
 * - Never throw for missing business fields (that creates 422 spikes).
 * - Instead, add compact "needs repair" notes into policies.important_notes.
 * - Keep normalization deterministic and defensive.
 */

function toStrOrNull(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;

  const lower = s.toLowerCase();
  if (
    lower === "null" ||
    lower === "n/a" ||
    lower === "na" ||
    lower === "-" ||
    lower === "none"
  )
    return null;

  return s;
}

function toIntOrZero(v: any): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function toStringArray(v: any, max = 80): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of v) {
    const s = toStrOrNull(item);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function dedupeStrings(arr: string[], max = 80): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of arr) {
    const t = (s || "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function computeLayoutType(docType: VoucherType, v: any): LayoutType {
  const paxCount =
    docType === "flight"
      ? Array.isArray(v?.passengers) && v.passengers.length > 0
        ? v.passengers.length
        : 1
      : Array.isArray(v?.guest_details?.all_guest_names) &&
        v.guest_details.all_guest_names.length > 0
      ? v.guest_details.all_guest_names.length
      : toStrOrNull(v?.guest_details?.primary_guest)
      ? 1
      : 1;

  if (paxCount <= 1) return "SINGLE";
  if (paxCount === 2) return "DUAL";
  return "GROUP";
}

function normalizePolicyNotes(v: any): string[] {
  const bucket: any[] = [];

  const grab = (x: any) => {
    if (!x) return;
    if (Array.isArray(x)) bucket.push(...x);
    else bucket.push(x);
  };

  // preferred
  grab(v?.policies?.important_notes);

  // legacy / portal variants
  grab(v?.policies?.cancellation_policy);
  grab(v?.policies?.checkin_instructions);
  grab(v?.policies?.terms);

  grab(v?.important_information);
  grab(v?.cancellation_policy);
  grab(v?.check_in_instructions);
  grab(v?.instructions);

  return toStringArray(bucket, 80);
}

function inferIsNonRefundable(v: any, notes: string[]): boolean {
  // Priority: explicit boolean
  if (typeof v?.policies?.is_non_refundable === "boolean") return v.policies.is_non_refundable;

  // Some extractors send string flags
  const s = toStrOrNull(v?.policies?.is_non_refundable);
  if (s) {
    const x = s.toLowerCase();
    if (["true", "yes", "y", "nonrefundable", "non-refundable"].includes(x)) return true;
    if (["false", "no", "n", "refundable"].includes(x)) return false;
  }

  // Fallback: infer from notes
  const t = notes.join(" ").toLowerCase();
  return (
    t.includes("non refundable") ||
    t.includes("non-refundable") ||
    t.includes("nonrefundable") ||
    t.includes("no refund") ||
    t.includes("cannot be refunded")
  );
}

function normalizeFlightSegment(seg: any) {
  const origin = seg?.origin || {};
  const destination = seg?.destination || {};
  const anc = seg?.ancillaries || {};

  // Ensure ancillaries always exists and includes required fields (meal included)
  const ancillaries = {
    checkin_bag: toStrOrNull(anc?.checkin_bag),
    cabin_bag: toStrOrNull(anc?.cabin_bag),
    seat: toStrOrNull(anc?.seat),
    meal: toStrOrNull(anc?.meal),
    barcode_string: toStrOrNull(anc?.barcode_string),
  };

  return {
    airline: toStrOrNull(seg?.airline),
    flight_no: toStrOrNull(seg?.flight_no),
    class: toStrOrNull(seg?.class),
    duration: toStrOrNull(seg?.duration),
    layover_duration: toStrOrNull(seg?.layover_duration),

    origin: {
      code: toStrOrNull(origin?.code),
      city: toStrOrNull(origin?.city),
      time: toStrOrNull(origin?.time),
      date: toStrOrNull(origin?.date),
      terminal: toStrOrNull(origin?.terminal),
    },

    destination: {
      code: toStrOrNull(destination?.code),
      city: toStrOrNull(destination?.city),
      time: toStrOrNull(destination?.time),
      date: toStrOrNull(destination?.date),
      terminal: toStrOrNull(destination?.terminal),
    },

    ancillaries, // always present for UI stability
  };
}

function normalizePassenger(p: any) {
  return {
    name: toStrOrNull(p?.name),
    type: toStrOrNull(p?.type),
    ticket_no: toStrOrNull(p?.ticket_no),

    phone: toStrOrNull(p?.phone),
    email: toStrOrNull(p?.email),

    baggage_check_in: toStrOrNull(p?.baggage_check_in),
    baggage_cabin: toStrOrNull(p?.baggage_cabin),

    seat: toStrOrNull(p?.seat),
    meal: toStrOrNull(p?.meal),
    barcode_string: toStrOrNull(p?.barcode_string),
    special_service: toStrOrNull(p?.special_service),
  };
}

/**
 * Normalizes ANY model/extractor output into a schema-valid backend PlumtripsVoucher.
 * It MUST NOT throw for missing business fields (that is handled by repair/validation layer).
 */
export function normalizePlumtripsVoucher(input: any, docType: VoucherType): PlumtripsVoucher {
  const v = (input || {}) as any;

  const layout: LayoutType =
    v?.layout_type === "SINGLE" || v?.layout_type === "DUAL" || v?.layout_type === "GROUP"
      ? v.layout_type
      : computeLayoutType(docType, v);

  const important_notes_raw = normalizePolicyNotes(v);

  // Add internal “repair needed” notes (compact, UI-safe)
  const repairNotes: string[] = [];

  const booking_info = {
    booking_id: toStrOrNull(v?.booking_info?.booking_id),
    booking_date: toStrOrNull(v?.booking_info?.booking_date),
    voucher_no: toStrOrNull(v?.booking_info?.voucher_no),
    supplier_conf_no: toStrOrNull(v?.booking_info?.supplier_conf_no),

    pnr: toStrOrNull(v?.booking_info?.pnr),
    fare_type: toStrOrNull(v?.booking_info?.fare_type),
    ocr_data_line: toStrOrNull(v?.booking_info?.ocr_data_line),

    // keep nullable here; extractor/service will enforce branding fallback
    custom_logo: toStrOrNull(v?.booking_info?.custom_logo),
  };

  // Backend schema: boolean required (NOT nullable)
  const is_non_refundable = inferIsNonRefundable(v, important_notes_raw);

  const policies = {
    cancellation_deadline: toStrOrNull(v?.policies?.cancellation_deadline),
    is_non_refundable,
    important_notes: dedupeStrings([...important_notes_raw]),
  };

  const base: PlumtripsVoucher = {
    type: docType,
    layout_type: layout,
    booking_info,
    policies,
  };

  // -------------------- HOTEL --------------------
  if (docType === "hotel") {
    base.hotel_details = {
      name: toStrOrNull(v?.hotel_details?.name),
      address: toStrOrNull(v?.hotel_details?.address),
      city: toStrOrNull(v?.hotel_details?.city),
      country: toStrOrNull(v?.hotel_details?.country),
      contact: toStrOrNull(v?.hotel_details?.contact),
    };

    base.stay_details = {
      check_in_date: toStrOrNull(v?.stay_details?.check_in_date),
      check_in_time: toStrOrNull(v?.stay_details?.check_in_time),
      check_out_date: toStrOrNull(v?.stay_details?.check_out_date),
      check_out_time: toStrOrNull(v?.stay_details?.check_out_time),
      total_nights: toStrOrNull(v?.stay_details?.total_nights),
    };

    base.guest_details = {
      primary_guest: toStrOrNull(v?.guest_details?.primary_guest),
      total_pax: toStrOrNull(v?.guest_details?.total_pax),
      adults: toIntOrZero(v?.guest_details?.adults),
      children: toIntOrZero(v?.guest_details?.children),
      all_guest_names: toStringArray(v?.guest_details?.all_guest_names, 30),
    };

    base.room_details = {
      room_type: toStrOrNull(v?.room_details?.room_type),
      no_of_rooms: toStrOrNull(v?.room_details?.no_of_rooms),
      inclusions: toStringArray(v?.room_details?.inclusions, 60),
      special_requests: toStrOrNull(v?.room_details?.special_requests),
    };

    // Repair hints (do NOT throw)
    if (!toStrOrNull(base.hotel_details.name)) repairNotes.push("[repair] hotel_details.name missing");
    if (!toStrOrNull(base.stay_details.check_in_date)) repairNotes.push("[repair] stay_details.check_in_date missing");
    if (!toStrOrNull(base.stay_details.check_out_date)) repairNotes.push("[repair] stay_details.check_out_date missing");

    if (repairNotes.length) {
      base.policies.important_notes = dedupeStrings([...base.policies.important_notes, ...repairNotes], 80);
    }

    return base;
  }

  // -------------------- FLIGHT --------------------
  const flight_details = {
    segments: Array.isArray(v?.flight_details?.segments)
      ? v.flight_details.segments.map(normalizeFlightSegment)
      : [],
  };

  const passengers = Array.isArray(v?.passengers) ? v.passengers.map(normalizePassenger) : [];

  base.flight_details = flight_details;
  base.passengers = passengers;

  // Repair hints (do NOT throw)
  if (!Array.isArray(flight_details.segments) || flight_details.segments.length === 0) {
    repairNotes.push("[repair] flight_details.segments missing/empty");
  }

  // PNR is not required by TypeScript schema, but often essential
  if (!toStrOrNull(base.booking_info.pnr)) {
    repairNotes.push("[repair] booking_info.pnr missing");
  }

  if (repairNotes.length) {
    base.policies.important_notes = dedupeStrings([...base.policies.important_notes, ...repairNotes], 80);
  }

  return base;
}
