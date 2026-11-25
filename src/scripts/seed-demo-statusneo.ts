// apps/backend/src/scripts/seed-demo-statusneo.ts
//
// Demo workspace "StatusNeo Demo" for the Policy Compliance dashboard (client
// demo 2026-11-27). Everything is fictional; every e-mail is on the reserved
// .example domain, so nothing can reach a real inbox.
//
//   MONGO_URI=… DEMO_PASSWORD=… tsx src/scripts/seed-demo-statusneo.ts --expect-db=<db> [--apply]
//        [--as-of=YYYY-MM-DD]   last request date (default today, IST)
//        [--reset-password]     replace the demo login's password
//        [--remove]             delete everything this script created
//
// Dry run unless --apply. Idempotent: every _id is derived from a fixed key,
// so a re-run updates the same documents, and re-dates the trips to --as-of.
//
// Never in real analytics: the trips are TravelBooking rows with isDemo: true
// and NO source booking (no ManualBooking / SBT / ApprovalRequest / Invoice is
// created, so nothing shows in ops queues, billing or booking metrics). The
// workspace is isDemo and the users are isDemoUser. The read side is
// admin.unified.billing.ts buildScopedMatch.
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import User from "../models/User.js";
import Customer from "../models/Customer.js";
import CustomerMember from "../models/CustomerMember.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Department from "../models/Department.js";
import Designation from "../models/Designation.js";
import TravellerProfile from "../models/TravellerProfile.js";
import TravelBooking from "../models/TravelBooking.js";
import TravelPolicyVersion, { type PolicyActor } from "../models/TravelPolicyVersion.js";
import { UserPermission } from "../models/UserPermission.js";
import { appendAudit, seedCitiesIfEmpty } from "../services/travelPolicy.service.js";
import { syncMembershipFromUser } from "../services/workspaceMembership.service.js";
import { addDays, isIsoDate, istToday, sanitizeDraft, validateForPublish, type Rule, type Tier } from "../services/travelPolicy/core.js";
import { TEMPLATE_CITIES, TEMPLATE_RULES } from "../data/travelPolicyTemplate.js";

const NS = "plumtrips-demo-statusneo";
const id = (key: string) => new mongoose.Types.ObjectId(crypto.createHash("sha1").update(`${NS}:${key}`).digest("hex").slice(0, 24));
const DOMAIN = "statusneo-demo.example";
export const DEMO_LOGIN = `demo@${DOMAIN}`;
export const COMPANY = "StatusNeo Demo";

export const CUSTOMER_ID = id("customer");
export const WORKSPACE_ID = id("workspace");

/* ── People ───────────────────────────────────────────────────────────── */

const DEPARTMENTS = ["Engineering", "Data & AI", "Cloud Platforms", "Sales", "Delivery", "People & Finance"];
const DESIGNATIONS: { name: string; level: number; band: number }[] = [
  { name: "Associate", level: 1, band: 2 },
  { name: "Senior Consultant", level: 2, band: 4 },
  { name: "Manager", level: 3, band: 6 },
  { name: "Director", level: 4, band: 8 },
  { name: "Vice President", level: 5, band: 9 },
];

type Base = "IN" | "US" | "SG" | "AU" | "ZA";
interface Person {
  first: string;
  last: string;
  base: Base;
  location: string;
  home: string; // city the trips start from
  dept: number;
  desig: number | null; // null = not mapped to a tier
  head?: boolean;
  /** Often asks late. */
  late?: boolean;
}
const P = (name: string, base: Base, location: string, home: string, dept: number, desig: number | null, over: Partial<Person> = {}): Person => {
  const [first, last] = name.split(" ");
  return { first, last, base, location, home, dept, desig, ...over };
};

