// apps/backend/src/services/policyCompliance/service.ts
//
// Policy Compliance reads (Travel Spend). Takes the same scoped match every
// other Travel Spend endpoint uses, so dates, filters, access scope and the
// demo / test exclusions are exactly the page's. Read-only.
import mongoose from "mongoose";
import TravelBooking from "../../models/TravelBooking.js";
import CustomerWorkspace from "../../models/CustomerWorkspace.js";
import TravelPolicyVersion from "../../models/TravelPolicyVersion.js";
import TravelPolicyCity from "../../models/TravelPolicyCity.js";
import { loadTravellers, travellerTier } from "../travelPolicy.service.js";
import { normalizeKey, type CityForClass, type Tier } from "../travelPolicy/core.js";
import { travelCountryOf } from "../../data/destinationLookup.js";
import { firstStop } from "../ticketFallback.js";
import { regionForCountry, workLocationCountry, UNKNOWN_REGION } from "./regions.js";
import { buildTrips, type ComplianceBooking, type ComplianceTrip } from "./trips.js";
import {
  buildTravellerIndex,
  evaluateTrip,
  homeCountry,
  isInternationalFor,
  istDayOf,
  leadName,
  nameKeyOf,
  readDomesticBasis,
  type DomesticBasis,
  type PolicyVersionLite,
} from "./evaluate.js";

export const COMPLIANCE_SERVICES = ["FLIGHT", "HOTEL"];

interface WorkspacePolicy {
  workspaceId: string;
  company: string;
  domesticBasis: DomesticBasis;
  versions: PolicyVersionLite[];
  cities: CityForClass[];
  travellers: Awaited<ReturnType<typeof loadTravellers>> | null;
  find: ReturnType<typeof buildTravellerIndex<any>> | null;
}

const uniq = (xs: unknown[]) => [...new Set(xs.filter(Boolean).map(String))];
const oids = (xs: unknown[]) => uniq(xs).filter((x) => mongoose.isValidObjectId(x)).map((x) => new mongoose.Types.ObjectId(x));
const col = (n: string) => mongoose.connection.collection(n);

/**
 * The policy of each company in `tenantIds` (TravelBooking.tenantId =
 * Customer._id) whose Travel Policy module is on. A company with the module
 * off is absent: its people cannot see a policy, so nothing is measured.
 */
async function loadPolicies(tenantIds: string[]): Promise<Map<string, WorkspacePolicy>> {
  const out = new Map<string, WorkspacePolicy>();
  if (!tenantIds.length) return out;
  const spaces: any[] = await CustomerWorkspace.find({ customerId: { $in: tenantIds }, "config.features.travelPolicyEnabled": true })
    .select("customerId companyName config.policyDomesticBasis")
    .lean();
  const versions: any[] = spaces.length
    ? await TravelPolicyVersion.find({ workspaceId: { $in: spaces.map((w) => w._id) }, status: "PUBLISHED" })
        .select("workspaceId status effectiveFrom effectiveTo versionNumber tiers rules")
        .lean()
    : [];
  for (const w of spaces) {
    const mine = versions.filter((v) => String(v.workspaceId) === String(w._id));
    const [travellers, cities] = mine.length
      ? await Promise.all([
          loadTravellers(w._id, { includeInactive: true }),
          TravelPolicyCity.find({ workspaceId: w._id }).select("cityKey nameKey country category isActive").lean(),
        ])
      : [null, []];
    out.set(String(w.customerId), {
      workspaceId: String(w._id),
      company: w.companyName || "",
      domesticBasis: readDomesticBasis(w.config?.policyDomesticBasis),
      versions: mine as PolicyVersionLite[],
      cities: cities as unknown as CityForClass[],
      travellers,
      find: travellers ? buildTravellerIndex(travellers.travellers) : null,
    });
  }
  return out;
}

/**
 * When the approval request behind a booking was submitted, keyed on the
 * booking's source id: an ApprovalRequest (Book Now bookings, and rows that
 * reference one directly) or a self-booking request. Absent = booked directly.
 * `approvals` holds the ApprovalRequest id only: a self-booking request covers
 * one service, so it cannot tie a flight and a hotel into one trip.
 */
