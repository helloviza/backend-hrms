// apps/backend/src/services/quarterlySpend.ts
//
// Quarterly Spend panel (Travel Spend audit N10). Quarters are IST calendar
// quarters; the panel shows the last QUARTERS_SHOWN quarters ending with the
// "anchor" quarter (the quarter of the filter's `to`, else today), and its
// stats are relative to that anchor:
//   prev closed  — the quarter before the anchor
//   to date      — the anchor quarter so far
//   projected    — run-rate over the whole anchor quarter (= to date once it has closed)
// It used to hard-code "Q1 closed / Q2 to date / Q2 projected", which read
// stale or zero from Q3 on.
//
// Day values are "day-key epochs" — Date.UTC of an IST calendar date.

export const QUARTERS_SHOWN = 4;
const DAY_MS = 86400000;

export type QuarterSlot = { y: number; q: number; startMs: number; endMs: number };
export type QuarterPlan = { quarters: QuarterSlot[]; windowFromMs: number; windowToMs: number };

const slot = (y: number, q: number): QuarterSlot => ({
  y, q, startMs: Date.UTC(y, (q - 1) * 3, 1), endMs: Date.UTC(y, q * 3, 1),
});

/** `anchor` is a day-key epoch Date (UTC fields = the IST date). */
export function quarterPlan(anchor: Date, _now: Date = new Date(), shown = QUARTERS_SHOWN): QuarterPlan {
  let y = anchor.getUTCFullYear();
  let q = Math.floor(anchor.getUTCMonth() / 3) + 1;
  const quarters: QuarterSlot[] = [];
  for (let i = 0; i < shown; i++) {
    quarters.unshift(slot(y, q));
    q -= 1;
    if (q === 0) { q = 4; y -= 1; }
  }
  return { quarters, windowFromMs: quarters[0].startMs, windowToMs: quarters[quarters.length - 1].endMs };
}

export type QuarterRow = { label: string; year: number; quarter: number; partial: boolean; flight: number; hotel: number; other: number; total: number };
export type QuarterlyStats = {
  prevLabel: string; prevClosed: number | null;
  currentLabel: string; currentToDate: number; currentProjected: number | null;
  /** Legacy keys (pre-Phase B frontend) — same values as prev / current. */
  q1Closed: number | null; q2ToDate: number; q2Projected: number | null;
};

const istToday = (now: Date) => Date.parse(new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10) + "T00:00:00Z");
const labelOf = (s: QuarterSlot) => `Q${s.q} ${s.y}`;

export function buildQuarterly(
  rows: { _id: { y: number; q: number; svc: string }; amount: number }[],
  plan: QuarterPlan,
  now: Date = new Date(),
): { ok: true; quarters: QuarterRow[]; stats: QuarterlyStats } {
  const today = istToday(now);
  const byKey = new Map(plan.quarters.map((s) => [`${s.y}-${s.q}`, { s, flight: 0, hotel: 0, other: 0 }]));
  for (const r of rows) {
    const e = byKey.get(`${r._id.y}-${r._id.q}`);
    if (!e) continue;
    if (r._id.svc === "FLIGHT") e.flight += r.amount;
    else if (r._id.svc === "HOTEL") e.hotel += r.amount;
    else e.other += r.amount; // Visa, Cab, Forex, Holiday, MICE, Train, Other …
  }
  const quarters: QuarterRow[] = [...byKey.values()].map((e) => {
    const partial = today >= e.s.startMs && today < e.s.endMs;
    return {
      label: `${labelOf(e.s)}${partial ? "*" : ""}`, year: e.s.y, quarter: e.s.q, partial,
      flight: e.flight, hotel: e.hotel, other: e.other, total: e.flight + e.hotel + e.other,
    };
  });

  const cur = quarters[quarters.length - 1];
  const prev = quarters.length > 1 ? quarters[quarters.length - 2] : null;
  const curSlot = plan.quarters[plan.quarters.length - 1];
  let currentProjected: number | null = cur.total;
  if (cur.partial) {
    const totalDays = Math.round((curSlot.endMs - curSlot.startMs) / DAY_MS);
    const elapsed = Math.min(totalDays, Math.max(1, Math.floor((today - curSlot.startMs) / DAY_MS) + 1));
    currentProjected = Math.round((cur.total / elapsed) * totalDays);
  } else if (today < curSlot.startMs) {
    currentProjected = null; // a future quarter has nothing to project from
  }
  const prevClosed = prev ? prev.total : null;
  return {
    ok: true,
    quarters,
    stats: {
      prevLabel: prev ? `Q${prev.quarter} ${prev.year}` : "",
      prevClosed,
      currentLabel: `Q${cur.quarter} ${cur.year}`,
      currentToDate: cur.total,
      currentProjected,
      q1Closed: prevClosed, q2ToDate: cur.total, q2Projected: currentProjected,
    },
  };
}