export const PEOPLE: Person[] = [
  P("Ananya Kapoor", "IN", "Gurugram, India", "Delhi", 0, 4, { head: true }),
  P("Rohan Deshpande", "IN", "Gurugram, India", "Delhi", 1, 4, { head: true }),
  P("Meera Iyer", "IN", "Bengaluru, India", "Bengaluru", 2, 3, { head: true }),
  P("Daniel Brooks", "US", "New York, USA", "New York", 3, 4, { head: true, late: true }),
  P("Priya Nambiar", "SG", "Singapore", "Singapore", 4, 3, { head: true }),
  P("Vikram Sethi", "IN", "Gurugram, India", "Delhi", 5, 3, { head: true }),
  P("Arjun Malhotra", "IN", "Gurugram, India", "Delhi", 0, 1, { late: true }),
  P("Sneha Kulkarni", "IN", "Pune, India", "Pune", 0, 1),
  P("Karan Bhatia", "IN", "Gurugram, India", "Delhi", 3, 2, { late: true }),
  P("Divya Raghavan", "IN", "Bengaluru, India", "Bengaluru", 1, 1),
  P("Nikhil Joshi", "IN", "Pune, India", "Pune", 2, 0),
  P("Ishita Banerjee", "IN", "Bengaluru, India", "Bengaluru", 4, 2),
  P("Sameer Qureshi", "IN", "Hyderabad, India", "Hyderabad", 2, 1, { late: true }),
  P("Pooja Menon", "IN", "Bengaluru, India", "Bengaluru", 0, 0),
  P("Aditya Verma", "IN", "Gurugram, India", "Delhi", 4, 1),
  P("Kavya Reddy", "IN", "Hyderabad, India", "Hyderabad", 1, 2),
  P("Manish Tandon", "IN", "Gurugram, India", "Delhi", 5, 1),
  P("Ritika Chawla", "IN", "Gurugram, India", "Delhi", 3, 1),
  P("Yash Agarwal", "IN", "Mumbai, India", "Mumbai", 2, 0),
  P("Tanvi Shinde", "IN", "Mumbai, India", "Mumbai", 4, null),
  P("Emily Carter", "US", "New York, USA", "New York", 0, 2),
  P("Marcus Reid", "US", "San Francisco, USA", "New York", 1, 1, { late: true }),
  P("Olivia Grant", "US", "Austin, USA", "New York", 2, 2),
  P("Jason Miller", "US", "Chicago, USA", "New York", 3, 1),
  P("Sophia Nguyen", "US", "San Francisco, USA", "New York", 4, 1),
  P("Ethan Walker", "US", "Austin, USA", "New York", 0, 3),
  P("Grace Coleman", "US", "Chicago, USA", "New York", 5, null),
  P("Wei Lim", "SG", "Singapore", "Singapore", 1, 1),
  P("Hui Tan", "SG", "Singapore", "Singapore", 3, 2, { late: true }),
  P("Farah Ismail", "SG", "Singapore", "Singapore", 2, 1),
  P("Kenneth Goh", "SG", "Singapore", "Singapore", 0, 0),
  P("Liam Harris", "AU", "Sydney, Australia", "Sydney", 3, 2, { late: true }),
  P("Chloe Bennett", "AU", "Sydney, Australia", "Sydney", 1, 1),
  P("Jack Thompson", "AU", "Melbourne, Australia", "Melbourne", 4, 1),
  P("Ruby Edwards", "AU", "Melbourne, Australia", "Melbourne", 0, 0),
  P("Noah Wilson", "AU", "Sydney, Australia", "Sydney", 2, 3),
  P("Thabo Mokoena", "ZA", "Johannesburg, South Africa", "Johannesburg", 3, 2, { late: true }),
  P("Lerato Dlamini", "ZA", "Johannesburg, South Africa", "Johannesburg", 4, 1),
  P("Pieter Botha", "ZA", "Cape Town, South Africa", "Johannesburg", 2, 1),
  P("Naledi Khumalo", "ZA", "Cape Town, South Africa", "Johannesburg", 0, 1),
];

const emailOf = (p: Person) => `${p.first}.${p.last}@${DOMAIN}`.toLowerCase();

/* ── Policy ───────────────────────────────────────────────────────────── */

