// apps/backend/src/services/policyCompliance/trips.ts
//
// Policy Compliance counts per TRIP, not per booking (decision 2026-11-25).
// Bookings belong to one trip when they share an approval request, else when
// the same traveller goes to the same destination on overlapping dates. Pure.
import type { Evaluation, Outcome } from "./evaluate.js";
import { UNKNOWN_REGION, type RegionLabel } from "./regions.js";

export interface ComplianceBooking extends Evaluation {
  id: string;
  companyId: string;
  company: string;
  /** "" = nobody to match it to: the booking stays a trip of its own. */
  travellerKey: string;
  employee: string;
  employeeId: string;
  department: string;
  workLocation: string;
  workRegion: RegionLabel;
  destinationRegion: RegionLabel;
  /** Normalised city (else free text); "" = unknown. */
  destinationKey: string;
  approvalRequestId: string | null;
  service: string;
  sector: string;
  isInternational: boolean | null;
  requestedOn: string | null;
  travelOn: string | null;
  /** Last day: return / arrival / check-out; null = same as travelOn. */
  travelEnd: string | null;
  amount: number;
}

export interface TripService {
  service: string;
  sector: string;
  late: boolean;
  requiredDays: number | null;
  actualDays: number | null;
  amount: number;
}

export interface ComplianceTrip extends Evaluation {
  id: string;
  companyId: string;
  company: string;
  travellerKey: string;
  employee: string;
  employeeId: string;
  department: string;
  workLocation: string;
  workRegion: RegionLabel;
  destinationRegion: RegionLabel;
  services: TripService[];
  sector: string;
  isInternational: boolean | null;
  requestedOn: string | null;
  travelOn: string | null;
  amount: number;
}

/* ── Grouping ─────────────────────────────────────────────────────────── */

interface Cluster {
  rows: ComplianceBooking[];
  start: string | null;
  end: string | null;
}

const endOf = (b: ComplianceBooking): string | null => (b.travelOn && b.travelEnd && b.travelEnd > b.travelOn ? b.travelEnd : b.travelOn);
const overlaps = (a: Cluster, b: Cluster) => !!a.start && !!b.start && a.start <= b.end! && b.start <= a.end!;

function clusterOf(rows: ComplianceBooking[]): Cluster {
  const starts = rows.map((r) => r.travelOn).filter((d): d is string => !!d).sort();
  const ends = rows.map(endOf).filter((d): d is string => !!d).sort();
  return { rows, start: starts[0] ?? null, end: ends[ends.length - 1] ?? null };
}

/**
 * One list of bookings per trip. An approval request that covers several
 * travellers gives one trip per traveller. A booking without a request joins
 * the overlapping trip of the same traveller to the same destination; two
 * different requests are never merged.
 */
export function groupTrips(bookings: ComplianceBooking[]): ComplianceBooking[][] {
  const byRequest = new Map<string, ComplianceBooking[]>();
  const loose: ComplianceBooking[] = [];
  for (const b of bookings) {
    if (!b.approvalRequestId) {
      loose.push(b);
      continue;
    }
    const k = `${b.companyId}|${b.approvalRequestId}|${b.travellerKey}`;
    byRequest.set(k, [...(byRequest.get(k) ?? []), b]);
  }
  const trips: Cluster[] = [...byRequest.values()].map(clusterOf);
  const requestTrips = [...trips];

  const groups = new Map<string, ComplianceBooking[]>();
  for (const b of loose) {
    if (!b.travellerKey || !b.destinationKey || !b.travelOn) {
      trips.push(clusterOf([b]));
      continue;
    }
    const k = `${b.companyId}|${b.travellerKey}|${b.destinationKey}`;
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  for (const [k, rows] of groups) {
    rows.sort((a, b) => a.travelOn!.localeCompare(b.travelOn!) || a.id.localeCompare(b.id));
    const merged: Cluster[] = [];
    for (const r of rows) {
      const next = clusterOf([r]);
      const last = merged[merged.length - 1];
      if (last && overlaps(last, next)) merged[merged.length - 1] = clusterOf([...last.rows, r]);
      else merged.push(next);
    }
    const mine = requestTrips
      .filter((t) => t.rows.some((r) => `${r.companyId}|${r.travellerKey}|${r.destinationKey}` === k))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    for (const m of merged) {
      const host = mine.find((t) => overlaps(t, m));
      if (host) host.rows.push(...m.rows);
      else trips.push(m);
    }
  }
  return trips.map((t) => t.rows);
}

/* ── One verdict per trip ─────────────────────────────────────────────── */

/**
 * A trip is in violation when ANY of its bookings is. A booking that could not
 * be settled (tier or destination unknown) keeps the whole trip from being
 * called compliant; one with no rule to meet does not.
 */
const PRECEDENCE: Outcome[] = [
  "VIOLATION",
  "UNMAPPED",
  "UNKNOWN_DESTINATION",
  "COMPLIANT",
  "NO_RULE",
  "GUEST",
  "NOT_IN_FORCE",
  "BAD_DATES",
  "NOT_CONFIGURED",
];

const SERVICE_ORDER = ["FLIGHT", "HOTEL"];
const rank = (s: string) => (SERVICE_ORDER.indexOf(s) + 1 || 99);

export function toTrip(rows: ComplianceBooking[]): ComplianceTrip {
  const ordered = [...rows].sort((a, b) => rank(a.service) - rank(b.service) || String(a.travelOn).localeCompare(String(b.travelOn)) || a.id.localeCompare(b.id));
  const outcome = PRECEDENCE.find((o) => ordered.some((r) => r.outcome === o))!;
  // The dates and days shown are those of the booking that decided the outcome:
  // for a violation, the one furthest short.
  const decided = ordered.filter((r) => r.outcome === outcome).sort((a, b) => (b.daysShort ?? 0) - (a.daysShort ?? 0))[0];
  const first = ordered[0];
  return {
    outcome,
    requiredDays: decided.requiredDays,
    actualDays: decided.actualDays,
    daysShort: decided.daysShort,
    versionNumber: decided.versionNumber,
    id: [...rows].map((r) => r.id).sort()[0],
    companyId: first.companyId,
    company: first.company,
    travellerKey: first.travellerKey || `b:${first.id}`,
    employee: first.employee,
    employeeId: first.employeeId,
    department: first.department,
    workLocation: first.workLocation,
    workRegion: first.workRegion,
    destinationRegion: ordered.find((r) => r.destinationRegion !== UNKNOWN_REGION)?.destinationRegion ?? UNKNOWN_REGION,
    services: ordered.map((r) => ({
      service: r.service,
      sector: r.sector,
      late: r.outcome === "VIOLATION",
      requiredDays: r.requiredDays,
      actualDays: r.actualDays,
      amount: r.amount,
    })),
    sector: first.sector,
    isInternational: ordered.some((r) => r.isInternational === true) ? true : ordered.some((r) => r.isInternational === false) ? false : null,
    requestedOn: decided.requestedOn,
    travelOn: decided.travelOn,
    amount: Math.round(ordered.reduce((a, r) => a + r.amount, 0) * 100) / 100,
  };
}

export function buildTrips(bookings: ComplianceBooking[]): ComplianceTrip[] {
  return groupTrips(bookings).map(toTrip);
}
