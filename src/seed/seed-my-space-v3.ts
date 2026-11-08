// apps/backend/src/seed/seed-my-space-v3.ts
//
// LOCAL-ONLY fixtures for My Space v3 QC (docs/design/my-space-v3/build-plan.md §5).
// Refuses to run unless MONGO_URI points at 127.0.0.1/localhost. Idempotent:
// every document it writes carries seedTag "my-space-v3" in a dedicated DB
// and is deleted + recreated on each run.
//
// Personas (all password-less; the script mints access + refresh JWTs):
//   traveller   Asha Rao      EMPLOYEE L1, WS_A — future flight + hotel, attendance, leave, docs, expenses
//   notrip      Rohan Mehta   HR L5, WS_A       — no trips (SAMPLE ticket), can book
//   approver    Meera Iyer    MANAGER L4+people WRITE, WS_A — one pending item per approval source
//   nonapprover Kabir Shah    EMPLOYEE L7 (MIS, no people module), WS_A — H5: no Edit button
//   noexpenses  Tara Singh    EMPLOYEE L1, WS_B (SAAS_HRMS, expenses/flights off)
//
// Run:  MONGO_URI=mongodb://127.0.0.1:27017/myspace_v3_qc \
//       node --env-file=.env.development --import tsx src/seed/seed-my-space-v3.ts <tokens.json>
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { writeFileSync } from "node:fs";
import { LEVEL_TEMPLATES } from "../config/levelTemplates.js";

