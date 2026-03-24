// apps/backend/src/services/voucherExtractorGemini.ts
import { GoogleGenAI, Type } from "@google/genai";
import type {
  PlumtripsVoucher,
  VoucherType,
  LayoutType,
  FlightSegment,
  Passenger,
  Ancillaries,
  HotelDetails,
  GuestDetails,
  RoomDetails,
  StayDetails,
  FlightDetails,
} from "../types/index.js";

/**
 * Enterprise-grade extraction pipeline:
 * PDF/Image -> RAW (Gemini, schema constrained) -> Normalize -> Validate -> Repair pass (optional) -> Normalize -> Validate
 *
 * Design principles:
 * - Gemini should NOT be asked to output final strict PlumtripsVoucher directly.
 * - We ask Gemini for a permissive RAW contract and enforce strict typing in code.
 * - We never "invent" values; we prefer null + repair over guessing.
 */

let _ai: GoogleGenAI | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} is missing. Set it in apps/backend/.env and restart.`);
  }
  return v.trim();
}

function getAI(): GoogleGenAI {
  const key = requireEnv("GEMINI_API_KEY");
  if (!_ai) _ai = new GoogleGenAI({ apiKey: key });
  return _ai;
}

const DEFAULT_MODEL = "gemini-2.5-flash";

/* ───────────────────────── helpers ───────────────────────── */

function safeLogo(customLogoUrl?: string | null) {
  return (
    (customLogoUrl && customLogoUrl.trim()) ||
    "https://plumtrips.com/assets/brand/plumtrips-logo.png"
  );
}

function isNonEmptyString(v: any): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function toNullString(v: any): string | null {
  if (!isNonEmptyString(v)) return null;
  const s = v.trim();
  const lower = s.toLowerCase();
  if (!s) return null;
  if (lower === "null" || lower === "n/a" || lower === "na" || lower === "-" || lower === "none")
    return null;
  return s;
}

function toNumber(v: any, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function toStringArray(v: any, max = 80): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    const s = toNullString(x);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function inferNonRefundable(notes: string[]): boolean {
  const text = notes.join(" ").toLowerCase();
  return (
    text.includes("non refundable") ||
    text.includes("non-refundable") ||
    text.includes("nonrefundable") ||
    text.includes("no refund") ||
    text.includes("non refund") ||
    text.includes("cannot be refunded")
  );
}

function computeLayout(type: VoucherType, raw: RawCandidate, normalized?: PlumtripsVoucher): LayoutType {
  // Prefer normalized passenger counts if available
  const paxCountFlight =
    Array.isArray(normalized?.passengers) && normalized!.passengers!.length
      ? normalized!.passengers!.length
      : Array.isArray(raw.flight?.passengers) && raw.flight!.passengers!.length
      ? raw.flight!.passengers!.length
      : 0;

  const paxCountHotel =
    Array.isArray(raw.hotel?.all_guest_names) && raw.hotel!.all_guest_names!.length
      ? raw.hotel!.all_guest_names!.length
      : toNullString(raw.hotel?.primary_guest)
      ? 1
      : 0;

  const pax = type === "flight" ? paxCountFlight : paxCountHotel;
  if (pax <= 1) return "SINGLE";
  if (pax === 2) return "DUAL";
  return "GROUP";
}

function defaultAncillaries(): Ancillaries {
  return { cabin_bag: null, checkin_bag: null, seat: null, meal: null, barcode_string: null };
}

/**
 * Score-based barcode pick.
 * Prefer:
 * - kind=BCBP
 * - higher confidence
 * - longer uninterrupted value
 */
function pickBestBarcode(candidates: any): string | null {
  const arr = Array.isArray(candidates) ? candidates : [];
  const cleaned = arr
    .map((c: any) => ({
      kind: toNullString(c?.kind) || "UNKNOWN",
      value: toNullString(c?.value),
      confidence: typeof c?.confidence === "number" ? c.confidence : null,
    }))
    .filter((c: any) => !!c.value);

  if (!cleaned.length) return null;

  const score = (c: any) => {
    const len = c.value.length;
    const conf = typeof c.confidence === "number" ? c.confidence : 0.5;
    const kindBoost = c.kind === "BCBP" ? 2.0 : c.kind === "QR" ? 1.2 : 1.0;
    // Penalize very short strings
    const shortPenalty = len < 20 ? 0.2 : 1.0;
    return kindBoost * shortPenalty * (0.6 * len + 40 * conf);
  };

  cleaned.sort((a: any, b: any) => score(b) - score(a));
  return cleaned[0].value || null;
}

/* ───────────────────────── RAW contract (Gemini output) ───────────────────────── */

type RawCandidate = {
  detected_type: "hotel" | "flight" | "unknown";

  booking_info?: {
    booking_id?: string | null;
    booking_date?: string | null;
    voucher_no?: string | null;
    supplier_conf_no?: string | null;
    pnr?: string | null;
    fare_type?: string | null;
    ocr_data_line?: string | null;
  };

  policies?: {
    cancellation_deadline?: string | null;
    is_non_refundable?: boolean | null;
    notes?: string[];
  };

  flight?: {
    segments?: Array<{
      airline?: string | null;
      flight_no?: string | null;
      class?: string | null;
      duration?: string | null;
      layover_duration?: string | null;

      origin?: {
        city?: string | null;
        code?: string | null;
        time?: string | null;
        date?: string | null;
        terminal?: string | null;
      };

      destination?: {
        city?: string | null;
        code?: string | null;
        time?: string | null;
        date?: string | null;
        terminal?: string | null;
      };

      ancillaries?: {
        cabin_bag?: string | null;
        checkin_bag?: string | null;
        seat?: string | null;
        meal?: string | null;
        barcode_string?: string | null;
      };
    }>;

    passengers?: Array<{
      name?: string | null;
      type?: string | null;
      ticket_no?: string | null;
      phone?: string | null;
      email?: string | null;
      baggage_check_in?: string | null;
      baggage_cabin?: string | null;
      seat?: string | null;
      meal?: string | null;
      barcode_string?: string | null;
      special_service?: string | null;
    }>;
  };

  hotel?: {
    name?: string | null;
    address?: string | null;
    city?: string | null;
    country?: string | null;
    contact?: string | null;

    primary_guest?: string | null;
    total_pax?: string | null;
    adults?: number | string | null;
    children?: number | string | null;
    all_guest_names?: string[];

    room_type?: string | null;
    no_of_rooms?: string | null;
    inclusions?: string[];
    special_requests?: string | null;

    stay?: {
      check_in_date?: string | null;
      check_in_time?: string | null;
      check_out_date?: string | null;
      check_out_time?: string | null;
      total_nights?: string | null;
    };
  };

  barcode_candidates?: Array<{
    kind?: "BCBP" | "QR" | "BARCODE" | "UNKNOWN" | string | null;
    value?: string | null;
    source?: "text" | "ocr_crop" | string | null;
    page?: number | null;
    confidence?: number | null;
  }>;
};

/* ───────────────────────── Gemini response schema for RAW contract ───────────────────────── */

const nstr = { type: Type.STRING, nullable: true } as const;
const nbool = { type: Type.BOOLEAN, nullable: true } as const;
const nnum = { type: Type.NUMBER, nullable: true } as const;

const rawSchema = {
  type: Type.OBJECT,
  properties: {
    detected_type: { type: Type.STRING, enum: ["hotel", "flight", "unknown"] },

    booking_info: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        booking_id: nstr,
        booking_date: nstr,
        voucher_no: nstr,
        supplier_conf_no: nstr,
        pnr: nstr,
        fare_type: nstr,
        ocr_data_line: nstr,
      },
    },

    policies: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        cancellation_deadline: nstr,
        is_non_refundable: nbool,
        notes: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
    },

    flight: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        segments: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              airline: nstr,
              flight_no: nstr,
              class: nstr,
              duration: nstr,
              layover_duration: nstr,
              origin: {
                type: Type.OBJECT,
                nullable: true,
                properties: {
                  city: nstr,
                  code: nstr,
                  time: nstr,
                  date: nstr,
                  terminal: nstr,
                },
              },
              destination: {
                type: Type.OBJECT,
                nullable: true,
                properties: {
                  city: nstr,
                  code: nstr,
                  time: nstr,
                  date: nstr,
                  terminal: nstr,
                },
              },
              ancillaries: {
                type: Type.OBJECT,
                nullable: true,
                properties: {
                  cabin_bag: nstr,
                  checkin_bag: nstr,
                  seat: nstr,
                  meal: nstr,
                  barcode_string: nstr,
                },
              },
            },
          },
        },
        passengers: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: nstr,
              type: nstr,
              ticket_no: nstr,
              phone: nstr,
              email: nstr,
              baggage_check_in: nstr,
              baggage_cabin: nstr,
              seat: nstr,
              meal: nstr,
              barcode_string: nstr,
              special_service: nstr,
            },
          },
        },
      },
    },

    hotel: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        name: nstr,
        address: nstr,
        city: nstr,
        country: nstr,
        contact: nstr,

        primary_guest: nstr,
        total_pax: nstr,

        // IMPORTANT: allow numeric OR numeric-like strings by accepting NUMBER here
        // and normalizing in code. This prevents schema rejection.
        adults: nnum,
        children: nnum,
        all_guest_names: { type: Type.ARRAY, items: { type: Type.STRING } },

        room_type: nstr,
        no_of_rooms: nstr,
        inclusions: { type: Type.ARRAY, items: { type: Type.STRING } },
        special_requests: nstr,

        stay: {
          type: Type.OBJECT,
          nullable: true,
          properties: {
            check_in_date: nstr,
            check_in_time: nstr,
            check_out_date: nstr,
            check_out_time: nstr,
            total_nights: nstr,
          },
        },
      },
    },

    barcode_candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: nstr,
          value: nstr,
          source: nstr,
          page: { type: Type.INTEGER, nullable: true },
          confidence: nnum,
        },
      },
    },
  },
  required: ["detected_type"],
} as const;

/* ───────────────────────── validate normalized voucher (strict shape) ───────────────────────── */

type ValidationError = { path: string; message: string };

function validateVoucherShape(v: any): ValidationError[] {
  const errs: ValidationError[] = [];
  const isObj = (x: any) => x && typeof x === "object" && !Array.isArray(x);
  const req = (cond: boolean, path: string, message: string) => {
    if (!cond) errs.push({ path, message });
  };

  req(v && typeof v === "object", "", "Voucher must be an object");
  if (!v || typeof v !== "object") return errs;

  req(v.type === "hotel" || v.type === "flight", "type", "Invalid type");

  req(
    v.layout_type === undefined ||
      v.layout_type === "SINGLE" ||
      v.layout_type === "DUAL" ||
      v.layout_type === "GROUP",
    "layout_type",
    "layout_type must be SINGLE/DUAL/GROUP or undefined"
  );

  req(isObj(v.booking_info), "booking_info", "booking_info must be object");

  req(isObj(v.policies), "policies", "policies must be object");
  if (isObj(v.policies)) {
    req(
      typeof v.policies.is_non_refundable === "boolean",
      "policies.is_non_refundable",
      "is_non_refundable must be boolean"
    );
    req(
      Array.isArray(v.policies.important_notes),
      "policies.important_notes",
      "important_notes must be string[]"
    );
  }

  if (v.type === "flight") {
    req(isObj(v.flight_details), "flight_details", "flight_details required for flight");
    if (isObj(v.flight_details)) {
      req(Array.isArray(v.flight_details.segments), "flight_details.segments", "segments must be array");
    }
    // IMPORTANT: passengers are OPTIONAL in backend type. If present, must be array.
    req(
      v.passengers === undefined || Array.isArray(v.passengers),
      "passengers",
      "passengers must be array when present"
    );
  }

  if (v.type === "hotel") {
    req(isObj(v.hotel_details), "hotel_details", "hotel_details required for hotel");
    req(isObj(v.stay_details), "stay_details", "stay_details required for hotel");
    req(isObj(v.guest_details), "guest_details", "guest_details required for hotel");
    req(isObj(v.room_details), "room_details", "room_details required for hotel");
  }

  return errs;
}

/* ───────────────────────── normalize RAW -> PlumtripsVoucher ───────────────────────── */

function normalizeToVoucher(args: {
  raw: RawCandidate;
  forcedType: VoucherType;
  customLogo: string;
}): PlumtripsVoucher {
  const { raw, forcedType, customLogo } = args;

  const detected: VoucherType =
    raw.detected_type === "hotel" || raw.detected_type === "flight"
      ? raw.detected_type
      : forcedType;

  const type: VoucherType = forcedType || detected;

  const b = raw.booking_info || {};
  const p = raw.policies || {};

  const notes = toStringArray(p.notes, 80);
  const bestBarcode = pickBestBarcode(raw.barcode_candidates);

  const is_non_refundable =
    typeof p.is_non_refundable === "boolean" ? p.is_non_refundable : inferNonRefundable(notes);

  const voucher: PlumtripsVoucher = {
    type,
    layout_type: "SINGLE", // set after blocks are built
    booking_info: {
      booking_id: toNullString(b.booking_id),
      booking_date: toNullString(b.booking_date),
      voucher_no: toNullString(b.voucher_no),
      supplier_conf_no: toNullString(b.supplier_conf_no),

      pnr: type === "flight" ? toNullString(b.pnr) : null,
      fare_type: type === "flight" ? toNullString(b.fare_type) : null,
      ocr_data_line: type === "flight" ? toNullString(b.ocr_data_line) : null,

      custom_logo: customLogo,
    },
    policies: {
      cancellation_deadline: toNullString(p.cancellation_deadline),
      is_non_refundable,
      important_notes: notes,
    },
  };

  if (type === "flight") {
    const segs = Array.isArray(raw.flight?.segments) ? raw.flight!.segments! : [];
    const pax = Array.isArray(raw.flight?.passengers) ? raw.flight!.passengers! : [];

    const segments: FlightSegment[] = segs.map((s) => {
      const origin = s.origin || {};
      const dest = s.destination || {};
      const anc = s.ancillaries || {};

      const a: Ancillaries = {
        cabin_bag: toNullString(anc.cabin_bag),
        checkin_bag: toNullString(anc.checkin_bag),
        seat: toNullString(anc.seat),
        meal: toNullString(anc.meal),
        barcode_string: toNullString(anc.barcode_string) || bestBarcode,
      };

      return {
        airline: toNullString(s.airline),
        flight_no: toNullString(s.flight_no),
        class: toNullString(s.class),
        duration: toNullString(s.duration),
        layover_duration: toNullString(s.layover_duration),

        origin: {
          city: toNullString(origin.city),
          code: toNullString(origin.code),
          time: toNullString(origin.time),
          date: toNullString(origin.date),
          terminal: toNullString(origin.terminal),
        },

        destination: {
          city: toNullString(dest.city),
          code: toNullString(dest.code),
          time: toNullString(dest.time),
          date: toNullString(dest.date),
          terminal: toNullString(dest.terminal),
        },

        // Always set ancillaries for UI stability even though optional in type
        ancillaries: a || defaultAncillaries(),
      };
    });

    const passengers: Passenger[] = pax.map((pp) => ({
      name: toNullString(pp.name),
      type: toNullString(pp.type),
      ticket_no: toNullString(pp.ticket_no),
      phone: toNullString(pp.phone),
      email: toNullString(pp.email),
      baggage_check_in: toNullString(pp.baggage_check_in),
      baggage_cabin: toNullString(pp.baggage_cabin),
      seat: toNullString(pp.seat),
      meal: toNullString(pp.meal),
      barcode_string: toNullString(pp.barcode_string) || bestBarcode,
      special_service: toNullString(pp.special_service),
    }));

    const flight_details: FlightDetails = { segments };
    voucher.flight_details = flight_details;

    // Backend type: passengers optional. Set it if we have any or if flight doc.
    voucher.passengers = passengers;
  }

  if (type === "hotel") {
    const h = raw.hotel || {};
    const stay = h.stay || {};

    const hotel_details: HotelDetails = {
      name: toNullString(h.name),
      address: toNullString(h.address),
      city: toNullString(h.city),
      country: toNullString(h.country),
      contact: toNullString(h.contact),
    };

    const guest_details: GuestDetails = {
      primary_guest: toNullString(h.primary_guest),
      total_pax: toNullString(h.total_pax),
      adults: Math.max(0, Math.floor(toNumber(h.adults, 0))),
      children: Math.max(0, Math.floor(toNumber(h.children, 0))),
      all_guest_names: Array.isArray(h.all_guest_names)
        ? h.all_guest_names
            .map((x) => toNullString(x))
            .filter((x): x is string => !!x)
        : [],
    };

    const room_details: RoomDetails = {
      room_type: toNullString(h.room_type),
      no_of_rooms: toNullString(h.no_of_rooms),
      inclusions: toStringArray(h.inclusions, 60),
      special_requests: toNullString(h.special_requests),
    };

    const stay_details: StayDetails = {
      check_in_date: toNullString(stay.check_in_date),
      check_in_time: toNullString(stay.check_in_time),
      check_out_date: toNullString(stay.check_out_date),
      check_out_time: toNullString(stay.check_out_time),
      total_nights: toNullString(stay.total_nights),
    };

    voucher.hotel_details = hotel_details;
    voucher.guest_details = guest_details;
    voucher.room_details = room_details;
    voucher.stay_details = stay_details;
  }

  // Branding invariants
  voucher.booking_info.custom_logo = customLogo;

  // Safety: important_notes always array
  voucher.policies.important_notes = Array.isArray(voucher.policies.important_notes)
    ? voucher.policies.important_notes
    : [];

  // Layout computed from actual content
  voucher.layout_type = computeLayout(type, raw, voucher);

  return voucher;
}

/* ───────────────────────── Gemini call ───────────────────────── */

async function generateRawCandidate(args: {
  ai: GoogleGenAI;
  model: string;
  base64: string;
  mimeType: string;
  voucherTypeHint: VoucherType;
  portalHint?: string | null;
  logo: string;
  repairFocus?: string | null;
}): Promise<{ raw: RawCandidate; rawText: string }> {
  const { ai, model, base64, mimeType, voucherTypeHint, portalHint, logo, repairFocus } = args;

  const systemPrompt = `