const TIERS: Tier[] = [
  { tierKey: "leadership", name: "Leadership", code: "LDR", description: "Directors and above", sortOrder: 0, active: true, designationIds: [], bandNumbers: [8, 9] },
  { tierKey: "standard", name: "Standard", code: "STD", description: "Everyone else", sortOrder: 1, active: true, designationIds: [], bandNumbers: [2, 4, 6] },
];
/** Minimum days between the request and travel. */
export const ADVANCE: Record<string, { domestic: number; international: number }> = {
  leadership: { domestic: 7, international: 14 },
  standard: { domestic: 10, international: 10 },
};

function policyRules(): Rule[] {
  const out: Rule[] = [];
  for (const t of TIERS) {
    const from = t.tierKey === "leadership" ? "senior" : "mid";
    const adv = ADVANCE[t.tierKey];
    for (const r of TEMPLATE_RULES.filter((x) => x.tierKey === from)) {
      const params: any = { ...r.params };
      if (r.category === "FLIGHT") {
        params.minAdvanceDaysDomestic = adv.domestic;
        params.minAdvanceDaysInternational = adv.international;
      }
      if (r.category === "HOTEL") params.minAdvanceDays = r.scope.value === "INTERNATIONAL" ? adv.international : adv.domestic;
      out.push({ ...r, ruleKey: r.ruleKey.replace(from, t.tierKey), tierKey: t.tierKey, params });
    }
  }
  return out;
}

/* ── Trips ────────────────────────────────────────────────────────────── */

const COUNTRY: Record<string, string> = {
  Delhi: "IN", Bengaluru: "IN", Mumbai: "IN", Pune: "IN", Hyderabad: "IN", Chennai: "IN", London: "GB", Frankfurt: "DE", Singapore: "SG", Dubai: "AE",
  Sydney: "AU", Melbourne: "AU", Brisbane: "AU", "San Francisco": "US", Chicago: "US", "Cape Town": "ZA", Tokyo: "JP", "Hong Kong": "HK", "New York": "US", Johannesburg: "ZA", Nairobi: "KE", Bangkok: "TH",
};
// Domestic = within the traveller's work country (the demo workspace's setting).
const AT_HOME: Record<Base, string[]> = {
  IN: ["Delhi", "Bengaluru", "Mumbai", "Pune", "Hyderabad", "Chennai"], US: ["New York", "San Francisco", "Chicago"], SG: [], AU: ["Sydney", "Melbourne", "Brisbane"],
  ZA: ["Johannesburg", "Cape Town"],
};
const ABROAD_SHARE: Record<Base, number> = { IN: 0.32, US: 0.6, SG: 1, AU: 0.6, ZA: 0.6 };
const ABROAD: Record<Base, string[]> = {
  IN: ["London", "Singapore", "Dubai", "New York", "Frankfurt", "Sydney"],
  US: ["London", "Bengaluru", "Delhi", "Singapore", "Frankfurt"],
  SG: ["Bengaluru", "Sydney", "Tokyo", "Hong Kong", "Mumbai", "Bangkok"],
  AU: ["Singapore", "Bengaluru", "London", "Tokyo"],
  ZA: ["London", "Dubai", "Mumbai", "Nairobi"],
};
const AIRLINES: Record<Base, string[]> = {
  IN: ["Air India", "IndiGo", "Vistara", "Emirates"], US: ["United Airlines", "Air India", "British Airways"],
  SG: ["Singapore Airlines", "Scoot"], AU: ["Qantas", "Singapore Airlines"], ZA: ["Emirates", "South African Airways"],
};
const HOTELS = ["Courtyard", "Novotel", "Hyatt Regency", "Radisson Blu", "Hilton Garden Inn", "ibis"];
export const TRIPS = 150; // CONFIRMED: a flight each, some with a hotel
const OTHER_ROWS = 10; // pending / cancelled, for a realistic status mix

