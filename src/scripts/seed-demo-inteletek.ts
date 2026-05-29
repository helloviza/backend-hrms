/**
 * Seed Inteletek AI demo workspace.
 * Idempotent: upserts by email (users) and by deterministic ref (bookings).
 * Run: pnpm -C apps/backend tsx src/scripts/seed-demo-inteletek.ts
 *
 * Seeds:
 *  - CustomerWorkspace.isDemo=true on Inteletek (_id 69cc5ac44fae691064b1997a)
 *  - 4 demo users: admin2@inteletekai.com (new), demouser1@inteletekai.com
 *    (existing, UserPermission upsert only), demouser2@inteletekai.com (new),
 *    demouser3@inteletekai.com (new). All isDemoUser=true.
 *  - UserPermission for all 4 demo users (mirroring masterData.ts:1736-1760)
 *  - 26 ManualBookings spanning ~180 days with realistic status mix
 *  - 10 Invoices (2 DRAFT, 4 SENT, 4 PAID) bundling 1-3 bookings each
 *  - Wallet: monthlyLimit=500000, currentMonthSpend=120000
 *  - Grants demoAccess.enabled=true on imran.ali@plumtrips.com with
 *    mappedSeedUsers=[all 4 demo user _ids]
 *
 * Does NOT touch admin@inteletekai.com (broken legacy — Sprint 1 422 guard handles)
 * Does NOT touch HOUSE workspace
 */

import mongoose from "mongoose";
import bcrypt from "bcryptjs";

import { connectDb } from "../config/db.js";
import User from "../models/User.js";
import { UserPermission } from "../models/UserPermission.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import ManualBooking from "../models/ManualBooking.js";
import Invoice from "../models/Invoice.js";

const INTELETEK_CUSTOMER_ID = "69cc496b20f2a4a00c4bf4b3";
const INTELETEK_WORKSPACE_ID = "69cc5ac44fae691064b1997a";
const REP_EMAIL = "imran.ali@plumtrips.com";

const WORKSPACE_OID = new mongoose.Types.ObjectId(INTELETEK_WORKSPACE_ID);

// ────────────────────────────────────────────────────────────────────────────
// Deterministic helpers (no Math.random — same input → same output across runs)
// ────────────────────────────────────────────────────────────────────────────

// A tiny xorshift-style integer PRNG seeded from a string. Used to derive
// deterministic "random-looking" numbers without relying on Math.random.
function strHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function pickInRange(seed: string, min: number, max: number): number {
  const r = strHash(seed) % (max - min + 1);
  return min + r;
}
function pickFromList<T>(seed: string, list: T[]): T {
  return list[strHash(seed) % list.length];
}
function hexN(seed: string, n: number): string {
  // Deterministic hex string from seed
  let h = strHash(seed).toString(16).toUpperCase().padStart(8, "0");
  while (h.length < n) h += strHash(h).toString(16).toUpperCase().padStart(8, "0");
  return h.slice(0, n);
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}

// ────────────────────────────────────────────────────────────────────────────
// STAGE 1 — Workspace flag + wallet
// ────────────────────────────────────────────────────────────────────────────

