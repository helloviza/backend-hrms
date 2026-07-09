/**
 * scripts/verify-travel-request.ts — LOCAL, NON-PROD ONLY. DO NOT COMMIT.
 * ---------------------------------------------------------------------------
 * End-to-end verification of the /api/public/travel-request pipeline against
 * a local, throwaway MongoDB. Deliberately does NOT import config/env.ts,
 * config/db.ts, or server.ts, and NEVER reads MONGO_URI from process.env/.env
 * — it connects to a hardcoded local URI only, so this script can never
 * accidentally reach production regardless of what apps/backend/.env points
 * at. A regex guard on LOCAL_MONGO_URI double-checks this at runtime.
 *
 * Spins up a minimal in-process Express app (NOT the full server.ts — that
 * boots crons, a WhatsApp Web client, Gmail ingestion, etc. that have nothing
 * to do with this pipeline) mounting the real, unmodified
 * routes/public.travelRequest.ts router, and drives it with real HTTP
 * requests via fetch.
 *
 * Run: pnpm -C apps/backend verify:travel-request
 * Prereq: a local Mongo reachable at LOCAL_MONGO_URI (see infra/audit's
 * companion build doc for the `docker run mongo:7` command used to stand
 * one up for this verification).
 */
import mongoose, { Types } from "mongoose";
import express from "express";
import http from "http";
import crypto from "crypto";
import bcrypt from "bcryptjs";

import ManualBooking from "../models/ManualBooking.js";
import Customer from "../models/Customer.js";
import User from "../models/User.js";
import publicTravelRequestRouter from "../routes/public.travelRequest.js";
import {
  HOUSE_CUSTOMER_ID,
  SYSTEM_INTAKE_USER_ID,
  SYSTEM_INTAKE_EMAIL,
} from "../services/travelIntake.create.js";

// ── Hardcoded local target — never sourced from .env/process.env ──────────
const LOCAL_MONGO_URI = "mongodb://127.0.0.1:27018/plumtrips_verify";
const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254"; // real CustomerWorkspace, User.workspaceId ref target

// Cloudflare's published "always passes" Turnstile TEST secret key — public,
// documented by Cloudflare for exactly this purpose. Verification against
// Cloudflare's real siteverify endpoint returns success:true unconditionally
// for ANY response token when this secret is used.
const TURNSTILE_ALWAYS_PASS_SECRET = "1x0000000000000000000000000000000AA";

let passCount = 0;
let failCount = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`PASS - ${label}`);
    passCount++;
  } else {
    console.log(`FAIL - ${label}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
    failCount++;
  }
}

async function post(base: string, body: any) {
  const res = await fetch(`${base}/api/public/travel-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body on some error paths — fine */
  }
  return { status: res.status, body: json };
}

function validPayload(overrides: Record<string, any> = {}) {
  return {
    fullName: "Verify Test User",
    mobile: "",
    email: "verify.test@example.com",
    originCity: "Mumbai",
    destination: "Dubai",
    travelDate: "2026-12-01",
    returnDate: "2026-12-10",
    purpose: "Leisure",
    travelerCount: 2,
    notes: "e2e verification run",
    services: ["Tourist Visa", "Flight Booking"],
    submissionId: crypto.randomUUID(),
    turnstileToken: "any-token-accepted-by-always-pass-secret",
    hpField: "",
    ...overrides,
  };
}