async function requestLinks(rows: any[]): Promise<{ dates: Map<string, Date>; approvals: Map<string, string> }> {
  const refs = (model: string) => oids(rows.filter((r) => r.referenceModel === model).map((r) => r.reference));
  const manual = refs("ManualBooking");
  const flights = refs("SBTBooking");
  const hotels = refs("SBTHotelBooking");
  const approvals = refs("ApprovalRequest");
  const out = new Map<string, Date>();
  const approvalOf = new Map<string, string>();

  const linkedManual = manual.length
    ? await col("manualbookings")
        .find({ _id: { $in: manual }, source: "ADMIN_QUEUE", sourceBookingId: { $ne: null } }, { projection: { sourceBookingId: 1 } })
        .toArray()
    : [];
  const requestIds = oids([...approvals, ...linkedManual.map((m) => m.sourceBookingId)]);
  const reqs = requestIds.length
    ? await col("approvalrequests").find({ _id: { $in: requestIds } }, { projection: { createdAt: 1 } }).toArray()
    : [];
  const submitted = new Map(reqs.map((r) => [String(r._id), r.createdAt]));
  for (const m of linkedManual) {
    approvalOf.set(String(m._id), String(m.sourceBookingId));
    const at = submitted.get(String(m.sourceBookingId));
    if (at) out.set(String(m._id), at);
  }
  for (const id of approvals) {
    approvalOf.set(String(id), String(id));
    const at = submitted.get(String(id));
    if (at) out.set(String(id), at);
  }

  const sbtProjection = { projection: { sbtRequestId: 1 } };
  const linkedSbt = [
    ...(flights.length ? await col("sbtbookings").find({ _id: { $in: flights }, sbtRequestId: { $ne: null } }, sbtProjection).toArray() : []),
    ...(hotels.length ? await col("sbthotelbookings").find({ _id: { $in: hotels }, sbtRequestId: { $ne: null } }, sbtProjection).toArray() : []),
  ];
  const sbtIds = oids(linkedSbt.map((b) => b.sbtRequestId));
  const sbtReqs = sbtIds.length
    ? await col("sbtrequests").find({ _id: { $in: sbtIds } }, { projection: { requestedAt: 1, createdAt: 1 } }).toArray()
    : [];
  const asked = new Map(sbtReqs.map((r) => [String(r._id), r.requestedAt || r.createdAt]));
  for (const b of linkedSbt) {
    const at = asked.get(String(b.sbtRequestId));
    if (at) out.set(String(b._id), at);
  }
  return { dates: out, approvals: approvalOf };
}

function sectorOf(r: any): string {
  if (r.service === "HOTEL") {
    return [r.metadata?.hotelName, r.destinationCity || r.destination].map((x) => String(x ?? "").trim()).filter(Boolean).join(", ");
  }
  const from = String(r.metadata?.originCity || r.origin || "").trim();
  const to = String(r.destinationCity || r.destination || "").trim();
  return [from, to].filter(Boolean).join(" → ");
}

/** Country of every end of a flight, in order; null where the place is not recognised. */
function flightEndpoints(r: any): (string | null)[] {
  const legs: any[] = Array.isArray(r.metadata?.legs) ? r.metadata.legs : [];
  if (legs.length) return legs.flatMap((l) => [travelCountryOf(l.origin), travelCountryOf(l.destination)]);
  return [travelCountryOf(firstStop(r.origin)) ?? travelCountryOf(r.metadata?.originCity), r.destinationCountry || null];
}

/** Last day of the booking: return, check-out, or the last leg's arrival. */
function endDay(r: any): string | null {
  const legs: any[] = Array.isArray(r.metadata?.legs) ? r.metadata.legs : [];
  const days = [istDayOf(r.travelDateEnd), ...legs.map((l) => istDayOf(l.arriveDate))].filter((d): d is string => !!d).sort();
  return days[days.length - 1] ?? null;
}

/** Who travelled, for buildTravellerIndex. Manual rows carry the passenger; SBT rows have none, so the account holder is the traveller (as in Top travellers). */
function travellerOf(r: any) {
  const lead = leadName(r.travellerName);
  const user = r.userId && typeof r.userId === "object" && "_id" in r.userId ? r.userId : null;
  const userName = user ? user.name || [user.firstName, user.lastName].filter(Boolean).join(" ") : "";
  return {
    profileId: r.metadata?.travellerProfileId,
    userId: lead ? null : user?._id,
    email: lead ? r.travellerEmail : user?.email,
    name: lead || userName,
  };
}

