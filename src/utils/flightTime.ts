// apps/backend/src/utils/flightTime.ts
//
// Departure clock times for Travel Spend's "Departure time" panel (Phase B).
//
//   - Manual bookings store each leg's time as printed text ("06:30",
//     "18:15 hrs", "07:00 Fri", "15:2O"). parseClockTime() reads that
//     leniently into minutes after midnight; anything it can't read is
//     "no time", never a guess.
//   - SBT bookings carry departureTime as the airline's local wall clock with
//     NO timezone ("2026-03-15T14:20:00"). Domestic SBT is Indian clock time,
//     so it is read as IST (+05:30) — decision 2026-11-18. The old
//     `new Date(str)` read it in the server's zone (UTC on App Runner) and
//     stored 14:20 IST as 14:20 UTC.

export const IST_OFFSET = "+05:30";

/** "HH:MM" text → minutes after midnight, or null. */
export function parseClockTime(raw: unknown): number | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  s = s
    .replace(/\s*(hrs?|hours?)\.?$/i, "")
    .replace(/\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i, "")
    .replace(/(\d)[oO]/g, "$10")
    .trim();
  let m = s.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i);
  if (!m) m = s.match(/^(\d{2})(\d{2})$/); // "0630"
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = String(m[3] ?? "").toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export const fmtClock = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** The 7 IST slots the panel shows, in order. */
export const DEPART_SLOTS = ["<06", "06-09", "09-12", "12-15", "15-18", "18-21", ">=21"] as const;
export type DepartSlot = (typeof DEPART_SLOTS)[number];

export function slotOf(min: number): DepartSlot {
  if (min < 360) return "<06";
  if (min < 540) return "06-09";
  if (min < 720) return "09-12";
  if (min < 900) return "12-15";
  if (min < 1080) return "15-18";
  if (min < 1260) return "18-21";
  return ">=21";
}

/** Clock minutes of an SBT local timestamp string ("…T14:20:00"), or null. */
export function sbtClockMinutes(raw: unknown): number | null {
  const m = String(raw ?? "").match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/**
 * An SBT timestamp as a real instant. A string with no zone is IST wall
 * clock; one that already carries Z / an offset is taken as written.
 */
export function parseSbtLocalAsIST(raw: unknown): Date | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const withZone = hasZone ? s : /T\d{2}:\d{2}/.test(s) ? `${s.length === 16 ? `${s}:00` : s}${IST_OFFSET}` : s;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d;
}