async function stageWorkspace(): Promise<void> {
  const lastResetMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  const result = await CustomerWorkspace.updateOne(
    { _id: WORKSPACE_OID },
    {
      $set: {
        isDemo: true,
        "sbtOfficialBooking.enabled": true,
        "sbtOfficialBooking.monthlyLimit": 500000,
        "sbtOfficialBooking.currentMonthSpend": 120000,
        "sbtOfficialBooking.lastResetMonth": lastResetMonth,
      },
    },
  );
  console.log(
    `  ✓ CustomerWorkspace.isDemo=true, wallet configured (500000 / 120000 used) ` +
      `(matched=${result.matchedCount}, modified=${result.modifiedCount})`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// STAGE 2 — Demo users
// ────────────────────────────────────────────────────────────────────────────

type DemoUserSpec = {
  email: string;
  firstName: string;
  lastName: string;
  isAdmin: boolean; // WORKSPACE_LEADER vs REQUESTER
};

const DEMO_USERS: DemoUserSpec[] = [
  { email: "admin2@inteletekai.com",     firstName: "Rajesh", lastName: "Kumar", isAdmin: true  },
  { email: "demouser1@inteletekai.com",  firstName: "John",   lastName: "Doe",   isAdmin: false }, // pre-existing
  { email: "demouser2@inteletekai.com",  firstName: "Priya",  lastName: "Iyer",  isAdmin: false },
  { email: "demouser3@inteletekai.com",  firstName: "Rohan",  lastName: "Mehta", isAdmin: false },
];

async function upsertDemoUser(spec: DemoUserSpec): Promise<{ user: any; created: boolean; flaggedExisting: boolean }> {
  const emailLower = spec.email.toLowerCase();
  const existing: any = await User.findOne({ email: emailLower });
  if (existing) {
    let flagged = false;
    if (!existing.isDemoUser) {
      await User.updateOne({ _id: existing._id }, { $set: { isDemoUser: true } });
      flagged = true;
    }
    return { user: existing, created: false, flaggedExisting: flagged };
  }

  const passwordHash = await bcrypt.hash("DemoUser@2026", 12);
  const created = await User.create({
    email: emailLower,
    officialEmail: emailLower,
    personalEmail: emailLower,
    firstName: spec.firstName,
    lastName: spec.lastName,
    name: `${spec.firstName} ${spec.lastName}`.trim(),
    roles: spec.isAdmin ? ["CUSTOMER", "WORKSPACE_LEADER"] : ["CUSTOMER", "REQUESTER"],
    passwordHash,
    customerId: INTELETEK_CUSTOMER_ID,
    businessId: INTELETEK_CUSTOMER_ID,
    workspaceId: WORKSPACE_OID,
    accountType: "CUSTOMER",
    userType: "CUSTOMER",
    hrmsAccessRole: "EMPLOYEE",
    hrmsAccessLevel: "EMPLOYEE",
    status: "ACTIVE",
    sbtEnabled: true,
    sbtBookingType: "both",
    sbtRole: spec.isAdmin ? "L2" : "L1",
    canRaiseRequest: true,
    isDemoUser: true,
  });
  return { user: created, created: true, flaggedExisting: false };
}

async function stageUsers(): Promise<{ users: any[]; createdCount: number; existingFlaggedCount: number }> {
  const users: any[] = [];
  let createdCount = 0;
  let existingFlaggedCount = 0;
  for (const spec of DEMO_USERS) {
    const r = await upsertDemoUser(spec);
    users.push(r.user);
    if (r.created) {
      createdCount++;
      console.log(`  ✓ Created user: ${spec.email} (${r.user._id})`);
    } else if (r.flaggedExisting) {
      existingFlaggedCount++;
      console.log(`  ✓ Flagged existing user isDemoUser=true: ${spec.email}`);
    } else {
      console.log(`  ⏭️  User already isDemoUser=true: ${spec.email}`);
    }
  }
  return { users, createdCount, existingFlaggedCount };
}

// ────────────────────────────────────────────────────────────────────────────
// STAGE 3 — UserPermission rows (mirrors masterData.ts:1736-1760 exactly)
// ────────────────────────────────────────────────────────────────────────────

async function upsertDemoUserPermission(user: any, isAdmin: boolean): Promise<{ created: boolean }> {
  const emailLower = user.email.toLowerCase();
  const before = await UserPermission.findOne({ email: emailLower }).lean();
  await UserPermission.findOneAndUpdate(
    { email: emailLower },
    {
      $setOnInsert: {
        userId:      String(user._id),
        email:       emailLower,
        workspaceId: INTELETEK_WORKSPACE_ID, // stored as string per existing convention
        universe:    "CUSTOMER" as const,
        level: isAdmin
          ? { code: "CUSTOMER_LEADER",   name: "Workspace Leader", designation: "Admin" }
          : { code: "CUSTOMER_APPROVAL", name: "Business Client",  designation: "Requestor" },
        status:   "active",
        tier:     isAdmin ? 2 : 1,
        roleType: "CLIENT",
        grantedModules: isAdmin
          ? ["profile", "myBookings", "myInvoices", "sbtSearch", "sbtRequest", "approvals", "travelSpend", "users"]
          : ["profile", "myBookings", "myInvoices", "sbtSearch", "sbtRequest", "travelSpend"],
        modules: isAdmin
          ? {
              profile:     { access: "WRITE", scope: "OWN" },
              myBookings:  { access: "FULL",  scope: "WORKSPACE" },
              myInvoices:  { access: "FULL",  scope: "WORKSPACE" },
              sbtSearch:   { access: "FULL",  scope: "WORKSPACE" },
              sbtRequest:  { access: "FULL",  scope: "WORKSPACE" },
              approvals:   { access: "FULL",  scope: "WORKSPACE" },
              travelSpend: { access: "READ",  scope: "WORKSPACE" },
              users:       { access: "WRITE", scope: "WORKSPACE" },
            }
          : {
              profile:     { access: "WRITE", scope: "OWN" },
              myBookings:  { access: "READ",  scope: "OWN" },
              myInvoices:  { access: "READ",  scope: "OWN" },
              sbtSearch:   { access: "WRITE", scope: "OWN" },
              sbtRequest:  { access: "WRITE", scope: "OWN" },
              travelSpend: { access: "READ",  scope: "OWN" },
            },
        source:    "demo-seed",
        grantedBy: "system",
        grantedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );
  return { created: !before };
}

async function stagePermissions(users: any[]): Promise<{ created: number; existed: number }> {
  let created = 0;
  let existed = 0;
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const spec = DEMO_USERS[i];
    const r = await upsertDemoUserPermission(u, spec.isAdmin);
    if (r.created) {
      created++;
      console.log(`  ✓ Created UserPermission: ${u.email}`);
    } else {
      existed++;
      console.log(`  ⏭️  UserPermission already exists: ${u.email}`);
    }
  }
  return { created, existed };
}

// ────────────────────────────────────────────────────────────────────────────
// STAGE 4 — ManualBookings (26 total, deterministic refs)
// ────────────────────────────────────────────────────────────────────────────

type BookingType = "FLIGHT" | "HOTEL" | "VISA";
type BookingStatus = "PENDING" | "CONFIRMED" | "INVOICED";

type BookingSpec = {
  index: number;          // 1..26
  type: BookingType;
  status: BookingStatus;
  bookingDate: Date;
};

const SECTORS_FLIGHT = ["BLR-DEL", "DEL-BOM", "BLR-BOM", "DEL-HYD", "BOM-MAA", "DEL-DXB", "BOM-SIN"];
const SECTORS_FLIGHT_INTL = new Set(["DEL-DXB", "BOM-SIN"]);
const HOTELS = [
  { city: "Bengaluru",  name: "Taj MG Road",            sector: "Bengaluru" },
  { city: "Mumbai",     name: "ITC Grand Central",      sector: "Mumbai" },
  { city: "New Delhi",  name: "The Oberoi New Delhi",   sector: "New Delhi" },
  { city: "Hyderabad",  name: "Park Hyatt Hyderabad",   sector: "Hyderabad" },
  { city: "Chennai",    name: "ITC Grand Chola",        sector: "Chennai" },
];
const VISA_DESTS = [
  { destination: "United Kingdom", description: "Schengen + UK business visa" },
  { destination: "Singapore",      description: "Singapore work visa renewal" },
];
const AIRLINES = ["IndiGo", "Air India", "Vistara", "SpiceJet"];
const PASSENGER_NAMES = ["Aarav Kapoor", "Priya Iyer", "Rohan Mehta", "Saanvi Reddy", "Vikram Singh", "Anaya Bhatia"];

function makeBookingSpecs(): BookingSpec[] {
  const specs: BookingSpec[] = [];
  // Type sequence to hit 17 FLIGHT, 7 HOTEL, 2 VISA across 26 bookings.
  // Deterministic interleave to spread types across windows.
  const typeSeq: BookingType[] = [
    "FLIGHT", "FLIGHT", "HOTEL", "FLIGHT",   // 1-4
    "FLIGHT", "HOTEL",  "FLIGHT", "FLIGHT",  // 5-8
    "VISA",   "FLIGHT", "HOTEL", "FLIGHT",   // 9-12
    "FLIGHT", "FLIGHT", "HOTEL", "FLIGHT",   // 13-16
    "FLIGHT", "HOTEL",  "FLIGHT", "FLIGHT",  // 17-20
    "HOTEL",  "FLIGHT", "VISA",   "HOTEL",   // 21-24
    "FLIGHT", "FLIGHT",                      // 25-26
  ];

  // Verify type counts at spec build time (silent unless drift).
  const counts: Record<BookingType, number> = { FLIGHT: 0, HOTEL: 0, VISA: 0 };
  typeSeq.forEach((t) => counts[t]++);
  if (counts.FLIGHT !== 17 || counts.HOTEL !== 7 || counts.VISA !== 2) {
    throw new Error(`[seed-demo] type distribution drift: ${JSON.stringify(counts)}`);
  }

  // Window distribution (status + date spread):
  //  4×INVOICED in 180→150d, 150→120d, 120→90d, 90→60d
  //  5 in 60→30d: 3 INVOICED, 2 CONFIRMED
  //  5 in Last 30d: 3 CONFIRMED, 2 PENDING
  const windows: { range: [number, number]; statuses: BookingStatus[] }[] = [
    { range: [180, 150], statuses: ["INVOICED", "INVOICED", "INVOICED", "INVOICED"] },
    { range: [150, 120], statuses: ["INVOICED", "INVOICED", "INVOICED", "INVOICED"] },
    { range: [120,  90], statuses: ["INVOICED", "INVOICED", "INVOICED", "INVOICED"] },
    { range: [ 90,  60], statuses: ["INVOICED", "INVOICED", "INVOICED", "INVOICED"] },
    { range: [ 60,  30], statuses: ["INVOICED", "INVOICED", "INVOICED", "CONFIRMED", "CONFIRMED"] },
    { range: [ 30,   0], statuses: ["CONFIRMED", "CONFIRMED", "CONFIRMED", "PENDING", "PENDING"] },
  ];

  let idx = 0;
  for (const w of windows) {
    const [lo, hi] = w.range; // lo = older, hi = newer (days ago, lo > hi)
    const n = w.statuses.length;
    for (let k = 0; k < n; k++) {
      // Deterministic date inside window: spread evenly from lo→hi.
      const t = n === 1 ? 0 : k / (n - 1);
      const daysAgoVal = Math.round(lo - (lo - hi) * t);
      const bookingDate = daysAgo(daysAgoVal);
      specs.push({
        index: idx + 1,
        type: typeSeq[idx],
        status: w.statuses[k],
        bookingDate,
      });
      idx++;
    }
  }
  if (specs.length !== 26) {
    throw new Error(`[seed-demo] expected 26 booking specs, got ${specs.length}`);
  }
  return specs;
}

function refForIndex(i: number): string {
  return `MB-DEMO-INTLTK-${String(i).padStart(4, "0")}`;
}

function buildBookingDoc(spec: BookingSpec, users: any[]): any {
  const ref = refForIndex(spec.index);
  const seed = ref;

  // bookedBy rotation: cycle 4 demo users.
  const bookedBy = users[(spec.index - 1) % users.length];

  // Travel date: bookingDate + 3..15 days, capped at +5 days into the future
  // so PENDING/CONFIRMED in last-30-days window have realistic future-ish travel.
  const travelOffset = pickInRange(seed + "travel", 3, 15);
  const travelDate = new Date(spec.bookingDate);
  travelDate.setDate(travelDate.getDate() + travelOffset);

  // Passenger count 1..2
  const paxCount = pickInRange(seed + "pax", 1, 2);
  const passengers: any[] = [];
  for (let p = 0; p < paxCount; p++) {
    passengers.push({
      name: pickFromList(seed + "pax" + p, PASSENGER_NAMES),
      type: "ADULT" as const,
    });
  }

  const isVisa = spec.type === "VISA";
  const isHotel = spec.type === "HOTEL";

  // Pricing
  let actualMin: number, actualMax: number;
  if (spec.type === "FLIGHT") { actualMin = 6500;  actualMax = 12000; }
  else if (spec.type === "HOTEL") { actualMin = 4500;  actualMax = 14000; }
  else /* VISA */               { actualMin = 4000;  actualMax = 8000; }
  const actualPrice = pickInRange(seed + "actual", actualMin, actualMax);
  // Markup 12..18%
  const markupPctTimes100 = pickInRange(seed + "markup", 1200, 1800); // 1200..1800
  const quotedPrice = Math.round(actualPrice * (1 + markupPctTimes100 / 10000));

  // Sector + itinerary
  let sector = "";
  let itinerary: any = {};
  if (spec.type === "FLIGHT") {
    sector = pickFromList(seed + "sec", SECTORS_FLIGHT);
    const [origin, destination] = sector.split("-");
    const airline = pickFromList(seed + "air", AIRLINES);
    const flightNo = `${airline.slice(0, 2).toUpperCase()}-${pickInRange(seed + "fno", 100, 999)}`;
    itinerary = { origin, destination, airline, flightNo, description: `${origin} → ${destination}` };
  } else if (isHotel) {
    const hotel = pickFromList(seed + "hot", HOTELS);
    const nights = pickInRange(seed + "nights", 1, 4);
    sector = hotel.sector;
    itinerary = {
      hotelName: hotel.name,
      destination: hotel.city,
      roomType: "Deluxe Room",
      nights,
      roomCount: 1,
      description: `${hotel.name}, ${hotel.city}`,
    };
  } else /* VISA */ {
    const v = pickFromList(seed + "visa", VISA_DESTS);
    sector = v.destination;
    itinerary = { destination: v.destination, description: v.description };
  }

  // returnDate for HOTEL = travelDate + nights
  let returnDate: Date | undefined = undefined;
  if (isHotel && itinerary.nights) {
    returnDate = new Date(travelDate);
    returnDate.setDate(returnDate.getDate() + Number(itinerary.nights));
  }

  // Supplier PNR — 6-char deterministic hex per booking
  const supplierPNR = hexN(seed + "pnr", 6);
  const supplierName = isVisa ? "VFS Global" : "TBO";

  // sourceBookingRef stores the demo ref for visual traceability;
  // metadata.demoRef is the authoritative idempotency key.
  return {
    workspaceId: WORKSPACE_OID,
    type: spec.type,
    status: spec.status,
    source: "MANUAL" as const,
    bookingDate: spec.bookingDate,
    travelDate,
    returnDate,
    sector,
    itinerary,
    passengers,
    pricing: {
      actualPrice,
      quotedPrice,
      gstMode: "ON_MARKUP" as const,
      gstPercent: 18,
      currency: "INR",
    },
    supplierName,
    supplierPNR,
    bookedBy: bookedBy._id,
    createdBy: String(bookedBy._id),
    createdByEmail: bookedBy.email,
    isDemo: true,
    createdByDemoUser: true,
    sourceBookingRef: ref,
    metadata: { demoRef: ref },
  };
}

async function stageBookings(users: any[]): Promise<{ specs: BookingSpec[]; bookingsByRef: Map<string, any>; created: number; existed: number }> {
  const specs = makeBookingSpecs();

  // Existing demo bookings keyed by metadata.demoRef
  const existing: any[] = await ManualBooking.find(
    { workspaceId: WORKSPACE_OID, isDemo: true },
    { _id: 1, "metadata.demoRef": 1, bookingDate: 1, status: 1, pricing: 1, type: 1, passengers: 1, itinerary: 1, travelDate: 1, returnDate: 1, bookingRef: 1, supplierPNR: 1, supplierName: 1, sector: 1 },
  ).lean();
  const existingByRef = new Map<string, any>();
  for (const b of existing) {
    const ref = (b as any)?.metadata?.demoRef;
    if (ref) existingByRef.set(String(ref), b);
  }

  const bookingsByRef = new Map<string, any>();
  let created = 0;
  let existedCount = 0;

  for (const spec of specs) {
    const ref = refForIndex(spec.index);
    const existingDoc = existingByRef.get(ref);
    if (existingDoc) {
      bookingsByRef.set(ref, existingDoc);
      existedCount++;
      continue;
    }
    const docFields = buildBookingDoc(spec, users);
    const doc: any = new ManualBooking(docFields);
    await doc.save();
    // Backdate createdAt/updatedAt to bookingDate (timestamps:false prevents auto-touch)
    await ManualBooking.updateOne(
      { _id: doc._id },
      { $set: { createdAt: spec.bookingDate, updatedAt: spec.bookingDate } },
      { timestamps: false },
    );
    bookingsByRef.set(ref, doc.toObject());
    created++;
  }

  console.log(`  ✓ ManualBookings — created ${created}, already existed ${existedCount} (total demo bookings: ${specs.length})`);
  return { specs, bookingsByRef, created, existed: existedCount };
}

// ────────────────────────────────────────────────────────────────────────────
// STAGE 5 — Invoices (10 total)
// ────────────────────────────────────────────────────────────────────────────

type InvoiceLifecycle = "DRAFT" | "SENT" | "PAID";

type InvoicePlan = {
  invoiceNo: string;
  lifecycle: InvoiceLifecycle;
  // Days-ago anchors (relative to today at script-run time)
  invoiceDaysAgo: number;
  sentDaysAgo?: number;
  paidDaysAgo?: number;
  bookingRefs: string[]; // demoRefs assigned to this invoice
};

function makeInvoicePlans(specs: BookingSpec[]): InvoicePlan[] {
  // INVOICED bookings sorted from oldest to newest by spec.index (specs are built oldest→newest).
  const invoicedRefs = specs.filter((s) => s.status === "INVOICED").map((s) => refForIndex(s.index));
  // Verify we got 19 (4+4+4+4+3)
  if (invoicedRefs.length !== 19) {
    throw new Error(`[seed-demo] expected 19 INVOICED bookings, got ${invoicedRefs.length}`);
  }

  // Allocation: 4 PAID (2 each = 8), 4 SENT (2 each = 8), 2 DRAFT (2 + 1 = 3) → 19 total
  const plans: InvoicePlan[] = [];

  // PAID 1-4 (oldest invoices)
  const paidParams: { invoiceDaysAgo: number; sentDaysAgo: number; paidDaysAgo: number }[] = [
    { invoiceDaysAgo: 150, sentDaysAgo: 145, paidDaysAgo: 120 },
    { invoiceDaysAgo: 130, sentDaysAgo: 125, paidDaysAgo: 100 },
    { invoiceDaysAgo: 110, sentDaysAgo: 105, paidDaysAgo: 80  },
    { invoiceDaysAgo:  95, sentDaysAgo:  90, paidDaysAgo: 65  },
  ];
  for (let i = 0; i < 4; i++) {
    plans.push({
      invoiceNo: `INV-DEMO-2026-${String(i + 1).padStart(4, "0")}`,
      lifecycle: "PAID",
      invoiceDaysAgo: paidParams[i].invoiceDaysAgo,
      sentDaysAgo: paidParams[i].sentDaysAgo,
      paidDaysAgo: paidParams[i].paidDaysAgo,
      bookingRefs: invoicedRefs.slice(i * 2, i * 2 + 2),
    });
  }

  // SENT 5-8 (middle invoices)
  const sentParams: { invoiceDaysAgo: number; sentDaysAgo: number }[] = [
    { invoiceDaysAgo: 60, sentDaysAgo: 25 },
    { invoiceDaysAgo: 50, sentDaysAgo: 22 },
    { invoiceDaysAgo: 40, sentDaysAgo: 18 },
    { invoiceDaysAgo: 35, sentDaysAgo: 14 },
  ];
  for (let i = 0; i < 4; i++) {
    plans.push({
      invoiceNo: `INV-DEMO-2026-${String(i + 5).padStart(4, "0")}`,
      lifecycle: "SENT",
      invoiceDaysAgo: sentParams[i].invoiceDaysAgo,
      sentDaysAgo: sentParams[i].sentDaysAgo,
      bookingRefs: invoicedRefs.slice(8 + i * 2, 8 + i * 2 + 2),
    });
  }

  // DRAFT 9-10 (most recent)
  plans.push({
    invoiceNo: "INV-DEMO-2026-0009",
    lifecycle: "DRAFT",
    invoiceDaysAgo: 25,
    bookingRefs: invoicedRefs.slice(16, 18), // 2 bookings
  });
  plans.push({
    invoiceNo: "INV-DEMO-2026-0010",
    lifecycle: "DRAFT",
    invoiceDaysAgo: 15,
    bookingRefs: invoicedRefs.slice(18, 19), // 1 booking
  });

  // Sanity: every INVOICED booking is bundled exactly once.
  const allBundled = new Set<string>();
  for (const p of plans) {
    for (const r of p.bookingRefs) {
      if (allBundled.has(r)) throw new Error(`[seed-demo] booking ${r} double-bundled`);
      allBundled.add(r);
    }
  }
  if (allBundled.size !== 19) {
    throw new Error(`[seed-demo] expected 19 bundled bookings, got ${allBundled.size}`);
  }
  return plans;
}

function buildInvoiceLinesAndTotals(bookings: any[]): {
  lineItems: any[];
  subtotal: number;
  totalGST: number;
  grandTotal: number;
  igstAmount: number;
} {
  // Per brief: inline the minimum — one line per booking with quotedPrice and GST 18%.
  // ON_MARKUP convention: igst is embedded inside the markup (quotedPrice − actualPrice).
  // For invoice display we treat each line as a COST line where:
  //   amount = quotedPrice (customer-payable)
  //   igst   = embedded GST on the markup = (quoted − actual) × 18 / 118
  //   rate   = amount − igst (pre-GST base)
  const lineItems: any[] = [];
  let subtotal = 0;
  let totalGST = 0;
  for (const b of bookings) {
    const actual = Number(b?.pricing?.actualPrice ?? 0);
    const quoted = Number(b?.pricing?.quotedPrice ?? 0);
    const markup = Math.max(0, quoted - actual);
    const igst = parseFloat((markup * 18 / 118).toFixed(2));
    const amount = parseFloat(quoted.toFixed(2));
    const rate = parseFloat((amount - igst).toFixed(2));
    const passengerNames: string[] = Array.isArray(b?.passengers) ? b.passengers.map((p: any) => p?.name).filter(Boolean) : [];
    lineItems.push({
      bookingRef: b?.bookingRef || b?.sourceBookingRef || "",
      rowType: "COST",
      description: b?.type === "HOTEL" ? "Hotel Cost" : b?.type === "VISA" ? "Visa Cost" : "Flight Cost",
      subDescription: b?.itinerary?.description || b?.sector || "",
      qty: 1,
      rate,
      igst,
      amount,
      passengerNames,
      travelDate: b?.travelDate,
      type: b?.type,
    });
    subtotal += rate;
    totalGST += igst;
  }
  subtotal = parseFloat(subtotal.toFixed(2));
  totalGST = parseFloat(totalGST.toFixed(2));
  const grandTotal = parseFloat((subtotal + totalGST).toFixed(2));
  return { lineItems, subtotal, totalGST, grandTotal, igstAmount: totalGST };
}

async function stageInvoices(specs: BookingSpec[], bookingsByRef: Map<string, any>): Promise<{ created: number; existed: number }> {
  const plans = makeInvoicePlans(specs);

  // Existing demo invoices keyed by invoiceNo
  const existing: any[] = await Invoice.find(
    { workspaceId: WORKSPACE_OID, isDemo: true },
    { invoiceNo: 1, bookingIds: 1 },
  ).lean();
  const existingInvoiceNos = new Set(existing.map((i: any) => i.invoiceNo));

  let created = 0;
  let existedCount = 0;

  for (const plan of plans) {
    if (existingInvoiceNos.has(plan.invoiceNo)) {
      // Idempotency: invoice already exists. Ensure its bookings are still
      // marked INVOICED and pointed at it.
      const existingInv: any = existing.find((i: any) => i.invoiceNo === plan.invoiceNo);
      if (existingInv?._id && Array.isArray(existingInv.bookingIds) && existingInv.bookingIds.length) {
        await ManualBooking.updateMany(
          { _id: { $in: existingInv.bookingIds } },
          { $set: { status: "INVOICED", invoiceId: existingInv._id } },
          { timestamps: false },
        );
      }
      existedCount++;
      continue;
    }

    const bundledBookings = plan.bookingRefs
      .map((r) => bookingsByRef.get(r))
      .filter(Boolean);
    if (bundledBookings.length === 0) {
      console.warn(`  [WARN] invoice ${plan.invoiceNo} has zero resolvable bookings; skipping`);
      continue;
    }
    const bookingIds = bundledBookings.map((b: any) => b._id);

    const { lineItems, subtotal, totalGST, grandTotal, igstAmount } = buildInvoiceLinesAndTotals(bundledBookings);

    const invoiceDate = daysAgo(plan.invoiceDaysAgo);
    const dueDate = new Date(invoiceDate);
    dueDate.setDate(dueDate.getDate() + 30);
    const sentAt = plan.sentDaysAgo != null ? daysAgo(plan.sentDaysAgo) : undefined;
    const paidAt = plan.paidDaysAgo != null ? daysAgo(plan.paidDaysAgo) : undefined;

    const editHistory: any[] = [
      { editedAt: invoiceDate, editedBy: undefined, fieldsChanged: ["status"], oldValues: {}, newValues: { status: "DRAFT" } },
    ];
    if (plan.lifecycle === "SENT" || plan.lifecycle === "PAID") {
      editHistory.push({ editedAt: sentAt, editedBy: undefined, fieldsChanged: ["status"], oldValues: { status: "DRAFT" }, newValues: { status: "SENT", sentAt } });
    }
    if (plan.lifecycle === "PAID") {
      editHistory.push({ editedAt: paidAt, editedBy: undefined, fieldsChanged: ["status"], oldValues: { status: "SENT" }, newValues: { status: "PAID", paidAt } });
    }

    const paymentRef = plan.lifecycle === "PAID"
      ? `DEMO-PAYMENT-2026-${plan.invoiceNo.slice(-4)}`
      : undefined;

    const invoiceDoc: any = new Invoice({
      invoiceNo: plan.invoiceNo,
      workspaceId: WORKSPACE_OID,
      bookingIds,
      lineItems,
      subtotal,
      totalGST,
      grandTotal,
      supplyType: "IGST",
      igstAmount,
      cgstAmount: 0,
      sgstAmount: 0,
      utgstAmount: 0,
      status: plan.lifecycle,
      invoiceDate,
      dueDate,
      generatedAt: invoiceDate,
      sentAt,
      paidAt,
      notes: paymentRef ? `Payment ref: ${paymentRef}` : undefined,
      editHistory,
      isDemo: true,
    });
    await invoiceDoc.save();

    // Backdate createdAt/updatedAt to invoiceDate
    await Invoice.updateOne(
      { _id: invoiceDoc._id },
      { $set: { createdAt: invoiceDate, updatedAt: invoiceDate } },
      { timestamps: false },
    );

    // Mark source bookings INVOICED + set invoiceId (they're already INVOICED;
    // this just attaches the invoiceId pointer).
    await ManualBooking.updateMany(
      { _id: { $in: bookingIds } },
      { $set: { status: "INVOICED", invoiceId: invoiceDoc._id } },
      { timestamps: false },
    );

    created++;
    console.log(`  ✓ Created Invoice ${plan.invoiceNo} (${plan.lifecycle}, ${bookingIds.length} bookings, grandTotal ₹${grandTotal})`);
  }
  console.log(`  ✓ Invoices — created ${created}, already existed ${existedCount} (total demo invoices: ${plans.length})`);
  return { created, existed: existedCount };
}

// ────────────────────────────────────────────────────────────────────────────
// STAGE 6 — Grant demoAccess to the rep
// ────────────────────────────────────────────────────────────────────────────

async function stageRepGrant(users: any[]): Promise<{ granted: boolean; skipped: boolean }> {
  const rep = await User.findOne({ email: REP_EMAIL.toLowerCase() });
  if (!rep) {
    console.warn(`  [WARN] Rep ${REP_EMAIL} not found. demoAccess grant SKIPPED.`);
    console.warn(`  [WARN] You will need to grant demoAccess manually once the rep account exists.`);
    return { granted: false, skipped: true };
  }
  const seedUserIds = users.map((u) => u._id);
  await User.updateOne(
    { _id: rep._id },
    {
      $set: {
        "demoAccess.enabled": true,
        "demoAccess.mappedSeedUsers": seedUserIds,
      },
    },
  );
  console.log(`  ✓ demoAccess granted to ${REP_EMAIL} with ${seedUserIds.length} mapped seed users.`);
  return { granted: true, skipped: false };
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  await connectDb();
  console.log("✅ Connected to MongoDB");
  console.log(`Target workspace: Inteletek AI (_id ${INTELETEK_WORKSPACE_ID})`);

  console.log("\n[Stage 1] Workspace flag + wallet");
  await stageWorkspace();

  console.log("\n[Stage 2] Demo users");
  const { users, createdCount: usersCreated, existingFlaggedCount } = await stageUsers();

  console.log("\n[Stage 3] UserPermissions");
  const permResult = await stagePermissions(users);

  console.log("\n[Stage 4] ManualBookings (26)");
  const { specs, bookingsByRef, created: bookingsCreated, existed: bookingsExisted } = await stageBookings(users);

  console.log("\n[Stage 5] Invoices (10)");
  const invoiceResult = await stageInvoices(specs, bookingsByRef);

  console.log("\n[Stage 6] demoAccess grant");
  const repResult = await stageRepGrant(users);

  console.log("\n────────────────────────── Summary ──────────────────────────");
  console.log(`  ✓ CustomerWorkspace.isDemo=true, wallet configured (500000 / 120000 used)`);
  console.log(`  ✓ Demo users: ${usersCreated} created, ${existingFlaggedCount} existing flagged, ${4 - usersCreated - existingFlaggedCount} already isDemoUser`);
  console.log(`  ✓ UserPermission rows: ${permResult.created} created, ${permResult.existed} already existed`);
  console.log(`  ✓ ManualBookings: ${bookingsCreated} created, ${bookingsExisted} already existed (total demo: 26)`);
  console.log(`  ✓ Invoices: ${invoiceResult.created} created, ${invoiceResult.existed} already existed (total demo: 10)`);
  if (repResult.granted) {
    console.log(`  ✓ demoAccess granted to ${REP_EMAIL}`);
  } else {
    console.log(`  ⚠ demoAccess SKIPPED — ${REP_EMAIL} not found`);
  }
  console.log(`  ✓ All operations idempotent. Re-run safe.`);
  console.log("──────────────────────────────────────────────────────────────\n");

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  try { await mongoose.disconnect(); } catch { /* swallow */ }
  process.exit(1);
});
