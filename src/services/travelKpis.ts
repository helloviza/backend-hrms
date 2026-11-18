// apps/backend/src/services/travelKpis.ts
//
// Travel Spend panels added in Phase B additions (2026-11-18), computed from
// CONFIRMED TravelBooking mirror rows (plus PENDING for the service cards):
//   - Booking lead time + last-minute share (flights)
//   - Hotel average nightly rate by city + average stay
//   - Top routes (city pairs) with average fare
//   - Carbon (from calculated CarbonRecords, per flight booking)
//   - Visa / Forex / eSIM cards: processed, under processing, total + avg cost
// Every panel reports its own coverage ("based on N of M") so missing data is
// never read as zero. Pure — GET /admin/unified/travel-kpis and
// /service-cards run these on the scoped rows.

const DAY = 86400000;
const IST_MS = 330 * 60000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const istDay = (d: unknown) => {
  const t = d instanceof Date ? d.getTime() : d ? new Date(String(d)).getTime() : NaN;
  return Number.isFinite(t) ? Math.floor((t + IST_MS) / DAY) : null;
};
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : r2((s[m - 1] + s[m]) / 2);
}

export type KpiRow = {
  service?: string | null;
  status?: string | null;
  amount?: number | null;
  bookedAt?: Date | string | null;
  travelDate?: Date | string | null;
  destinationCity?: string | null;
  reference?: unknown;
  metadata?: Record<string, any> | null;
};

/* ── Lead time ─────────────────────────────────────────────── */

export const LAST_MINUTE_DAYS = 3;
export const LEAD_BUCKETS = [
  { label: "Same day", min: 0, max: 0 },
  { label: "1–3 days", min: 1, max: 3 },
  { label: "4–7 days", min: 4, max: 7 },
  { label: "8–14 days", min: 8, max: 14 },
  { label: "15–30 days", min: 15, max: 30 },
  { label: "31+ days", min: 31, max: Infinity },
] as const;

export type LeadTime = {
  buckets: { label: string; count: number; pct: number }[];
  medianDays: number | null;
  avgDays: number | null;
  lastMinute: { days: number; count: number; pct: number };
  measured: number;
  total: number;
  missingTravelDate: number;
  negative: number;
};

/**
 * Days from booking to travel, in IST calendar days, for flight bookings.
 * A travel date before the booking date is a data error — counted, excluded.
 */
export function computeLeadTime(rows: KpiRow[]): LeadTime {
  const flights = rows.filter((r) => r.service === "FLIGHT");
  const days: number[] = [];
  let missingTravelDate = 0, negative = 0;
  for (const r of flights) {
    const b = istDay(r.bookedAt), t = istDay(r.travelDate);
    if (b == null || t == null) { missingTravelDate++; continue; }
    if (t < b) { negative++; continue; }
    days.push(t - b);
  }
  const last = days.filter((d) => d <= LAST_MINUTE_DAYS).length;
  return {
    buckets: LEAD_BUCKETS.map((bk) => {
      const count = days.filter((d) => d >= bk.min && d <= bk.max).length;
      return { label: bk.label, count, pct: pct(count, days.length) };
    }),
    medianDays: median(days),
    avgDays: days.length ? r2(days.reduce((a, b) => a + b, 0) / days.length) : null,
    lastMinute: { days: LAST_MINUTE_DAYS, count: last, pct: pct(last, days.length) },
    measured: days.length,
    total: flights.length,
    missingTravelDate,
    negative,
  };
}

/* ── Hotels: nightly rate by city + average stay ───────────── */

/** Bookings with more rooms than this are group bookings — left out of stay and rate. */
export const GROUP_ROOMS_OVER = 10;

export type HotelRates = {
  /** Group bookings (more than GROUP_ROOMS_OVER rooms) left out of every figure below. */
  excludedGroup: number;
  cities: { city: string; bookings: number; roomNights: number; spend: number; avgNightly: number }[];
  avgStay: number | null;
  medianStay: number | null;
  withNights: number;
  withCity: number;
  measured: number;
  total: number;
};