const uri = process.env.MONGO_URI || "";
const host = (() => {
  try {
    return new URL(uri.replace(/^mongodb(\+srv)?:\/\//, "http://")).hostname;
  } catch {
    return "";
  }
})();
console.log(`[seed-my-space-v3] target: ${uri.replace(/\/\/[^@]*@/, "//***@")}`);
if (!["127.0.0.1", "localhost"].includes(host)) {
  console.error("[seed-my-space-v3] REFUSING: MONGO_URI is not local.");
  process.exit(1);
}
const outFile = process.argv[2];
if (!outFile) {
  console.error("usage: seed-my-space-v3.ts <tokens-out.json>");
  process.exit(1);
}

const TAG = "my-space-v3";
const oid = () => new mongoose.Types.ObjectId();

// Fixed ids so re-runs keep the same identities (and minted tokens stay valid).
const WS_A = new mongoose.Types.ObjectId("6a0000000000000000000a01");
const WS_B = new mongoose.Types.ObjectId("6a0000000000000000000b01");
const U = {
  traveller: new mongoose.Types.ObjectId("6a0000000000000000001001"),
  notrip: new mongoose.Types.ObjectId("6a0000000000000000001002"),
  approver: new mongoose.Types.ObjectId("6a0000000000000000001003"),
  nonapprover: new mongoose.Types.ObjectId("6a0000000000000000001004"),
  noexpenses: new mongoose.Types.ObjectId("6a0000000000000000001005"),
};

const istDay = (offset: number) => {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const dow = (s: string) => new Date(`${s}T00:00:00Z`).getUTCDay();

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  console.log(`[seed-my-space-v3] connected db=${db.databaseName}`);

  const cols = [
    "customerworkspaces", "users", "userpermissions", "employees", "attendances", "leaverequests",
    "leavebalances", "leavepolicies", "holidays", "documents", "expenses", "reports", "expenseadvances",
    "visarequests", "approvalrequests", "proposals", "sbtrequests", "sbtbookings", "sbthotelbookings",
  ];
  for (const c of cols) await db.collection(c).deleteMany({ seedTag: TAG });

  const now = new Date();
  const T = { seedTag: TAG };
  const allOn = {
    sbtEnabled: true, approvalFlowEnabled: true, approvalDirectEnabled: true, flightBookingEnabled: true,
    hotelBookingEnabled: true, payrollEnabled: true, expensesEnabled: true, advancesEnabled: true,
    visaEnabled: true, hrmsEnabled: true,
  };
  await db.collection("customerworkspaces").insertMany([
    // APPROVAL_FLOW + Meera as a default approver: the travel-request / proposal
    // inboxes (requireTravelMode, requestDeciders / proposalDeciders) — which
    // My Space mirrors — only list requests for an approver of such a workspace.
    { _id: WS_A, ...T, customerId: "MSQC-A", companyName: "Lumen Logistics (QC)", status: "ACTIVE", tenantType: "HOUSE",
      defaultApproverEmails: ["meera.iyer@msqc.test"],
      config: { travelFlow: "APPROVAL_FLOW", features: allOn, baseCurrency: "INR" }, createdAt: now, updatedAt: now },
    { _id: WS_B, ...T, customerId: "MSQC-B", companyName: "Northwind HR (QC)", status: "ACTIVE", tenantType: "SAAS_HRMS",
      config: { travelFlow: "SBT", features: { ...Object.fromEntries(Object.keys(allOn).map((k) => [k, false])), hrmsEnabled: true }, baseCurrency: "INR" },
      createdAt: now, updatedAt: now },
  ] as any);

  const base = (id: any, ws: any, email: string, name: string, roles: string[], extra: any = {}) => ({
    _id: id, ...T, workspaceId: ws, email, name, roles, status: "ACTIVE", isActive: true, createdAt: now, updatedAt: now, ...extra,
  });
  await db.collection("users").insertMany([
    base(U.traveller, WS_A, "asha.rao@msqc.test", "Asha Rao", ["EMPLOYEE"], {
      officialEmail: "asha.rao@lumen-qc.test", phone: "+91 98450 11223", department: "Operations", designation: "Travel Operations Lead",
      jobLocation: "Bengaluru", employeeCode: "LUM-0142", dateOfJoining: "2024-04-01", managerName: "Meera Iyer",
      passportExpiry: "2031-03-14", sbtRole: "L1", mySpaceAccent: "black",
    }),
    base(U.notrip, WS_A, "rohan.mehta@msqc.test", "Rohan Mehta", ["HR"], {
      phone: "+91 98201 33445", department: "People", jobLocation: "Mumbai", employeeCode: "LUM-0077", dateOfJoining: "2023-09-11",
      sbtRole: "L1", mySpaceAccent: "navy",
    }),
    base(U.approver, WS_A, "meera.iyer@msqc.test", "Meera Iyer", ["MANAGER"], {
      phone: "+91 99000 55667", department: "Operations", designation: "Head of Operations", jobLocation: "Bengaluru",
      employeeCode: "LUM-0009", dateOfJoining: "2021-01-18", managerName: "Vikram Nair", sbtRole: "L2", mySpaceAccent: "plum",
    }),
    base(U.nonapprover, WS_A, "kabir.shah@msqc.test", "Kabir Shah", ["EMPLOYEE"], {
      department: "Finance", designation: "MIS Analyst", jobLocation: "Pune", employeeCode: "LUM-0210", dateOfJoining: "2025-06-02",
    }),
    base(U.noexpenses, WS_B, "tara.singh@msqc.test", "Tara Singh", ["EMPLOYEE"], {
      phone: "+91 98111 22334", department: "Customer Success", jobLocation: "Gurugram", employeeCode: "NW-031",
      dateOfJoining: "2025-02-17", managerName: "Ajay Kapoor",
    }),
  ] as any);

  const perm = (userId: any, email: string, ws: any, code: string, name: string, extraModules: any = {}) => ({
    ...T, userId: String(userId), email, workspaceId: String(ws), universe: "STAFF", status: "active", tier: 1, roleType: "EMPLOYEE",
    level: { code, name, designation: "" }, modules: { ...(LEVEL_TEMPLATES as any)[code], ...extraModules }, grantedModules: [],
    createdAt: now, updatedAt: now,
  });
  await db.collection("userpermissions").insertMany([
    perm(U.traveller, "asha.rao@msqc.test", WS_A, "L1", "Employee"),
    perm(U.notrip, "rohan.mehta@msqc.test", WS_A, "L5", "HR"),
    perm(U.approver, "meera.iyer@msqc.test", WS_A, "L4", "Manager", { people: { access: "WRITE", scope: "TEAM" } }),
    perm(U.nonapprover, "kabir.shah@msqc.test", WS_A, "L7", "MIS / Reporting"),
    perm(U.noexpenses, "tara.singh@msqc.test", WS_B, "L1", "Employee"),
  ] as any);

  // Reporting line: Asha + Kabir report to Meera (Employee id-space).
  const empMeera = oid();
  await db.collection("employees").insertMany([
    { _id: empMeera, ...T, workspaceId: WS_A, ownerId: U.approver, name: "Meera Iyer", email: "meera.iyer@msqc.test" },
    { _id: oid(), ...T, workspaceId: WS_A, ownerId: U.traveller, managerId: empMeera, name: "Asha Rao", email: "asha.rao@msqc.test" },
    { _id: oid(), ...T, workspaceId: WS_A, ownerId: U.nonapprover, managerId: empMeera, name: "Kabir Shah", email: "kabir.shah@msqc.test" },
  ] as any);

  // Holidays (WS_A): one inside the 30-day window, the next upcoming one.
  const holidayInWindow = (() => {
    for (let i = -12; i > -26; i--) {
      const d = istDay(i);
      if (dow(d) >= 1 && dow(d) <= 5) return d;
    }
    return istDay(-14);
  })();
  await db.collection("holidays").insertMany([
    { ...T, workspaceId: WS_A, date: holidayInWindow, name: "Dussehra", type: "GENERAL" },
    { ...T, workspaceId: WS_A, date: istDay(16), name: "Guru Nanak Jayanti", type: "GENERAL" },
    { ...T, workspaceId: WS_B, date: istDay(30), name: "Christmas", type: "GENERAL" },
  ] as any);

  // Asha's attendance: weekday punches for 30 days, minus one absent day,
  // minus 2 days of approved leave, plus one weekend punch (not counted).
  const leaveDays: string[] = [];
  for (let i = -8; i > -20 && leaveDays.length < 2; i--) {
    const d = istDay(i);
    if (dow(d) >= 1 && dow(d) <= 5 && d !== holidayInWindow) leaveDays.unshift(d);
  }
  const absentDay = (() => {
    for (let i = -3; i > -8; i--) {
      const d = istDay(i);
      if (dow(d) >= 1 && dow(d) <= 5) return d;
    }
    return istDay(-4);
  })();
  const att: any[] = [];
  let weekendPunched = false;
  for (let i = -29; i <= -1; i++) {
    const d = istDay(i);
    const wk = dow(d) === 0 || dow(d) === 6;
    if (wk && !weekendPunched) {
      weekendPunched = true;
    } else if (wk || d === absentDay || leaveDays.includes(d) || d === holidayInWindow) continue;
    att.push({ ...T, workspaceId: WS_A, userId: U.traveller, date: d,
      punches: [{ ts: new Date(`${d}T03:45:00Z`), type: "IN" }, { ts: new Date(`${d}T12:50:00Z`), type: "OUT" }] });
  }
  // Kabir: a pending attendance regularisation (waits on Meera).
  const kabirDay = absentDay;
  att.push({ ...T, workspaceId: WS_A, userId: U.nonapprover, date: kabirDay, punches: [],
    odRequests: [{ _id: oid(), reason: "Client site visit", from: "09:30", to: "18:00", status: "PENDING", requestedAt: new Date() }] });
  // Tara: a few punches.
  for (let i = -6; i <= -1; i++) {
    const d = istDay(i);
    if (dow(d) >= 1 && dow(d) <= 5)
      att.push({ ...T, workspaceId: WS_B, userId: U.noexpenses, date: d, punches: [{ ts: new Date(`${d}T04:00:00Z`), type: "IN" }] });
  }
  await db.collection("attendances").insertMany(att);

  await db.collection("leaverequests").insertMany([
    { ...T, workspaceId: WS_A, userId: U.traveller, type: "CL", from: new Date(`${leaveDays[0]}T00:00:00Z`), to: new Date(`${leaveDays[leaveDays.length - 1]}T00:00:00Z`),
      days: leaveDays.length, status: "APPROVED", reason: "Family function", createdAt: new Date(Date.now() - 20 * 864e5) },
    // pending — waits on Meera (Asha's manager)
    { ...T, workspaceId: WS_A, userId: U.traveller, type: "EL", from: new Date(`${istDay(25)}T00:00:00Z`), to: new Date(`${istDay(27)}T00:00:00Z`),
      days: 3, status: "PENDING", reason: "Trip home", createdAt: new Date(Date.now() - 2 * 864e5) },
  ] as any);

  const year = Number(istDay(0).slice(0, 4));
  const bal = (cl: number[], sl: number[], el: number[], cf = 0) => ({
    CL: { entitled: cl[0], accrued: cl[0], used: cl[1], pending: cl[2], adjusted: 0 },
    SL: { entitled: sl[0], accrued: sl[0], used: sl[1], pending: sl[2], adjusted: 0 },
    EL: { entitled: el[0], accrued: el[0], used: el[1], pending: el[2], adjusted: 0, carriedForward: cf },
  });
  const ev = { BEREAVEMENT: { occurrences: 0, daysUsed: 0 }, PATERNITY: { occurrences: 0, daysUsed: 0 } };
  await db.collection("leavebalances").insertMany([
    { ...T, workspaceId: WS_A, userId: U.traveller, year, isConfirmed: true, joinDate: new Date("2024-04-01"), balances: bal([9, 4, 0], [6, 1, 0], [18, 5, 3], 4), eventLeaves: ev },
    { ...T, workspaceId: WS_A, userId: U.notrip, year, isConfirmed: true, joinDate: new Date("2023-09-11"), balances: bal([9, 2, 0], [6, 0, 0], [18, 9, 0]), eventLeaves: ev },
    { ...T, workspaceId: WS_A, userId: U.approver, year, isConfirmed: true, joinDate: new Date("2021-01-18"), balances: bal([9, 6, 0], [6, 2, 0], [18, 12, 0], 10), eventLeaves: ev },
    { ...T, workspaceId: WS_A, userId: U.nonapprover, year, isConfirmed: false, probationEndDate: new Date(`${istDay(40)}T00:00:00Z`), joinDate: new Date("2025-06-02"), balances: bal([6, 1, 0], [6, 0, 0], [12, 0, 0]), eventLeaves: ev },
    { ...T, workspaceId: WS_B, userId: U.noexpenses, year, isConfirmed: true, joinDate: new Date("2025-02-17"), balances: bal([9, 3, 0], [6, 1, 0], [15, 2, 0]), eventLeaves: ev },
  ] as any);

  await db.collection("documents").insertMany([
    { ...T, workspaceId: WS_A, userId: U.traveller, uploadedBy: U.traveller, category: "IDENTITY", name: "PAN card", key: "qc/pan.pdf", verificationStatus: "VERIFIED", createdAt: now },
    { ...T, workspaceId: WS_A, userId: U.traveller, uploadedBy: U.notrip, category: "EMPLOYMENT", name: "Offer letter", key: "qc/offer.pdf", verificationStatus: "VERIFIED", createdAt: now },
    { ...T, workspaceId: WS_A, userId: U.traveller, uploadedBy: U.traveller, category: "IDENTITY", name: "Passport", key: "qc/passport.pdf", verificationStatus: "PENDING", createdAt: now },
  ] as any);

  // Expenses: Asha's own (this month) + a claim waiting on Meera.
  const thisMonth = new Date(`${istDay(0).slice(0, 8)}02T06:00:00Z`);
  const claimId = oid();
  await db.collection("reports").insertOne({
    _id: claimId, ...T, workspaceId: WS_A, employeeId: U.traveller, name: "Client visit — Pune", ref: "CLM-QC-0007", status: "submitted",
    approverId: U.approver, approvalChain: [{ level: 1, approverId: U.approver, status: "pending" }], currentLevel: 0,
    submittedAt: new Date(Date.now() - 3 * 864e5), createdAt: now, updatedAt: now,
  } as any);
  await db.collection("expenses").insertMany([
    { ...T, workspaceId: WS_A, employeeId: U.traveller, reportId: claimId, amount: 4200, currency: "INR", amountBase: 4200, date: thisMonth, lifecycleStatus: "awaiting_approval", merchant: "Cab", createdAt: now },
    { ...T, workspaceId: WS_A, employeeId: U.traveller, reportId: claimId, amount: 1850, currency: "INR", amountBase: 1850, date: thisMonth, lifecycleStatus: "awaiting_approval", merchant: "Meals", createdAt: now },
    { ...T, workspaceId: WS_A, employeeId: U.traveller, amount: 960, currency: "INR", amountBase: 960, date: thisMonth, lifecycleStatus: "pending_to_submit", merchant: "Parking", createdAt: now },
  ] as any);
  await db.collection("expenseadvances").insertOne({
    ...T, workspaceId: WS_A, requesterId: U.nonapprover, ref: "ADV-QC-0003", amount: 15000, currency: "INR", purpose: "Audit travel float",
    status: "awaiting_approval", approverId: U.approver, approvalChain: [{ level: 1, approverId: U.approver, status: "pending" }], currentLevel: 0,
    submittedAt: new Date(Date.now() - 1 * 864e5), createdAt: now, updatedAt: now,
  } as any);
  await db.collection("visarequests").insertOne({
    ...T, workspaceId: WS_A, raisedByUserId: U.traveller, referenceNumber: "HV26-QC0001", destinationIso2: "SG", purpose: "business",
    travelDateFrom: new Date(`${istDay(35)}T00:00:00Z`), travelDateTo: new Date(`${istDay(40)}T00:00:00Z`),
    approvalStatus: "pending_approval", approverId: U.approver, submittedAt: new Date(Date.now() - 4 * 864e5), createdAt: now, updatedAt: now,
  } as any);

  // Travel request + proposal, both with Meera as L2 approver (managerEmail).
  const arId = oid();
  await db.collection("approvalrequests").insertOne({
    _id: arId, ...T, workspaceId: WS_A, customerId: "MSQC-A", status: "pending", stage: "REQUEST_RAISED",
    frontlinerId: String(U.nonapprover), frontlinerEmail: "kabir.shah@msqc.test", frontlinerName: "Kabir Shah",
    managerEmail: "meera.iyer@msqc.test", managerName: "Meera Iyer", ticketId: "TR-QC-11",
    cartItems: [{ type: "flight", title: "PNQ → DEL audit visit", qty: 1, price: 0 }], createdAt: new Date(Date.now() - 5 * 864e5), updatedAt: now,
  } as any);
  const ar2 = oid();
  await db.collection("approvalrequests").insertOne({
    _id: ar2, ...T, workspaceId: WS_A, customerId: "MSQC-A", status: "approved", stage: "REQUEST_APPROVED",
    frontlinerId: String(U.traveller), frontlinerEmail: "asha.rao@msqc.test", frontlinerName: "Asha Rao",
    managerEmail: "meera.iyer@msqc.test", ticketId: "TR-QC-09", cartItems: [{ type: "hotel", title: "Hyderabad offsite stay" }],
    createdAt: new Date(Date.now() - 9 * 864e5), updatedAt: now,
  } as any);
  await db.collection("proposals").insertOne({
    ...T, workspaceId: WS_A, requestId: ar2, status: "SUBMITTED", title: "Hyderabad offsite — option set", currency: "INR", totalAmount: 38200,
    approvals: { l2: { decision: "PENDING" }, l0: { decision: "PENDING" } }, options: [], createdAt: new Date(Date.now() - 2 * 864e5), updatedAt: new Date(Date.now() - 2 * 864e5),
  } as any);
  await db.collection("sbtrequests").insertOne({
    ...T, workspaceId: WS_A, customerId: "MSQC-A", requesterId: U.traveller, assignedBookerId: U.approver, type: "flight", status: "PENDING",
    searchParams: { origin: "BLR", destination: "HYD" }, selectedOption: { Fare: { TotalFare: 6480, Currency: "INR" } },
    requestedAt: new Date(Date.now() - 1 * 864e5), createdAt: now, updatedAt: now,
  } as any);

  // Asha's flights: a FUTURE confirmed one (must show) and a PAST confirmed one
  // created more recently (must NOT show — audit H2).
  const fut = istDay(12);
  const raw = {
    Response: { Response: { FlightItinerary: {
      Segments: [{
        Origin: { Airport: { AirportCode: "BLR", AirportName: "Kempegowda International Airport", Terminal: "1", CityName: "Bengaluru" } },
        Destination: { Airport: { AirportCode: "BOM", AirportName: "Chhatrapati Shivaji Maharaj International Airport", Terminal: "2", CityName: "Mumbai" } },
        Duration: 125, Baggage: "15 KG", CabinBaggage: "7 KG",
      }],
      Passenger: [{ IsLeadPax: true, SeatDynamic: [{ Code: "12A" }] }],
    } } },
  };
  const flight = (over: any) => ({
    ...T, workspaceId: WS_A, userId: U.traveller, status: "CONFIRMED", origin: { code: "BLR", city: "Bengaluru" },
    destination: { code: "BOM", city: "Mumbai" }, airlineCode: "6E", airlineName: "IndiGo", flightNumber: "2802", cabin: 2,
    baseFare: 4800, totalFare: 5620, currency: "INR", passengers: [{ firstName: "Asha", lastName: "Rao", isLead: true }],
    paymentMode: "official", isDemo: false, ...over,
  });
  await db.collection("sbtbookings").insertMany([
    flight({ pnr: "QC7K2M", bookingId: "QC-B1", departureTime: `${fut}T18:25:00`, arrivalTime: `${fut}T20:30:00`, ticketingStatus: "TICKETED", raw,
      createdAt: new Date(Date.now() - 10 * 864e5), bookedAt: new Date(Date.now() - 10 * 864e5) }),
    flight({ pnr: "QCPAST", bookingId: "QC-B0", origin: { code: "BOM", city: "Mumbai" }, destination: { code: "BLR", city: "Bengaluru" },
      departureTime: `${istDay(-9)}T07:10:00`, arrivalTime: `${istDay(-9)}T08:55:00`, ticketingStatus: "TICKETED", createdAt: now, bookedAt: now }),
  ] as any);
  await db.collection("sbthotelbookings").insertOne({
    ...T, workspaceId: WS_A, userId: U.traveller, status: "CONFIRMED", hotelName: "Harbour View Hotel", cityName: "Mumbai",
    checkIn: fut, checkOut: istDay(15), bookingId: "QC-H1", confirmationNo: "HV-QC-1", isDemo: false, createdAt: now,
  } as any);

  // Tokens
  const sec = process.env.JWT_SECRET!;
  const rsec = process.env.JWT_REFRESH_SECRET!;
  const users = await db.collection("users").find({ seedTag: TAG }).toArray();
  const tokens: Record<string, any> = {};
  for (const [persona, id] of Object.entries(U)) {
    const u: any = users.find((x) => String(x._id) === String(id));
    tokens[persona] = {
      email: u.email,
      access: jwt.sign({ sub: String(u._id), roles: u.roles, email: u.email, workspaceId: String(u.workspaceId) }, sec, { expiresIn: "12h" }),
      refresh: jwt.sign({ sub: String(u._id) }, rsec, { expiresIn: "7d" }),
    };
  }
  writeFileSync(outFile, JSON.stringify(tokens, null, 2));
  console.log(`[seed-my-space-v3] seeded ${Object.keys(U).length} personas; tokens → ${outFile}`);
  console.log(`[seed-my-space-v3] holidayInWindow=${holidayInWindow} leave=${leaveDays.join(",")} absent=${absentDay} futureFlight=${fut}`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