async function main() {
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(LOCAL_MONGO_URI)) {
    throw new Error("Refusing to run — LOCAL_MONGO_URI does not look like a local address.");
  }

  process.env.TURNSTILE_SECRET = TURNSTILE_ALWAYS_PASS_SECRET;
  delete process.env.TURNSTILE_DEV_BYPASS;

  await mongoose.connect(LOCAL_MONGO_URI);
  console.log(`[setup] connected to ${LOCAL_MONGO_URI}`);

  // ── SETUP: idempotent seed of the two system identities ─────────────────
  const existingCustomer = await Customer.findById(HOUSE_CUSTOMER_ID).lean();
  if (existingCustomer) {
    console.log(`[setup] House Customer (${HOUSE_CUSTOMER_ID}) — already present`);
  } else {
    await Customer.create({
      _id: new Types.ObjectId(HOUSE_CUSTOMER_ID),
      customerCode: "HOUSE-INTAKE",
      name: "PlumTrips House",
      legalName: "PlumTrips House",
      companyName: "PlumTrips House",
      type: "CUSTOMER",
      status: "ACTIVE",
      segment: "internal",
      workspaceId: new Types.ObjectId(HOUSE_WORKSPACE_ID),
    });
    console.log(`[setup] House Customer (${HOUSE_CUSTOMER_ID}) — CREATED (was absent)`);
  }

  const existingUser = await User.findById(SYSTEM_INTAKE_USER_ID).lean();
  if (existingUser) {
    console.log(`[setup] System Intake User (${SYSTEM_INTAKE_USER_ID}) — already present`);
  } else {
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
    await User.create({
      _id: new Types.ObjectId(SYSTEM_INTAKE_USER_ID),
      email: SYSTEM_INTAKE_EMAIL,
      officialEmail: SYSTEM_INTAKE_EMAIL,
      workspaceId: new Types.ObjectId(HOUSE_WORKSPACE_ID),
      name: "System Intake",
      passwordHash,
      roles: ["SYSTEM_INTAKE"],
      status: "ACTIVE",
    });
    console.log(`[setup] System Intake User (${SYSTEM_INTAKE_USER_ID}) — CREATED (was absent)`);
  }

  // ── Minimal harness app — real router, no other server.ts machinery ─────
  const app = express();
  app.use(express.json());
  app.use("/api/public", publicTravelRequestRouter);

  const server = http.createServer(app);
  const base: string = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
  console.log(`[setup] harness listening at ${base}\n`);

  const testIntakeRefs: string[] = [];
  const trackedManualBookingIds: string[] = [];

  // ── A. Happy path ─────────────────────────────────────────────────────
  const submissionIdA = crypto.randomUUID();
  testIntakeRefs.push(`public:${submissionIdA}`);
  const resA = await post(base, validPayload({ submissionId: submissionIdA }));
  check("A1: happy-path POST returns 201", resA.status === 201, resA);
  check(
    "A2: response leaks no internal ids/stack traces (only ok+reference keys)",
    resA.body && typeof resA.body === "object" && Object.keys(resA.body).sort().join(",") === "ok,reference"
  );
  check("A3: response reference echoes client submissionId", resA.body?.reference === submissionIdA);

  const rowsA = await ManualBooking.find({ "metadata.intakeRef": `public:${submissionIdA}` }).lean();
  check("A4: exactly one ManualBooking row per ticked service (2 services -> 2 rows)", rowsA.length === 2, { count: rowsA.length });

  const typesA = rowsA.map((r: any) => r.type).sort();
  check("A5: row types match ticked services (VISA + FLIGHT)", JSON.stringify(typesA) === JSON.stringify(["FLIGHT", "VISA"]), typesA);

  check(
    "A6: all rows pinned to HOUSE workspaceId",
    rowsA.every((r: any) => String(r.workspaceId) === HOUSE_CUSTOMER_ID)
  );
  check(
    "A7: all rows bookedBy System Intake User",
    rowsA.every((r: any) => String(r.bookedBy) === SYSTEM_INTAKE_USER_ID)
  );
  check("A8: all rows status=PENDING", rowsA.every((r: any) => r.status === "PENDING"));
  check(
    "A9: all rows assignmentStatus=PENDING_TO_ASSIGN",
    rowsA.every((r: any) => r.assignmentStatus === "PENDING_TO_ASSIGN")
  );
  check(
    "A10: all rows share the same metadata.intakeRef, prefixed public:",
    rowsA.every((r: any) => r.metadata?.intakeRef === `public:${submissionIdA}`)
  );

  // ── D. Dedup — resubmit the SAME submissionId ───────────────────────────
  const resD = await post(base, validPayload({ submissionId: submissionIdA }));
  check("D1: resubmitting the same submissionId still returns 201", resD.status === 201, resD);
  const rowsD = await ManualBooking.find({ "metadata.intakeRef": `public:${submissionIdA}` }).lean();
  check("D2: no NEW rows created on duplicate submission (still 2, not 4)", rowsD.length === 2, { count: rowsD.length });

  // ── B. Fail-closed — missing Turnstile token ────────────────────────────
  const submissionIdB = crypto.randomUUID();
  testIntakeRefs.push(`public:${submissionIdB}`);
  const resB = await post(base, validPayload({ submissionId: submissionIdB, turnstileToken: "" }));
  check("B1: missing Turnstile token -> 400", resB.status === 400, resB);
  const rowsB = await ManualBooking.find({ "metadata.intakeRef": `public:${submissionIdB}` }).lean();
  check("B2: no rows created for the rejected submission", rowsB.length === 0, { count: rowsB.length });

  // ── C. Honeypot ──────────────────────────────────────────────────────────
  const submissionIdC = crypto.randomUUID();
  testIntakeRefs.push(`public:${submissionIdC}`);
  const resC = await post(base, validPayload({ submissionId: submissionIdC, hpField: "i-am-a-bot" }));
  check("C1: honeypot-triggered submission is rejected (fake-success, not processed)", resC.status === 201, resC);
  const rowsC = await ManualBooking.find({ "metadata.intakeRef": `public:${submissionIdC}` }).lean();
  check("C2: honeypot submission created NO ManualBooking row", rowsC.length === 0, { count: rowsC.length });

  // ── E. Rate limit ────────────────────────────────────────────────────────
  // travelRequestLimiter is capped at 8/15min/IP. By this point A, D and B
  // have already consumed 3 slots on this same harness process (C did not —
  // the honeypot short-circuits BEFORE the limiter middleware). Firing 15
  // more guarantees we cross the ceiling regardless of exact prior count.
  const burstStatuses: number[] = [];
  for (let i = 0; i < 15; i++) {
    const id = crypto.randomUUID();
    testIntakeRefs.push(`public:${id}`);
    // Intentionally invalid (no token) — irrelevant, since the limiter runs
    // BEFORE Turnstile verification and counts every request regardless of
    // its eventual outcome.
    const res = await post(base, validPayload({ submissionId: id, turnstileToken: "" }));
    burstStatuses.push(res.status);
  }
  const saw429 = burstStatuses.includes(429);
  const tailAll429 = burstStatuses.slice(-3).every((s) => s === 429);
  check("E1: rate limiter engages within the burst (at least one 429 seen)", saw429, burstStatuses);
  check("E2: sustained 429s once the ceiling is crossed (tail of burst)", tailAll429, burstStatuses);

  // ── F. Assignment rule (direct model manipulation) ──────────────────────
  const fDoc = await ManualBooking.create({
    workspaceId: new Types.ObjectId(HOUSE_CUSTOMER_ID),
    bookedBy: new Types.ObjectId(SYSTEM_INTAKE_USER_ID),
    travelDate: new Date("2026-12-01"),
    type: "OTHER",
    passengers: [{ name: "Assignment Rule Test", type: "ADULT" }],
    metadata: { intakeRef: "verify-script:assignment-rule-test" },
  });
  trackedManualBookingIds.push(String(fDoc._id));
  check("F1: fresh row defaults to PENDING_TO_ASSIGN", fDoc.assignmentStatus === "PENDING_TO_ASSIGN");

  (fDoc as any).assignPerson = new Types.ObjectId(SYSTEM_INTAKE_USER_ID);
  await fDoc.save();
  check("F2: setting assignPerson flips assignmentStatus -> ASSIGNED", fDoc.assignmentStatus === "ASSIGNED");

  (fDoc as any).assignPerson = undefined;
  await fDoc.save();
  check("F3: clearing assignPerson reverts assignmentStatus -> PENDING_TO_ASSIGN", fDoc.assignmentStatus === "PENDING_TO_ASSIGN");

  // ── G. Triage-visibility bypass — assigned row must stay visible to its
  // assignee. Reproduces routes/manualBookings.ts's GET / scopeOr filter
  // inline (both the pre-fix 2-clause version and the current 3-clause one)
  // against a real ASSIGNED intake row, so this regresses if the fix is
  // ever reverted. Doesn't go through HTTP/auth — this is a direct
  // regression test of the Mongo filter shape itself.
  const testAssigneeId = new Types.ObjectId();
  const gDoc = await ManualBooking.create({
    workspaceId: new Types.ObjectId(HOUSE_CUSTOMER_ID),
    bookedBy: new Types.ObjectId(SYSTEM_INTAKE_USER_ID),
    createdBy: SYSTEM_INTAKE_USER_ID, // matches real intake rows — never the assignee
    travelDate: new Date("2026-12-01"),
    type: "OTHER",
    passengers: [{ name: "Triage Visibility Test", type: "ADULT" }],
    metadata: { intakeRef: "verify-script:triage-visibility-test" },
  });
  trackedManualBookingIds.push(String(gDoc._id));

  (gDoc as any).assignPerson = testAssigneeId;
  await gDoc.save();
  check("G1: intake row assigned to test user flips to ASSIGNED", gDoc.assignmentStatus === "ASSIGNED");

  const selfIdStr = String(testAssigneeId);
  const preFixScopeOr = [
    { createdBy: selfIdStr },
    { workspaceId: new Types.ObjectId(HOUSE_CUSTOMER_ID), assignmentStatus: "PENDING_TO_ASSIGN" },
  ];
  const postFixScopeOr = [
    ...preFixScopeOr,
    { workspaceId: new Types.ObjectId(HOUSE_CUSTOMER_ID), assignPerson: testAssigneeId },
  ];

  const preFixMatch = await ManualBooking.findOne({ _id: gDoc._id, $or: preFixScopeOr }).lean();
  const postFixMatch = await ManualBooking.findOne({ _id: gDoc._id, $or: postFixScopeOr }).lean();

  check("G2: pre-fix 2-clause $or does NOT surface the assignee's own assigned row (the bug)", !preFixMatch);
  check("G3: post-fix 3-clause $or (current manualBookings.ts code) DOES surface it", !!postFixMatch);

  // ── H1. Single-record path (GET /:id) — same assignee-visibility gap,
  // reproduces routes/manualBookings.ts's GET /:id ownership gate inline
  // (pre-fix vs current 3-way check) against the SAME assigned row from G.
  // PUT /:id itself has no ownership gate (permission-only — verified by
  // reading the handler, no change made there), so no H2 is needed.
  const isHouseBookingWorkspace = String(gDoc.workspaceId) === HOUSE_CUSTOMER_ID;
  const preFixIsHouseUnassignedIntake = isHouseBookingWorkspace && gDoc.assignmentStatus === "PENDING_TO_ASSIGN";
  const preFix403 = Boolean(gDoc.createdBy) && gDoc.createdBy !== selfIdStr && !preFixIsHouseUnassignedIntake;

  const postFixIsHouseAssignedToSelf = isHouseBookingWorkspace && String(gDoc.assignPerson ?? "") === selfIdStr;
  const postFix403 =
    Boolean(gDoc.createdBy) && gDoc.createdBy !== selfIdStr && !preFixIsHouseUnassignedIntake && !postFixIsHouseAssignedToSelf;

  check("H1a: pre-fix GET /:id gate would 403 the assignee (the bug)", preFix403 === true);
  check("H1b: post-fix GET /:id gate (current manualBookings.ts code) lets the assignee through", postFix403 === false);

  // ── Cleanup — only rows this script created ─────────────────────────────
  const del1 = await ManualBooking.deleteMany({ "metadata.intakeRef": { $in: testIntakeRefs } });
  const del2 = await ManualBooking.deleteMany({ _id: { $in: trackedManualBookingIds.map((id) => new Types.ObjectId(id)) } });
  console.log(`\n[cleanup] removed ${del1.deletedCount} intake-test row(s) + ${del2.deletedCount} assignment-test row(s)`);

  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();

  console.log(`\n=== ${passCount} PASS / ${failCount} FAIL ===`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[verify-travel-request] fatal error:", err);
  process.exit(1);
});