const validNights = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v >= 1 && v < 60 ? v : null;
};

/**
 * Average stay over hotel rows with nights; ₹ per room-night by city over rows
 * with both. Group bookings (more than 10 rooms) are left out of both — one
 * conference block would otherwise swamp a city's rate.
 */
export function computeHotelRates(rows: KpiRow[], topN = 8): HotelRates {
  const all = rows.filter((r) => r.service === "HOTEL");
  const isGroup = (r: KpiRow) => (Number(r.metadata?.rooms) || 1) > GROUP_ROOMS_OVER;
  const hotels = all.filter((r) => !isGroup(r));
  const stays: number[] = [];
  const byCity = new Map<string, { bookings: number; roomNights: number; spend: number }>();
  let withCity = 0, measured = 0;
  for (const h of hotels) {
    const n = validNights(h.metadata?.nights);
    const city = String(h.destinationCity || "").trim();
    if (n != null) stays.push(n);
    if (city) withCity++;
    if (n == null || !city) continue;
    measured++;
    const rooms = Math.max(1, Number(h.metadata?.rooms) || 1);
    const c = byCity.get(city) ?? { bookings: 0, roomNights: 0, spend: 0 };
    c.bookings += 1;
    c.roomNights += n * rooms;
    c.spend += Number(h.amount) || 0;
    byCity.set(city, c);
  }
  const cities = [...byCity.entries()]
    .sort((a, b) => b[1].bookings - a[1].bookings || b[1].spend - a[1].spend)
    .slice(0, topN)
    .map(([city, c]) => ({ city, bookings: c.bookings, roomNights: c.roomNights, spend: r2(c.spend), avgNightly: r2(c.spend / c.roomNights) }));
  return {
    excludedGroup: all.length - hotels.length,
    cities,
    avgStay: stays.length ? r2(stays.reduce((a, b) => a + b, 0) / stays.length) : null,
    medianStay: median(stays),
    withNights: stays.length,
    withCity,
    measured,
    total: hotels.length,
  };
}

/* ── Top routes ───────────────────────────────────────────── */

export type TopRoutes = {
  routes: { route: string; a: string; b: string; count: number; spend: number; avgFare: number; pct: number }[];
  resolved: number;
  total: number;
};

/** City pairs (direction-free: Delhi ⇄ Mumbai is one route), by bookings. */
export function computeTopRoutes(rows: KpiRow[], topN = 10): TopRoutes {
  const flights = rows.filter((r) => r.service === "FLIGHT");
  const pairs = new Map<string, { a: string; b: string; count: number; spend: number }>();
  let resolved = 0;
  for (const f of flights) {
    const o = String(f.metadata?.originCity || "").trim();
    const d = String(f.destinationCity || "").trim();
    if (!o || !d || o === d) continue;
    resolved++;
    const [a, b] = [o, d].sort((x, y) => x.localeCompare(y));
    const k = `${a}|${b}`;
    const p = pairs.get(k) ?? { a, b, count: 0, spend: 0 };
    p.count += 1;
    p.spend += Number(f.amount) || 0;
    pairs.set(k, p);
  }
  const routes = [...pairs.values()]
    .sort((x, y) => y.count - x.count || y.spend - x.spend)
    .slice(0, topN)
    .map((p) => ({ route: `${p.a} ⇄ ${p.b}`, a: p.a, b: p.b, count: p.count, spend: r2(p.spend), avgFare: r2(p.spend / p.count), pct: pct(p.count, resolved) }));
  return { routes, resolved, total: flights.length };
}

/* ── Carbon ───────────────────────────────────────────────── */