You are PlumTrips enterprise voucher extraction.
Return ONLY valid JSON matching the provided response schema.

Rules:
- Missing scalars: null. Missing arrays: [].
- Do NOT output empty strings.
- Do NOT output the string "null".
- detected_type must be: hotel | flight | unknown

Policy consolidation:
- Extract cancellation/terms/check-in/important information into policies.notes[] as concise bullet lines.
- Remove duplicates.

Flights:
- Preserve segment order.
- Extract baggage/seat/meal where present.
- If you see a scannable barcode/BCBP payload as TEXT (often long alphanumeric), include it in barcode_candidates[].
  Use kind=BCBP when it looks like a boarding pass BCBP payload.

Hotels:
- Extract hotel details including contact if present.
- Extract guest summary (adults/children/guest names) if present.
- Extract room inclusions.
- Extract stay dates/times/nights.

Never invent values.
Branding/logo is handled by backend = "${logo}".
`.trim();

  const userText = `
Extract this voucher into the RAW contract schema (not final PlumtripsVoucher).
Voucher type hint: ${voucherTypeHint}.
Portal hint: ${portalHint || "unknown"}.
${repairFocus ? `Repair focus:\n${repairFocus}\n` : ""}
`.trim();

  const resp = await ai.models.generateContent({
    model,
    contents: {
      parts: [{ text: userText }, { inlineData: { data: base64, mimeType } }],
    },
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      responseSchema: rawSchema as any,
    },
  });

  const text = (resp.text || "").trim();
  if (!text) throw new Error("No response from model");

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Model returned invalid JSON");
  }

  return { raw: parsed as RawCandidate, rawText: text };
}

/* ───────────────────────── Public API ───────────────────────── */

export async function extractVoucherViaGemini(opts: {
  buffer: Buffer;
  mimeType: string;
  voucherType: VoucherType;
  customLogoUrl?: string | null;
  portalHint?: string | null;
}): Promise<{ parsed: PlumtripsVoucher; raw: any }> {
  const ai = getAI();
  const modelName = (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim()) || DEFAULT_MODEL;

  const logo = safeLogo(opts.customLogoUrl);
  const base64 = opts.buffer.toString("base64");

  // Pass 1: RAW extraction
  let raw1: RawCandidate;
  let rawText1: string;

  try {
    const r1 = await generateRawCandidate({
      ai,
      model: modelName,
      base64,
      mimeType: opts.mimeType,
      voucherTypeHint: opts.voucherType,
      portalHint: opts.portalHint,
      logo,
      repairFocus: null,
    });
    raw1 = r1.raw;
    rawText1 = r1.rawText;
  } catch {
    // Retry once for JSON stability
    const r2 = await generateRawCandidate({
      ai,
      model: modelName,
      base64,
      mimeType: opts.mimeType,
      voucherTypeHint: opts.voucherType,
      portalHint: opts.portalHint,
      logo,
      repairFocus: "Previous attempt returned invalid JSON. Output strictly valid JSON only.",
    });
    raw1 = r2.raw;
    rawText1 = r2.rawText;
  }

  // Normalize to strict backend voucher
  let normalized = normalizeToVoucher({
    raw: raw1,
    forcedType: opts.voucherType,
    customLogo: logo,
  });

  // Validate normalized shape (do not over-reject optional blocks)
  let errors = validateVoucherShape(normalized);

  // Repair pass: targeted re-extract RAW if shape issues remain
  if (errors.length) {
    const focus = errors
      .slice(0, 25)
      .map((e) => `${e.path}: ${e.message}`)
      .join("\n");

    const repaired = await generateRawCandidate({
      ai,
      model: modelName,
      base64,
      mimeType: opts.mimeType,
      voucherTypeHint: opts.voucherType,
      portalHint: opts.portalHint,
      logo,
      repairFocus: focus,
    });

    normalized = normalizeToVoucher({
      raw: repaired.raw,
      forcedType: opts.voucherType,
      customLogo: logo,
    });

    errors = validateVoucherShape(normalized);
  }

  // Branding invariant
  normalized.booking_info.custom_logo = logo;

  return {
    parsed: normalized,
    raw: {
      raw_candidate: raw1,
      raw_text: rawText1,
      validation_errors: errors,
      model: modelName,
    },
  };
}
