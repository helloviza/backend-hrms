// apps/backend/src/seed/seed-dev.ts
//
// RERUNNABLE local development seed. `pnpm -C apps/backend seed:dev`.
//
// Stands up one workspace ("Acme Industries") with enough real data to walk
// the whole customer surface on first login: the traveller dossier tabs, the
// self-apply visa flow, and the customer-side approval queue.
//
// ── THIS IS NOT src/seed/seed.ts ────────────────────────────────────────
// That one calls `User.deleteMany({})` — it wipes the entire User collection
// of whatever database it is pointed at, which is exactly the shape of
// accident this file exists to make impossible. This script:
//   - REFUSES to run against a non-local MONGO_URI (see assertLocalDatabase),
//   - deletes only documents belonging to its own seeded workspace,
//   - and is safe to run repeatedly.
//
// ── RERUNNABLE MEANS TORN DOWN, NOT UPSERTED ────────────────────────────
// Each run removes this workspace's own rows and rebuilds them. Upserting
// across a dozen collections with cross-references would drift with every
// schema change; a scoped teardown stays correct for free. Nothing outside
// the seeded workspace and its two logins is touched.

import "../bootstrap/loadSecrets.js";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";

import Customer from "../models/Customer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import User from "../models/User.js";
import Department from "../models/Department.js";
import Designation from "../models/Designation.js";
import TravellerProfile from "../models/TravellerProfile.js";
import VisaRule from "../models/VisaRule.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaApplication from "../models/VisaApplication.js";
import {
  CURRENT_VISA_CONSENT_VERSION,
  VISA_CONSENT_CLAUSE_IDS,
} from "../config/visaConsent.js";

/* ── The guard ───────────────────────────────────────────────────────────
 *
 * A seed that can be pointed at production is a production incident waiting
 * for a tired evening. This one refuses anything that is not unmistakably a
 * local database, and it refuses by DEFAULT — the check is on the host, so a
 * new remote provider nobody has thought of is rejected without needing to
 * be listed anywhere.
 * ─────────────────────────────────────────────────────────────────────── */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"]);