const internationalOf = (home: string, r: any): boolean | null =>
  isInternationalFor(home, {
    service: r.service,
    mirrorInternational: typeof r.isInternational === "boolean" ? r.isInternational : null,
    destinationCountry: r.destinationCountry || null,
    endpoints: r.service === "FLIGHT" ? flightEndpoints(r) : [],
  });

/** CONFIRMED flights and hotels of the match, grouped into trips, each with its outcome. */
export async function loadComplianceTrips(scopedMatch: Record<string, any>): Promise<ComplianceTrip[]> {
  const svc = scopedMatch.service?.$in as string[] | undefined;
  const wanted = COMPLIANCE_SERVICES.filter((s) => !svc || svc.includes(s));
  if (!wanted.length) return [];
  const rows: any[] = await TravelBooking.find({ ...scopedMatch, status: "CONFIRMED", service: { $in: wanted } })
    .select(
      "tenantId service amount userId reference referenceModel destination destinationCity destinationCountry isInternational origin travellerName travellerEmail bookedAt travelDate travelDateEnd metadata.originCity metadata.hotelName metadata.travellerProfileId metadata.legs",
    )
    .populate("userId", "name firstName lastName email")
    .lean();
  const policies = await loadPolicies(uniq(rows.map((r) => r.tenantId)));
  const measured = rows.filter((r) => policies.has(String(r.tenantId)));
  const links = await requestLinks(measured);

  const bookings = measured.map((r): ComplianceBooking => {
    const policy = policies.get(String(r.tenantId))!;
    const who = travellerOf(r);
    const profile: any = policy.find ? policy.find(who) : null;
    const requestedOn = istDayOf(links.dates.get(String(r.reference)) ?? r.bookedAt);
    const travelOn = istDayOf(r.travelDate);
    const workCountry = profile ? workLocationCountry(profile.workLocation) : null;
    const home = homeCountry(policy.domesticBasis, workCountry);
    const isInternational = internationalOf(home, r);
    const verdict = evaluateTrip(
      {
        service: r.service,
        requestDay: requestedOn,
        travelDay: travelOn,
        isInternational,
        destinationCountry: r.destinationCountry || null,
        destinationCity: r.destinationCity || null,
        home,
      },
      policy.versions,
      (tiers: Tier[]) => (profile && policy.travellers ? travellerTier(policy.travellers, profile, tiers) : null),
      policy.cities,
    );
    return {
      ...verdict,
      id: String(r._id),
      companyId: String(r.tenantId || ""),
      company: policy.company,
      travellerKey: profile ? `p:${profile._id}` : `n:${String(who.email || "").toLowerCase() || nameKeyOf(who.name)}`.replace(/^n:$/, ""),
      employee: profile ? [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(" ") : who.name || "",
      employeeId: profile?.employeeId || profile?.travelerId || "",
      department: profile?.departmentId ? policy.travellers?.deptName.get(String(profile.departmentId)) || "" : "",
      workLocation: profile?.workLocation || "",
      workRegion: profile ? regionForCountry(workCountry) : UNKNOWN_REGION,
      destinationRegion: regionForCountry(r.destinationCountry),
      destinationKey: normalizeKey(r.destinationCity || r.destination),
      approvalRequestId: links.approvals.get(String(r.reference)) ?? null,
      service: r.service,
      sector: sectorOf(r),
      isInternational,
      requestedOn,
      travelOn,
      travelEnd: endDay(r),
      amount: Number(r.amount) || 0,
    };
  });
  return buildTrips(bookings);
}

/* ── Domestic vs International panel (one company at a time) ──────────── */

/** What classifyForCompany reads, on top of what the panel itself needs. */
export const DOMESTIC_FIELDS =
  "tenantId userId destinationCountry origin travellerName travellerEmail metadata.originCity metadata.travellerProfileId metadata.legs";

/**
 * What "domestic" means on a Travel Spend view of ONE company: its Travel
 * Policy setting, or India when the module is off or the view spans companies
 * (tenantId null).
 */
export async function domesticBasisFor(tenantId: string | null): Promise<{ basis: DomesticBasis; workspaceId: string | null }> {
  if (!tenantId) return { basis: "INDIA", workspaceId: null };
  const [w]: any[] = await CustomerWorkspace.find({ customerId: tenantId, "config.features.travelPolicyEnabled": true })
    .select("config.policyDomesticBasis")
    .limit(1)
    .lean();
  return { basis: readDomesticBasis(w?.config?.policyDomesticBasis), workspaceId: w ? String(w._id) : null };
}

/**
 * The rows with `isInternational` as seen from each traveller's work country:
 * the same rule Policy Compliance applies to the same bookings. A row of
 * another company keeps the India rule.
 */
export async function classifyForCompany<T extends Record<string, any>>(rows: T[], tenantId: string, workspaceId: string): Promise<T[]> {
  const { travellers } = await loadTravellers(new mongoose.Types.ObjectId(workspaceId), { includeInactive: true });
  const find = buildTravellerIndex<any>(travellers);
  return rows.map((r) => {
    if (String(r.tenantId) !== tenantId) return r;
    const profile = find(travellerOf(r));
    const home = homeCountry("WORK_COUNTRY", profile ? workLocationCountry(profile.workLocation) : null);
    return { ...r, isInternational: internationalOf(home, r) };
  });
}

/**
 * Is there anything to show? `enabled` = the Travel Policy module is on;
 * `configured` = and a version is published. For one company, or (null =
 * Plumtrips staff) across every real company.
 */
export async function complianceState(tenantId: string | null): Promise<{ enabled: boolean; configured: boolean; domesticBasis: DomesticBasis | null }> {
  if (tenantId === "") return { enabled: false, configured: false, domesticBasis: null };
  const spaces: any[] = await CustomerWorkspace.find({
    "config.features.travelPolicyEnabled": true,
    ...(tenantId === null ? { isDemo: { $ne: true } } : { customerId: tenantId }),
  })
    .select("config.policyDomesticBasis")
    .lean();
  if (!spaces.length) return { enabled: false, configured: false, domesticBasis: null };
  const published = await TravelPolicyVersion.exists({ workspaceId: { $in: spaces.map((w) => w._id) }, status: "PUBLISHED" });
  return { enabled: true, configured: !!published, domesticBasis: tenantId === null ? null : readDomesticBasis(spaces[0].config?.policyDomesticBasis) };
}

export const EXPORT_COLUMNS: { key: keyof ComplianceTrip; label: string; width: number }[] = [
  { key: "employeeId", label: "Employee ID", width: 14 },
  { key: "employee", label: "Employee", width: 24 },
  { key: "department", label: "Department", width: 20 },
  { key: "workLocation", label: "Work location", width: 24 },
  { key: "workRegion", label: "Region (work location)", width: 22 },
  { key: "destinationRegion", label: "Region (destination)", width: 20 },
  { key: "services", label: "Services", width: 16 },
  { key: "isInternational", label: "Domestic / International", width: 22 },
  { key: "sector", label: "Trip / sector", width: 34 },
  { key: "requestedOn", label: "Requested date", width: 15 },
  { key: "travelOn", label: "Travel date", width: 13 },
  { key: "requiredDays", label: "Required days", width: 14 },
  { key: "actualDays", label: "Actual days", width: 12 },
  { key: "daysShort", label: "Days short", width: 11 },
  { key: "versionNumber", label: "Policy version", width: 14 },
  { key: "amount", label: "Amount (INR)", width: 14 },
];

export function exportCell(t: ComplianceTrip, key: keyof ComplianceTrip): string | number {
  if (key === "services") return t.services.map((s) => (s.service === "HOTEL" ? "Hotel" : "Flight")).join(" + ");
  if (key === "sector") return [...new Set(t.services.map((s) => s.sector).filter(Boolean))].join("; ");
  if (key === "isInternational") return t.isInternational === null ? "Unknown" : t.isInternational ? "International" : "Domestic";
  const v = t[key];
  return typeof v === "number" ? v : String(v ?? "");
}