export type CarbonRecordLite = { bookingId?: unknown; co2eKg?: number | null; distanceKm?: number | null };
export type Carbon = {
  co2eKg: number;
  covered: number;
  total: number;
  coveragePct: number;
  avgKgPerFlight: number | null;
  gramsPerKm: number | null;
  distanceKm: number;
};

/**
 * Totals over the flight bookings that have at least one calculated carbon
 * record (records are per passenger per segment, built from the extracted
 * ticket — so coverage is the share of flights with a ticket on file).
 */
export function computeCarbon(flightRefs: unknown[], records: CarbonRecordLite[]): Carbon {
  const refs = new Set(flightRefs.map((r) => String(r)));
  const per = new Map<string, { kg: number; km: number }>();
  for (const rec of records) {
    const k = String(rec.bookingId ?? "");
    if (!refs.has(k) || typeof rec.co2eKg !== "number") continue;
    const p = per.get(k) ?? { kg: 0, km: 0 };
    p.kg += rec.co2eKg;
    p.km += Number(rec.distanceKm) || 0;
    per.set(k, p);
  }
  let kg = 0, km = 0;
  for (const p of per.values()) { kg += p.kg; km += p.km; }
  return {
    co2eKg: r2(kg),
    covered: per.size,
    total: refs.size,
    coveragePct: pct(per.size, refs.size),
    avgKgPerFlight: per.size ? r2(kg / per.size) : null,
    gramsPerKm: km > 0 ? r2((kg * 1000) / km) : null,
    distanceKm: Math.round(km),
  };
}

/* ── Visa / Forex / eSIM cards ────────────────────────────── */

export const SERVICE_CARDS = ["VISA", "FOREX", "ESIM"] as const;
export type ServiceCardKey = (typeof SERVICE_CARDS)[number];
export type ServiceCard = {
  processed: number;
  underProcessing: number;
  totalCost: number;
  avgCost: number | null;
  /** Visa only: outcomes recorded on the booking (optional field). */
  outcomes?: { APPROVED: number; REJECTED: number; AWAITING: number; recorded: number };
};

/** Which card a mirror row belongs to (the US visa appointment fee mirrors as OTHER). */
export function serviceCardOf(r: KpiRow): ServiceCardKey | null {
  if (r.service === "VISA" || r.metadata?.manualType === "US_VISA_EARLY_APPOINTMENT_FEE") return "VISA";
  if (r.service === "FOREX") return "FOREX";
  if (r.service === "ESIM") return "ESIM";
  return null;
}

/**
 * processed = CONFIRMED (manual Confirmed / Invoiced), under processing =
 * PENDING (manual Pending / WIP); cancelled and failed are left out. Cost is
 * over processed bookings. A card with neither count has no data in range.
 */
export function computeServiceCards(rows: KpiRow[]): Record<ServiceCardKey, ServiceCard> {
  const out = {} as Record<ServiceCardKey, ServiceCard>;
  for (const k of SERVICE_CARDS) out[k] = { processed: 0, underProcessing: 0, totalCost: 0, avgCost: null };
  out.VISA.outcomes = { APPROVED: 0, REJECTED: 0, AWAITING: 0, recorded: 0 };
  for (const r of rows) {
    const k = serviceCardOf(r);
    if (!k) continue;
    if (r.status === "CONFIRMED") { out[k].processed++; out[k].totalCost += Number(r.amount) || 0; }
    else if (r.status === "PENDING") out[k].underProcessing++;
    else continue;
    const o = String(r.metadata?.visaOutcome || "");
    if (k === "VISA" && (o === "APPROVED" || o === "REJECTED" || o === "AWAITING")) {
      out.VISA.outcomes![o]++;
      out.VISA.outcomes!.recorded++;
    }
  }
  for (const k of SERVICE_CARDS) {
    out[k].totalCost = r2(out[k].totalCost);
    out[k].avgCost = out[k].processed ? r2(out[k].totalCost / out[k].processed) : null;
  }
  return out;
}