function assertLocalDatabase(uri: string): void {
  if (!uri) {
    throw new Error("MONGO_URI is empty. Copy apps/backend/.env.development.example to .env.development.");
  }

  // mongodb+srv is Atlas-shaped by definition — never local. Rejected before
  // parsing, because the SRV form has no port and parses oddly.
  if (uri.startsWith("mongodb+srv://")) {
    throw new Error(
      "REFUSING TO SEED: MONGO_URI is a mongodb+srv:// (Atlas) connection string.\n" +
        "This script only ever runs against a local database. Check that\n" +
        "NODE_ENV=development and apps/backend/.env.development exists — see docs/dev-setup.md.",
    );
  }

  let hosts: string[];
  try {
    // Strip the scheme and any credentials, then take the host list.
    const afterScheme = uri.replace(/^mongodb:\/\//, "");
    const afterCreds = afterScheme.includes("@") ? afterScheme.slice(afterScheme.indexOf("@") + 1) : afterScheme;
    hosts = afterCreds.split("/")[0].split(",").map((h) => h.split(":")[0].trim().toLowerCase());
  } catch {
    throw new Error(`REFUSING TO SEED: could not parse MONGO_URI to verify it is local.`);
  }

  const remote = hosts.filter((h) => !LOCAL_HOSTS.has(h));
  if (remote.length) {
    throw new Error(
      `REFUSING TO SEED: MONGO_URI points at a non-local host (${remote.join(", ")}).\n` +
        "This script only ever runs against a local database. See docs/dev-setup.md.",
    );
  }
}

/* ── What gets seeded ────────────────────────────────────────────────── */

// A REAL ObjectId, and it has to be (2026-08-16). This value is written to
// CustomerWorkspace.customerId, and the product treats that field as a
// Customer._id — utils/travelerId.ts's mintTravellerProfileId does
// `Customer.findById(customerId)`. The previous value, the string "dev-acme",
// was not castable, so that lookup threw
//   Cast to ObjectId failed for value "dev-acme" ... for model "Customer"
// and EVERY traveller creation on seeded data 500'd — single Add Traveller and
// bulk import alike. It was invisible because the seed writes its own four
// traveller rows directly and never mints an id.
//
// Fixed rather than generated so a re-seed keeps the same id and the teardown
// below still finds the previous run's rows.
const CUSTOMER_ID = "dec0ded0dec0ded0dec0ded0";
// The Customer row's own identity — see the teardown's note on why this, and
// not CUSTOMER_ID, is what finds it.
const CUSTOMER_LEGAL_NAME = "Acme Industries Private Limited";
const WORKSPACE_SLUG = "acme-dev";
const PASSWORD = "Passw0rd!";

const LEADER_EMAIL = "leader@acme.test";
const EMPLOYEE_EMAIL = "employee@acme.test";
const COLLEAGUE_A_EMAIL = "kavya@acme.test";

async function main() {
  const uri = env.MONGO_URI;
  assertLocalDatabase(uri);

  await mongoose.connect(uri);
  const dbName = mongoose.connection.name;
  console.log(`[seed:dev] connected to ${uri} (db: ${dbName})`);

  /* ── Teardown, scoped to this seed's own workspace ─────────────────── */

  const existing: any = await CustomerWorkspace.findOne({ customerId: CUSTOMER_ID }).lean();
  if (existing) {
    const wsId = existing._id;
    const removed = await Promise.all([
      VisaApplication.deleteMany({ workspaceId: wsId }),
      VisaRequest.deleteMany({ workspaceId: wsId }),
      // NOT VisaRule — it is a GLOBAL catalogue with no workspaceId at all
      // (its unique index is the corridor tuple: nationality + destination +
      // purpose + entryType + serviceTier + variantKey). Deleting "this
      // workspace's rules" is therefore meaningless, and a filter on a field
      // the schema does not declare is exactly how a delete ends up
      // unscoped. The rule is UPSERTED by corridor further down instead.
      TravellerProfile.deleteMany({ workspaceId: wsId }),
      Designation.deleteMany({ workspaceId: wsId }),
      Department.deleteMany({ workspaceId: wsId }),
      User.deleteMany({ workspaceId: wsId }),
      CustomerMember.deleteMany({ customerId: CUSTOMER_ID }),
      CustomerWorkspace.deleteOne({ _id: wsId }),
    ]);
    const total = removed.reduce((n, r: any) => n + (r.deletedCount ?? 0), 0);
    console.log(`[seed:dev] cleared ${total} existing doc(s) for customerId=${CUSTOMER_ID}`);
  }

  /* ── Customer + workspace ──────────────────────────────────────────── */

  // OUTSIDE the guard above, and BY legalName (2026-08-11). Two bugs made
  // this seed not actually rerunnable, contrary to its own header:
  //
  //   1. models/Customer.ts has no `customerId` field at all — that key lives
  //      on CustomerWorkspace and User — so a `{ customerId }` filter matched
  //      nothing and left the Customer row behind. The next run then died on
  //      the unique legalNameNormalized index before writing anything.
  //   2. The workspace-scoped teardown only runs when the workspace still
  //      exists, so a run that died PART-WAY (exactly what 1. caused) left an
  //      orphan Customer that no subsequent run would ever clear.
  //
  // Deleting by the exact legalName this seed itself writes is scoped to the
  // one row it owns, and is correct whichever half of a previous run survived.
  await Customer.deleteMany({ legalName: CUSTOMER_LEGAL_NAME });

  // _id, not a `customerId` field: models/Customer.ts declares no such field
  // (the note above says so), so passing it merely dropped it on the floor and
  // left the row with an auto id unrelated to what CustomerWorkspace pointed
  // at. Pinning _id is what makes `Customer.findById(workspace.customerId)`
  // resolve — and resolve to a row with the right legalName, so minted
  // traveller ids read "ACME-001" rather than the "Traveller" fallback.
  await Customer.create({
    _id: new mongoose.Types.ObjectId(CUSTOMER_ID),
    legalName: CUSTOMER_LEGAL_NAME,
    isActive: true,
  } as any);

  const workspace: any = await CustomerWorkspace.create({
    customerId: CUSTOMER_ID,
    slug: WORKSPACE_SLUG,
    companyName: "Acme Industries",
    status: "ACTIVE",
    accessMode: "INVITE_ONLY",
    canApproverManageTravellers: true,
    config: {
      travelFlow: "SBT",
      // The whole point of seeding this ON: with it OFF the Approvals nav
      // item is correctly hidden and there is nothing to look at.
      visaApprovalRequired: true,
      features: {
        visaEnabled: true,
        sbtEnabled: true,
        approvalFlowEnabled: true,
        flightBookingEnabled: true,
        hotelBookingEnabled: true,
      },
    },
  } as any);
  const wsId = workspace._id;
  console.log(`[seed:dev] workspace "Acme Industries" (${wsId})`);

  /* ── Logins ────────────────────────────────────────────────────────── */

  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  async function makeUser(email: string, firstName: string, lastName: string) {
    return User.create({
      email,
      passwordHash,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      roles: ["CUSTOMER"],
      workspaceId: wsId,
      customerId: CUSTOMER_ID,
      businessId: CUSTOMER_ID,
      isActive: true,
      status: "ACTIVE",
    } as any);
  }

  const leader: any = await makeUser(LEADER_EMAIL, "Meera", "Iyer");
  const employee: any = await makeUser(EMPLOYEE_EMAIL, "Arjun", "Nair");
  const colleagueA: any = await makeUser(COLLEAGUE_A_EMAIL, "Kavya", "Menon");

  await CustomerMember.insertMany([
    { customerId: CUSTOMER_ID, email: LEADER_EMAIL, name: "Meera Iyer", role: "WORKSPACE_LEADER", isActive: true, travelerId: "" },
    { customerId: CUSTOMER_ID, email: EMPLOYEE_EMAIL, name: "Arjun Nair", role: "REQUESTER", isActive: true, travelerId: "" },
    { customerId: CUSTOMER_ID, email: COLLEAGUE_A_EMAIL, name: "Kavya Menon", role: "REQUESTER", isActive: true, travelerId: "" },
  ] as any);

  /* ── Org reference data (so Tab 1's pickers aren't empty) ──────────── */

  const engineering: any = await Department.create({
    workspaceId: wsId, name: "Engineering", isActive: true, createdBy: leader._id,
  } as any);
  await Department.create({
    workspaceId: wsId, name: "Finance", isActive: true, createdBy: leader._id,
  } as any);

  const seniorEm: any = await Designation.create({
    workspaceId: wsId, name: "Senior Engineering Manager", department: "Engineering", level: 4, isActive: true, createdBy: leader._id,
  } as any);
  await Designation.create({
    workspaceId: wsId, name: "Software Engineer", department: "Engineering", level: 2, isActive: true, createdBy: leader._id,
  } as any);

  /* ── Traveller profiles ────────────────────────────────────────────────
   *
   * Four, each covering a state the UI has to handle:
   *   1. Arjun   — CLAIMED by the employee. Rich on Tabs 1 and 4, but
   *                deliberately missing mobile + gender so the completion
   *                prompt and a sub-100% Dossier Health are both visible.
   *   2. Kavya   — admin-created, UNCLAIMED (no claimedBy). What the roster
   *                looks like for someone who has never logged in.
   *   3. Rohan   — colleague, minimal fields. Low Dossier Health.
   *   4. Sneha   — colleague, complete. 100% Dossier Health, for contrast.
   * ─────────────────────────────────────────────────────────────────── */

  let seq = 0;
  const nextTravelerId = () => `ACME-${String(++seq).padStart(3, "0")}`;

  const arjun: any = await TravellerProfile.create({
    workspaceId: wsId,
    travelerId: nextTravelerId(),
    firstName: "Arjun",
    lastName: "Nair",
    email: EMPLOYEE_EMAIL,
    // Claimed => resolves on My Profile, and (per the row gate) editable by
    // its subject even though an admin created it.
    claimedBy: employee._id,
    claimedAt: new Date(),
    dob: "1991-04-17",
    nationality: "IN",
    passportNo: "M8841203",
    passportExpiry: "2031-06-30",
    passportIssueCountry: "IN",
    passportIssueDate: "2021-07-01",
    departmentId: engineering._id,
    designationId: seniorEm._id,
    employeeId: "ACM-4471",
    reportingManagerId: leader._id,
    costCenterId: "CC-4412",
    workLocation: "Bengaluru — HQ",
    personalEmail: "arjun.personal@example.test",
    taxResidency: "IN",
    emergencyContacts: [
      { name: "Priya Nair", relationship: "Spouse", phone: "9990001111" },
    ],
    seatPreference: "WINDOW",
    homeAirport: "BLR",
    mealPreference: "VJML",
    hotelPreferences: ["NON_SMOKING", "HIGH_FLOOR", "QUIET_ROOM"],
    loyaltyProgrammes: [
      { programmeType: "HOTEL", programmeName: "Marriott Bonvoy", membershipNumber: "MB-88213", tier: "Gold" },
    ],
    frequentFlyer: [{ airline: "AI", number: "AI9930041", tier: "Platinum" }],
    // NOTE: mobile and gender are deliberately ABSENT — see the block comment.
    createdBy: leader._id,
    updatedBy: leader._id,
    source: "MANUAL",
    isActive: true,
  } as any);

  await TravellerProfile.create({
    workspaceId: wsId,
    travelerId: nextTravelerId(),
    firstName: "Kavya",
    lastName: "Menon",
    email: COLLEAGUE_A_EMAIL,
    // No claimedBy — admin-created and never claimed.
    dob: "1989-11-02",
    gender: "Female",
    nationality: "IN",
    mobile: "9812340000",
    mobileCountryCode: "+91",
    passportNo: "P4410982",
    passportExpiry: "2029-03-14",
    departmentId: engineering._id,
    createdBy: leader._id,
    source: "MANUAL",
    isActive: true,
  } as any);

  const rohan: any = await TravellerProfile.create({
    workspaceId: wsId,
    travelerId: nextTravelerId(),
    firstName: "Rohan",
    lastName: "Desai",
    dob: "1995-06-21",
    nationality: "IN",
    createdBy: leader._id,
    source: "MANUAL",
    isActive: true,
  } as any);

  await TravellerProfile.create({
    workspaceId: wsId,
    travelerId: nextTravelerId(),
    firstName: "Sneha",
    lastName: "Kulkarni",
    email: "sneha@acme.test",
    gender: "Female",
    dob: "1987-02-09",
    nationality: "IN",
    mobile: "9800011122",
    mobileCountryCode: "+91",
    passportNo: "Z1122334",
    passportExpiry: "2032-08-19",
    passportIssueCountry: "IN",
    passportIssueDate: "2022-08-20",
    departmentId: engineering._id,
    designationId: seniorEm._id,
    employeeId: "ACM-2210",
    reportingManagerId: leader._id,
    createdBy: leader._id,
    source: "MANUAL",
    isActive: true,
  } as any);

  console.log(`[seed:dev] ${seq} traveller profiles`);

  /* ── A published visa rule, so /visa has a corridor to apply for ───────
   *
   * UPSERTED BY CORRIDOR, not created — and deliberately carries NO
   * workspaceId. VisaRule is the global Plumtrips catalogue: one row per
   * (nationality, destination, purpose, entryType, serviceTier, variantKey),
   * enforced by a unique index that has no tenant in it. So "delete this
   * workspace's rules and recreate" is not a thing that can be expressed —
   * the second seed run just collided with the first (E11000).
   *
   * Matching the exact corridor tuple keeps this rerunnable and keeps the
   * blast radius to the one row this seed owns.
   * ─────────────────────────────────────────────────────────────────── */

  const corridor = {
    nationality: "IN",
    destinationIso2: "DE",
    purpose: "TOURIST",
    entryType: "MULTIPLE",
    serviceTier: "STANDARD",
  };

  const rule: any = await VisaRule.findOneAndUpdate(
    corridor,
    {
      $set: {
        ...corridor,
        destinationName: "Germany",
        status: "PUBLISHED",
        isSchengen: true,
        productClass: "VISA",
        visaCategory: "STICKER",
        validityDays: 90,
        maxStayDays: 30,
        isExtension: false,
        etaMinDays: 10,
        etaMaxDays: 15,
        etaBasis: "BUSINESS",
        appointmentRequired: true,
        biometricsRequired: true,
        documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }],
        embassyFeeInr: 8000,
        vfsFeeInr: 2000,
        plumtripsServiceFeeInr: 2500,
        displayMode: "ITEMISED",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  /* ── One request sitting in the approval queue ──────────────────────────
   *
   * Built as documents rather than by driving the submit route: the seed has
   * no HTTP surface, and the queue reads exactly two things —
   * VisaRequest.approvalStatus === "pending_approval" and approverId. Both
   * are set here, with the snapshots the detail view needs so the row opens
   * rather than erroring.
   *
   * Raised BY the employee, routed TO the leader — the shape the approvals
   * UI is built for.
   * ─────────────────────────────────────────────────────────────────── */

  const totalInr =
    (rule.embassyFeeInr ?? 0) + (rule.vfsFeeInr ?? 0) + (rule.plumtripsServiceFeeInr ?? 0);

  const travelFrom = new Date();
  travelFrom.setDate(travelFrom.getDate() + 45);
  const travelTo = new Date(travelFrom);
  travelTo.setDate(travelTo.getDate() + 9);

  // What POST /requests/:id/submit would have written. Included because the
  // approvals card READS it (services/visaApprovalCard.service.ts reports a
  // request with no consents as blocked) — a seed that skipped it would make
  // every local row falsely read "consent not recorded".
  const seededConsents = VISA_CONSENT_CLAUSE_IDS.map((clauseId) => ({
    clauseId,
    version: CURRENT_VISA_CONSENT_VERSION,
    acceptedAt: new Date(),
    acceptedByUserId: employee._id,
  }));

  const request: any = await VisaRequest.create({
    workspaceId: wsId,
    raisedByUserId: employee._id,
    customerId: CUSTOMER_ID,
    destinationIso2: "DE",
    purpose: "TOURIST",
    travelDateFrom: travelFrom,
    travelDateTo: travelTo,
    status: "draft",
    consents: seededConsents,
    // What the queue filters on.
    approvalStatus: "pending_approval",
    approverId: leader._id,
    approvalChain: [{ level: 1, approverId: leader._id }],
    currentLevel: 1,
    submittedAt: new Date(),
  } as any);

  await VisaApplication.create({
    workspaceId: wsId,
    requestId: request._id,
    customerId: CUSTOMER_ID,
    travellerProfileId: arjun._id,
    nationality: "IN",
    status: "pending_approval",
    ruleSnapshot: {
      ruleId: rule._id,
      capturedAt: new Date(),
      destinationName: rule.destinationName,
      isSchengen: rule.isSchengen,
      productClass: rule.productClass,
      visaCategory: rule.visaCategory,
      purpose: rule.purpose,
      entryType: rule.entryType,
      serviceTier: rule.serviceTier,
      validityDays: rule.validityDays,
      maxStayDays: rule.maxStayDays,
      etaMinDays: rule.etaMinDays,
      etaMaxDays: rule.etaMaxDays,
      etaBasis: rule.etaBasis,
      appointmentRequired: rule.appointmentRequired,
      biometricsRequired: rule.biometricsRequired,
      documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }],
    },
    indicativeCostSnapshot: {
      embassyFeeInr: rule.embassyFeeInr,
      vfsFeeInr: rule.vfsFeeInr,
      plumtripsServiceFeeInr: rule.plumtripsServiceFeeInr,
      displayMode: "ITEMISED",
      totalInr,
    },
  } as any);

  /* ── A SECOND pending request, deliberately the awkward one ────────────
   *
   * The first request is the happy path: the employee filing for themselves,
   * on the roster, passport complete. Every signal on the approvals card
   * reads green there, which makes it useless for seeing what the card is
   * FOR. This one exercises the other side of each signal at once:
   *
   *   raised by KAVYA, for two OTHER people        -> filed on behalf
   *   Arjun is claimed by the employee             -> the proof it isn't self
   *   Rohan has no claim and no member link        -> OFF-ROSTER
   *   Rohan has no passport and no expiry          -> BLOCKING completeness gaps
   *
   * Raised by Kavya rather than by the leader ON PURPOSE. The seeded leader's
   * User.roles is ["CUSTOMER"] — WORKSPACE_LEADER lives on CustomerMember,
   * not on the login — so isVisaAdmin() is false for them and they are only
   * the ROUTED approver. A request they raised themselves would therefore hit
   * the segregation-of-duties rule (a non-admin may never decide their own),
   * and the one login that can see this row could not action it.
   * ─────────────────────────────────────────────────────────────────── */

  const groupFrom = new Date();
  groupFrom.setDate(groupFrom.getDate() + 21);
  const groupTo = new Date(groupFrom);
  groupTo.setDate(groupTo.getDate() + 5);

  const groupRequest: any = await VisaRequest.create({
    workspaceId: wsId,
    raisedByUserId: colleagueA._id,
    customerId: CUSTOMER_ID,
    destinationIso2: "DE",
    purpose: "TOURIST",
    travelDateFrom: groupFrom,
    travelDateTo: groupTo,
    status: "draft",
    consents: seededConsents.map((c) => ({ ...c, acceptedByUserId: colleagueA._id })),
    approvalStatus: "pending_approval",
    approverId: leader._id,
    approvalChain: [{ level: 1, approverId: leader._id }],
    currentLevel: 1,
    submittedAt: new Date(),
  } as any);

  const groupSnapshot = {
    ruleSnapshot: {
      ruleId: rule._id,
      capturedAt: new Date(),
      destinationName: rule.destinationName,
      isSchengen: rule.isSchengen,
      productClass: rule.productClass,
      visaCategory: rule.visaCategory,
      purpose: rule.purpose,
      entryType: rule.entryType,
      serviceTier: rule.serviceTier,
      validityDays: rule.validityDays,
      maxStayDays: rule.maxStayDays,
      etaMinDays: rule.etaMinDays,
      etaMaxDays: rule.etaMaxDays,
      etaBasis: rule.etaBasis,
      appointmentRequired: rule.appointmentRequired,
      biometricsRequired: rule.biometricsRequired,
      documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }],
    },
    indicativeCostSnapshot: {
      embassyFeeInr: rule.embassyFeeInr,
      vfsFeeInr: rule.vfsFeeInr,
      plumtripsServiceFeeInr: rule.plumtripsServiceFeeInr,
      displayMode: "ITEMISED" as const,
      totalInr,
    },
  };

  for (const traveller of [arjun, rohan]) {
    await VisaApplication.create({
      workspaceId: wsId,
      requestId: groupRequest._id,
      customerId: CUSTOMER_ID,
      travellerProfileId: traveller._id,
      nationality: "IN",
      status: "pending_approval",
      ...groupSnapshot,
    } as any);
  }

  console.log(
    "[seed:dev] 2 visa requests pending approval " +
      "(Arjun self-filed → Meera; Arjun+Rohan filed by Kavya, one off-roster)",
  );

  /* ── What to do next ───────────────────────────────────────────────── */

  console.log(`
──────────────────────────────────────────────────────────────
  Seeded "Acme Industries"  ·  db: ${dbName}

  WORKSPACE LEADER   ${LEADER_EMAIL}    ${PASSWORD}
    → Travellers roster, the traveller dossier with every field
      unlocked, and the Approvals queue (2 pending — one clean
      self-application, one filed-on-behalf with an off-roster
      traveller and missing passport details).

  EMPLOYEE           ${EMPLOYEE_EMAIL}  ${PASSWORD}
    → My Profile with the dossier tabs, name/org fields locked,
      and the "finish your profile" prompt (mobile + gender).

  A third login, ${COLLEAGUE_A_EMAIL}, exists with an UNCLAIMED
  profile — useful for testing the claim flow.
──────────────────────────────────────────────────────────────
`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(`\n${err?.message || err}\n`);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