/** Deterministic PRNG: the same key always gives the same trips. */
function rng(seed: string) {
  let a = parseInt(crypto.createHash("sha1").update(`${NS}:${seed}`).digest("hex").slice(0, 8), 16);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The TravelBooking rows, request dates within the 90 days up to `asOf`. */
export function buildTrips(asOf: string, ownerId: mongoose.Types.ObjectId) {
  const rand = rng("trips");
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const day = (d: string) => new Date(`${d}T00:00:00Z`);
  const rows: any[] = [];
  // Late askers travel more, so they stand out as frequent violators.
  const deck = PEOPLE.flatMap((p) => (p.late ? [p, p, p] : [p]));

  // Nobody is in two places at once, so no two trips of one person overlap.
  const away = new Map<string, [string, string][]>();
  const isFree = (p: Person, from: string, to: string) => !(away.get(emailOf(p)) ?? []).some(([a, b]) => a <= to && from <= b);

  const push = (p: Person, service: "FLIGHT" | "HOTEL", status: string, t: any) => {
    const n = rows.length + 1;
    const ref = `DEMO-SN-${String(n).padStart(4, "0")}`;
    const intl = service === "HOTEL" ? COUNTRY[t.to] !== "IN" : COUNTRY[t.to] !== "IN" || COUNTRY[p.home] !== "IN";
    const base = {
      _id: id(`trip:${n}`), workspaceId: WORKSPACE_ID, tenantId: String(CUSTOMER_ID), userId: ownerId, service, status, paymentMode: "OFFICIAL", source: "CONCIERGE",
      origin: service === "FLIGHT" ? p.home : "", destination: t.to, destinationCity: t.to, destinationCountry: COUNTRY[t.to], isInternational: intl,
      travellerName: `${p.first} ${p.last}`, travellerEmail: emailOf(p), bookedAt: day(t.request), travelDate: day(t.travel), travelDateEnd: day(addDays(t.travel, t.nights)),
      isDemo: true, createdByDemoUser: true, isTest: false, isActive: true,
    };
    const meta = { bookingRef: ref, travellerProfileId: String(id(`profile:${emailOf(p)}`)), demoSeed: NS };
    if (service === "FLIGHT") {
      const airline = pick(AIRLINES[p.base]);
      const mins = int(5 * 60, 22 * 60);
      const lead = (p.desig ?? 0) >= 3;
      rows.push({
        ...base,
        amount: Math.round((intl && COUNTRY[t.to] !== COUNTRY[p.home] ? int(38000, 92000) : COUNTRY[p.home] === "IN" ? int(4800, 11500) : int(14000, 31000)) * (lead && intl ? 1.4 : 1)),
        metadata: {
          ...meta, manualType: "FLIGHT", airline, originCity: p.home, carrierShares: [{ name: airline, share: 1 }],
          departMinutesIST: mins, departTimeIST: `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`,
          departTimeUnknown: false, departTimeSource: "booking", cabinClass: lead && intl ? "Premium Economy" : "Economy", cabinClassSource: "booking",
        },
      });
    } else {
      rows.push({
        ...base,
        amount: t.nights * (intl ? int(9000, 16500) : int(4200, 7800)),
        metadata: { ...meta, manualType: "HOTEL", hotelName: `${pick(HOTELS)} ${t.to}`, nights: t.nights, rooms: 1 },
      });
    }
  };

  // Each pass over the deck is shuffled, so every region has trips in every month.
  let queue: Person[] = [];
  let made = 0;
  while (made < TRIPS + OTHER_ROWS) {
    if (!queue.length) queue = deck.map((p) => [rand(), p] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const p = queue.pop()!;
    const abroad = rand() < ABROAD_SHARE[p.base];
    const to = pick(abroad ? ABROAD[p.base] : AT_HOME[p.base].filter((c) => c !== p.home));
    const adv = ADVANCE[(p.desig ?? 0) >= 3 ? "leadership" : "standard"];
    const need = abroad ? adv.international : adv.domestic;
    const lead = rand() < (p.late ? 0.62 : 0.14) ? int(1, need - 1) : need + int(0, 18);
    const request = addDays(asOf, -Math.floor(90 * rand() ** 1.5)); // 90 days, weighted to recent weeks
    const trip = { to, request, travel: addDays(request, lead), nights: abroad ? int(3, 6) : int(1, 3) };
    const back = addDays(trip.travel, trip.nights);
    if (!isFree(p, trip.travel, back)) continue;
    away.set(emailOf(p), [...(away.get(emailOf(p)) ?? []), [trip.travel, back]]);
    const status = made < TRIPS ? "CONFIRMED" : pick(["PENDING", "PENDING", "CANCELLED"]);
    push(p, "FLIGHT", status, trip);
    if (made < TRIPS && rand() < 0.45) push(p, "HOTEL", status, trip);
    made++;
  }
  return rows;
}

/* ── Seed ─────────────────────────────────────────────────────────────── */

export interface SeedOptions {
  apply: boolean;
  asOf: string;
  password: string;
  resetPassword?: boolean;
  log?: (s: string) => void;
}

const everything = () => ({
  customer: { _id: CUSTOMER_ID },
  workspace: { _id: WORKSPACE_ID },
  inWorkspace: { workspaceId: WORKSPACE_ID },
  users: { _id: { $in: [id("user:demo"), ...PEOPLE.filter((p) => p.head).map((p) => id(`user:${emailOf(p)}`))] } },
});

/** Refuse if a company or login with our names exists but is not ours. */
async function assertNotSomeoneElses() {
  const other: any = await Customer.findOne({ name: COMPANY, _id: { $ne: CUSTOMER_ID } }).select("_id").lean();
  if (other) throw new Error(`REFUSING: another customer is already called "${COMPANY}" (${other._id}).`);
  const ids = everything().users._id.$in;
  const u: any = await User.findOne({ email: new RegExp(`@${DOMAIN.replace(/\./g, "\\.")}$`), _id: { $nin: ids } }).select("email").lean();
  if (u) throw new Error(`REFUSING: ${u.email} exists and was not created by this script.`);
  const code: any = await Customer.findOne({ customerCode: "DEMO-STATUSNEO", _id: { $ne: CUSTOMER_ID } }).select("_id").lean();
  if (code) throw new Error(`REFUSING: customer ${code._id} already uses the code DEMO-STATUSNEO.`);
  const ws: any = await CustomerWorkspace.findOne({ $or: [{ slug: "statusneo-demo" }, { customerId: String(CUSTOMER_ID) }], _id: { $ne: WORKSPACE_ID } }).select("_id").lean();
  if (ws) throw new Error(`REFUSING: workspace ${ws._id} already uses the slug statusneo-demo.`);
  for (const [name, _id] of [["customers", CUSTOMER_ID], ["customerworkspaces", WORKSPACE_ID]] as const) {
    const d: any = await mongoose.connection.collection(name).findOne({ _id });
    if (d && ![d.name, d.companyName].includes(COMPANY)) throw new Error(`REFUSING: ${name} ${_id} is not the demo's.`);
  }
}

export async function seedStatusNeoDemo(opts: SeedOptions) {
  const log = opts.log ?? ((s: string) => console.log(s));
  if (!isIsoDate(opts.asOf)) throw new Error(`--as-of must be YYYY-MM-DD (got "${opts.asOf}")`);
  await assertNotSomeoneElses();

  const draft = sanitizeDraft({ name: "StatusNeo travel policy", changeSummary: "First version", effectiveFrom: null, tiers: TIERS, rules: policyRules() });
  const problems = validateForPublish(draft, new Set());
  if (problems.length) throw new Error(`Demo policy is not publishable: ${problems.join("; ")}`);

  const owner = id("user:demo");
  const trips = buildTrips(opts.asOf, owner);
  const heads = PEOPLE.filter((p) => p.head);
  log(`${COMPANY}: ${PEOPLE.length} travellers, ${DEPARTMENTS.length} departments with heads, ${TRIPS} confirmed trips (${trips.length} booking rows in all), requests ${opts.asOf} and the 89 days before`);
  if (!opts.apply) {
    const c = (n: string, f: any) => mongoose.connection.collection(n).countDocuments(f);
    const e = everything();
    const plan: [string, number, number, string][] = [
      ["customers", 1, await c("customers", e.customer), `${COMPANY} (code DEMO-STATUSNEO)`],
      ["customerworkspaces", 1, await c("customerworkspaces", e.workspace), "isDemo, Travel Policy on, domestic = work country"],
      ["users", 1 + heads.length, await c("users", e.users), `${DEMO_LOGIN} + ${heads.length} department heads (login disabled)`],
      ["customermembers", 1 + heads.length, await c("customermembers", { customerId: String(CUSTOMER_ID) }), "1 workspace leader, the heads as approvers"],
      ["workspacememberships", 1 + heads.length, await c("workspacememberships", e.inWorkspace), ""],
      [UserPermission.collection.name, 1, await c(UserPermission.collection.name, { email: DEMO_LOGIN }), "demo login only"],
      ["departments", DEPARTMENTS.length, await c("departments", e.inWorkspace), DEPARTMENTS.join(", ")],
      ["designations", DESIGNATIONS.length, await c("designations", e.inWorkspace), DESIGNATIONS.map((d) => d.name).join(", ")],
      ["travellerprofiles", PEOPLE.length, await c("travellerprofiles", e.inWorkspace), "India, US, Singapore, Australia, South Africa"],
      ["travelpolicyversions", 1, await c("travelpolicyversions", e.inWorkspace), "v1: Standard 10/10, Leadership 7/14 days"],
      ["travelpolicycities", TEMPLATE_CITIES.length, await c("travelpolicycities", e.inWorkspace), "the Plumtrips city list"],
      ["travelpolicyaudits", 2, await c("travelpolicyaudits", e.inWorkspace), "city list, v1 published"],
      ["travelbookings", trips.length, await c("travelbookings", e.inWorkspace), `isDemo, no source booking: ${TRIPS} confirmed trips + ${OTHER_ROWS} pending / cancelled`],
    ];
    for (const [name, n, have, note] of plan) log(`  ${name.padEnd(22)} ${String(n).padStart(4)} to write, ${have} there now${note ? `   ${note}` : ""}`);
    log("DRY RUN: nothing written. Add --apply to write.");
    return { trips: trips.length, travellers: PEOPLE.length, created: false };
  }
  const existing: any = await User.findById(owner).select("_id").lean();
  if ((!existing || opts.resetPassword) && opts.password.length < 12) throw new Error("DEMO_PASSWORD (12+ characters) is required.");

  const up = { upsert: true } as const;
  await Customer.updateOne(
    { _id: CUSTOMER_ID },
    { $set: { name: COMPANY, legalName: `${COMPANY} (demo data)`, customerCode: "DEMO-STATUSNEO", type: "CUSTOMER", status: "ACTIVE", email: DEMO_LOGIN, description: "Demo workspace. Fictional data." } },
    up,
  );
  await CustomerWorkspace.updateOne(
    { _id: WORKSPACE_ID },
    {
      $set: {
        customerId: String(CUSTOMER_ID), companyName: COMPANY, slug: "statusneo-demo", isDemo: true, status: "ACTIVE", travelMode: "APPROVAL_FLOW", industry: "Technology",
        onboardingStep: "complete", plan: "enterprise", accessMode: "INVITE_ONLY",
        "config.travelFlow": "APPROVAL_FLOW", "config.features.travelPolicyEnabled": true, "config.features.analyticsEnabled": true, "config.features.approvalFlowEnabled": true,
        "config.features.sbtEnabled": false, "config.policyDomesticBasis": "WORK_COUNTRY",
      },
    },
    { ...up, setDefaultsOnInsert: true },
  );

  const userFields = (first: string, last: string, email: string, role: string) => ({
    email, officialEmail: email, firstName: first, lastName: last, name: `${first} ${last}`, roles: ["CUSTOMER", role], customerId: String(CUSTOMER_ID),
    businessId: String(CUSTOMER_ID), workspaceId: WORKSPACE_ID, accountType: "CUSTOMER", userType: "CUSTOMER", hrmsAccessRole: "EMPLOYEE", hrmsAccessLevel: "EMPLOYEE",
    status: "ACTIVE", sbtEnabled: false, canRaiseRequest: true, isDemoUser: true,
  });
  const setPassword = !existing || opts.resetPassword;
  await User.updateOne(
    { _id: owner },
    { $set: { ...userFields("Demo", "Admin", DEMO_LOGIN, "WORKSPACE_LEADER"), ...(setPassword ? { passwordHash: await bcrypt.hash(opts.password, 12) } : {}) } },
    { ...up, setDefaultsOnInsert: true },
  );
  for (const p of heads) {
    // Department heads are shown, never signed in as: random password, login disabled.
    await User.updateOne(
      { _id: id(`user:${emailOf(p)}`) },
      {
        $set: { ...userFields(p.first, p.last, emailOf(p), "APPROVER"), loginDisabled: true, loginDisabledReason: "Demo data" },
        $setOnInsert: { passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10) },
      },
      { ...up, setDefaultsOnInsert: true },
    );
  }
  const members = [{ key: "demo", email: DEMO_LOGIN, name: "Demo Admin", role: "WORKSPACE_LEADER" }, ...heads.map((p) => ({ key: emailOf(p), email: emailOf(p), name: `${p.first} ${p.last}`, role: "APPROVER" }))];
  for (const m of members) {
    await CustomerMember.updateOne({ _id: id(`member:${m.key}`) }, { $set: { customerId: String(CUSTOMER_ID), email: m.email, name: m.name, role: m.role, isActive: true } }, { ...up, setDefaultsOnInsert: true });
    await syncMembershipFromUser(id(`user:${m.key}`), { source: "demo-seed" });
  }
  await UserPermission.updateOne(
    { email: DEMO_LOGIN },
    {
      $setOnInsert: {
        userId: String(owner), email: DEMO_LOGIN, workspaceId: String(WORKSPACE_ID), universe: "CUSTOMER",
        level: { code: "CUSTOMER_LEADER", name: "Workspace Leader", designation: "Admin" }, status: "active", tier: 2, roleType: "CLIENT",
        grantedModules: ["profile", "myBookings", "myInvoices", "approvals", "travelSpend", "users"],
        modules: {
          profile: { access: "WRITE", scope: "OWN" }, myBookings: { access: "READ", scope: "WORKSPACE" }, myInvoices: { access: "READ", scope: "WORKSPACE" },
          approvals: { access: "READ", scope: "WORKSPACE" }, travelSpend: { access: "READ", scope: "WORKSPACE" }, users: { access: "READ", scope: "WORKSPACE" },
        },
        source: "demo-seed", grantedBy: "system", grantedAt: new Date(),
      },
    },
    up,
  );

  for (const [i, name] of DEPARTMENTS.entries()) {
    const head = heads.find((p) => p.dept === i)!;
    await Department.updateOne({ _id: id(`dept:${name}`) }, { $set: { workspaceId: WORKSPACE_ID, name, managerId: id(`user:${emailOf(head)}`), isActive: true, createdBy: owner } }, up);
  }
  for (const d of DESIGNATIONS) {
    await Designation.updateOne({ _id: id(`desig:${d.name}`) }, { $set: { workspaceId: WORKSPACE_ID, name: d.name, level: d.level, isActive: true, createdBy: owner } }, up);
  }
  for (const [i, p] of PEOPLE.entries()) {
    const d = p.desig === null ? null : DESIGNATIONS[p.desig];
    const head = heads.find((h) => h.dept === p.dept)!;
    await TravellerProfile.updateOne(
      { _id: id(`profile:${emailOf(p)}`) },
      {
        $set: {
          workspaceId: WORKSPACE_ID, travelerId: `SND-${String(i + 1).padStart(3, "0")}`, employeeId: `SN${1001 + i}`, firstName: p.first, lastName: p.last, email: emailOf(p),
          departmentId: id(`dept:${DEPARTMENTS[p.dept]}`), designationId: d ? id(`desig:${d.name}`) : null, bandNumber: d ? d.band : null, workLocation: p.location,
          reportingManagerId: id(`user:${emailOf(head)}`), isActive: true, source: "BULK_IMPORT", createdBy: owner,
          ...(p.head ? { claimedBy: id(`user:${emailOf(p)}`) } : {}),
        },
      },
      { ...up, setDefaultsOnInsert: true },
    );
  }

  // The policy: published once, then frozen like any other. Back-dated (the
  // publish screen never allows that) so it covers every seeded trip.
  const actor: PolicyActor = { id: String(owner), name: "Demo seed", email: DEMO_LOGIN, kind: "PLUMTRIPS_STAFF", roles: [] };
  await seedCitiesIfEmpty(WORKSPACE_ID, actor);
  if (!(await TravelPolicyVersion.exists({ workspaceId: WORKSPACE_ID, status: "PUBLISHED" }))) {
    const effectiveFrom = `${addDays(opts.asOf, -150).slice(0, 7)}-01`;
    const [v] = await TravelPolicyVersion.create([
      {
        _id: id("policy:v1"), workspaceId: WORKSPACE_ID, ...draft, status: "PUBLISHED", versionNumber: 1, effectiveFrom, effectiveTo: null, source: { kind: "BLANK" },
        createdBy: actor, updatedBy: actor, publishedBy: actor, publishedAt: new Date(),
      },
    ]);
    await appendAudit({ workspaceId: WORKSPACE_ID, action: "VERSION_PUBLISHED", entity: "VERSION", version: v as any, categories: ["VERSION"], summary: `v1 published for the demo, effective ${effectiveFrom}`, actor });
  }

  await TravelBooking.deleteMany({ workspaceId: WORKSPACE_ID, "metadata.demoSeed": NS, _id: { $nin: trips.map((t) => t._id) } });
  await TravelBooking.bulkWrite(trips.map((t) => ({ replaceOne: { filter: { _id: t._id }, replacement: t, upsert: true } })) as any);

  log(`Done. Login ${DEMO_LOGIN}${setPassword ? " (password from DEMO_PASSWORD)" : " (password unchanged)"}`);
  return { trips: trips.length, travellers: PEOPLE.length, created: true };
}

/** Delete everything the seed created (and the rows its users made inside the demo workspace's policy module). */
export async function removeStatusNeoDemo(apply: boolean, log: (s: string) => void = console.log) {
  const e = everything();
  const c = (n: string) => mongoose.connection.collection(n);
  const targets: [string, any][] = [
    ["travelbookings", { ...e.inWorkspace, isDemo: true }], ["travellerprofiles", e.inWorkspace], ["departments", e.inWorkspace], ["designations", e.inWorkspace],
    ["travelpolicyversions", e.inWorkspace], ["travelpolicycities", e.inWorkspace], ["travelpolicytierassignments", e.inWorkspace], ["travelpolicyaudits", e.inWorkspace],
    ["userpreferences", { userId: e.users._id }], ["workspacememberships", e.inWorkspace], ["customermembers", { customerId: String(CUSTOMER_ID) }], [UserPermission.collection.name, { email: DEMO_LOGIN }],
    ["users", e.users], ["customerworkspaces", e.workspace], ["customers", e.customer],
  ];
  for (const [name, filter] of targets) {
    const n = apply ? (await c(name).deleteMany(filter)).deletedCount : await c(name).countDocuments(filter);
    log(`${apply ? "deleted" : "would delete"} ${n} ${name}`);
  }
}

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  console.log(`target host ${uri.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, "").split("/")[0]}`);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const db = mongoose.connection.name;
    if (arg("expect-db") !== db) throw new Error(`REFUSING: --expect-db="${arg("expect-db") ?? ""}" but the connected db is "${db}".`);
    console.log(`db ${db} · ${apply ? "APPLY" : "DRY RUN"}`);
    if (process.argv.includes("--remove")) await removeStatusNeoDemo(apply);
    else await seedStatusNeoDemo({ apply, asOf: arg("as-of") || istToday(), password: process.env.DEMO_PASSWORD || "", resetPassword: process.argv.includes("--reset-password") });
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && /seed-demo-statusneo\.(ts|js)$/.test(process.argv[1])) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err?.message || err); process.exit(1); });
}
