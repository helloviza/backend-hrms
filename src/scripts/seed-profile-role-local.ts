// apps/backend/src/scripts/seed-profile-role-local.ts
//
// LOCAL-ONLY fixtures for the /profile/me Admin layout (My Space Phase 2) QC.
//
//   - Refuses to run unless every MONGO_URI host is 127.0.0.1 / localhost
//     (the host is printed first, credentials never).
//   - Always writes to its own database, plumbox_profile_role, whatever
//     database the URI names.
//   - Idempotent: users are upserted by email, every other document by a
//     stable key (seedKey, or the collection's natural key). Nothing is ever
//     deleted — there is no deleteMany / drop anywhere in this file.
//
// Workspaces: the Plumtrips HOUSE workspace (with attendanceConfig: Mon–Sat,
// 09:30 + 15 min grace) and one SaaS HRMS tenant (no shift configured, so its
// "late" figures are honestly unavailable).
//
// Personas (one shared LOCAL password, printed at the end):
//   superadmin   SUPERADMIN   HOUSE  L8
//   admin        ADMIN        HOUSE  L6
//   hr           HR           HOUSE  L5
//   ops          OPS          HOUSE  L2 + Admin Queue WRITE (booking agent)
//   manager      MANAGER      HOUSE  L4
//   employee     EMPLOYEE     HOUSE  L1
//   tenantadmin  TENANT_ADMIN SaaS   L0
//   sbtonly      EMPLOYEE     HOUSE  L1, sbtEnabled + sbtRole L1 → /sbt/flights
//   plumbox      SUPERADMIN   HOUSE  L8, visibleNavGroups = Travel Analytics,
//                                    Travelbox.ai, Spendbox.ai, Helloviza.ai
//
// Run (from apps/backend, against a local mongod only):
//   MONGO_URI=mongodb://127.0.0.1:27027/plumbox_profile_role \
//     node --import tsx src/scripts/seed-profile-role-local.ts
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { LEVEL_METADATA, LEVEL_TEMPLATES } from "../config/levelTemplates.js";

const DB_NAME = "plumbox_profile_role";
const LOCAL = new Set(["127.0.0.1", "localhost"]);
export const LOCAL_PASSWORD = "LocalOnly-ProfileRole-2026";

/** Hosts named in a mongodb:// URI (credentials stripped); null if unparseable. */
export function mongoHosts(uri: string): string[] | null {
  if (!uri.startsWith("mongodb://")) return null;
  const rest = uri.slice("mongodb://".length);
  const afterCreds = rest.includes("@") ? rest.slice(rest.lastIndexOf("@") + 1) : rest;
  const hostPart = afterCreds.split(/[/?]/)[0];
  if (!hostPart) return null;
  return hostPart.split(",").map((h) => h.replace(/:\d+$/, "").trim().toLowerCase());
}

export function isLocalOnly(uri: string): boolean {
  const hosts = mongoHosts(uri);
  return !!hosts && hosts.length > 0 && hosts.every((h) => LOCAL.has(h));
}

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const SAAS = new mongoose.Types.ObjectId("6a0000000000000000000c01");

/* ───────────────────────── IST helpers ───────────────────────── */
const IST = 5.5 * 3600e3;
const istDay = (offset = 0) => {
  const d = new Date(Date.now() + IST);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
/** A Date for HH:MM IST on calendar day `day`. */
const atIst = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
const monthDay = (n: number) => `${istDay(0).slice(0, 8)}${String(n).padStart(2, "0")}`;

/* ───────────────────────── fixture people ───────────────────────── */
type Person = {
  key: string;
  first: string;
  last: string;
  dept: string;
  designation: string;
  roles: string[];
  ws: mongoose.Types.ObjectId;
  joined: string; // YYYY-MM-DD
  /** today: "ontime" | "late" | "leave" | "absent" */
  today: "ontime" | "late" | "leave" | "absent";
  level?: string;
  extraModules?: Record<string, any>;
  persona?: boolean;
  extra?: Record<string, any>;
};

const HOUSE_DEPTS = ["Operations", "Sales", "Finance", "People", "Technology"];
const SAAS_DEPTS = ["Customer Success", "Engineering"];

const PERSONAS: Person[] = [
  { key: "superadmin", first: "Sana", last: "Kapoor", dept: "Technology", designation: "Platform Owner", roles: ["SUPERADMIN"], ws: HOUSE, joined: "2020-04-01", today: "ontime", level: "L8", persona: true },
  { key: "admin", first: "Arjun", last: "Menon", dept: "Operations", designation: "Operations Admin", roles: ["ADMIN"], ws: HOUSE, joined: "2021-02-15", today: "ontime", level: "L6", persona: true },
  { key: "hr", first: "Rhea", last: "Desai", dept: "People", designation: "HR Business Partner", roles: ["HR"], ws: HOUSE, joined: "2022-07-11", today: "late", level: "L5", persona: true },
  { key: "ops", first: "Omar", last: "Shaikh", dept: "Operations", designation: "Travel Ops Executive", roles: ["OPS"], ws: HOUSE, joined: "2023-03-06", today: "ontime", level: "L2", persona: true,
    extraModules: { adminQueue: { access: "WRITE", scope: "ALL" } } },
  { key: "manager", first: "Meera", last: "Iyer", dept: "Sales", designation: "Sales Manager", roles: ["MANAGER"], ws: HOUSE, joined: "2021-09-20", today: "ontime", level: "L4", persona: true },
  { key: "employee", first: "Asha", last: "Rao", dept: "Sales", designation: "Account Executive", roles: ["EMPLOYEE"], ws: HOUSE, joined: "2024-04-01", today: "late", level: "L1", persona: true,
    // can book (SBT L1) but has no trip → the SAMPLE itinerary
    extra: { sbtRole: "L1" } },
  { key: "tenantadmin", first: "Tara", last: "Singh", dept: "Customer Success", designation: "People Lead", roles: ["TENANT_ADMIN"], ws: SAAS, joined: "2023-01-09", today: "ontime", level: "L0", persona: true },
  { key: "sbtonly", first: "Kabir", last: "Shah", dept: "Finance", designation: "Travel Requester", roles: ["EMPLOYEE"], ws: HOUSE, joined: "2025-05-12", today: "absent", level: "L1", persona: true,
    extra: { sbtEnabled: true, sbtRole: "L1" } },
  // Shaped like admin@plumtrips.com on prod (bugs a + b): SUPERADMIN, no leave
  // entitlement, attendance that swings −52.4 pts vs the previous 30 days.
  { key: "prodsa", first: "Plumtrips", last: "Owner", dept: "Technology", designation: "Super Admin", roles: ["SUPERADMIN"], ws: HOUSE, joined: "2020-01-06", today: "absent", level: "L8", persona: true },
  // Shaped like plumbox@plumtrips.com (docs/audits/nav-visible-groups-audit.md):
  // a real SUPERADMIN (L8; the HOUSE grant also sets sbtEnabled) whose Header
  // shows only Travel Analytics, Travelbox.ai, Spendbox.ai and Helloviza.ai.
  { key: "plumbox", first: "Plum", last: "Box", dept: "Technology", designation: "Demo Account", roles: ["SUPERADMIN"], ws: HOUSE, joined: "2026-11-28", today: "absent", level: "L8", persona: true,
    extra: { hrmsAccessRole: "SUPERADMIN", sbtEnabled: true, canRaiseRequest: false, visibleNavGroups: ["travelAnalytics", "travelbox", "spendbox", "helloviza"] } },
];

// 19 more HOUSE staff → 25 HOUSE in total across the 5 departments.
const HOUSE_STAFF: Array<[string, string, string, string, Person["today"], string]> = [
  ["Vikram", "Nair", "Operations", "Ops Lead", "ontime", "2019-11-04"],
  ["Priya", "Sharma", "Operations", "Ticketing Executive", "late", "2024-08-19"],
  ["Rohit", "Verma", "Operations", "Visa Executive", "ontime", "2023-06-01"],
  ["Neha", "Gupta", "Operations", "Hotel Desk", "leave", "2022-12-12"],
  ["Imtiaz", "Khan", "Operations", "Night Desk", "absent", "2025-01-06"],
  ["Divya", "Pillai", "Sales", "Key Account Manager", "ontime", "2022-03-14"],
  ["Karan", "Malhotra", "Sales", "Sales Executive", "late", "2025-10-27"],
  ["Sneha", "Kulkarni", "Sales", "Sales Executive", "ontime", "2026-11-17"],
  ["Farhan", "Ali", "Sales", "Inside Sales", "leave", "2024-02-05"],
  ["Lata", "Bose", "Finance", "Accounts Manager", "ontime", "2020-08-24"],
  ["Gaurav", "Jain", "Finance", "Billing Executive", "ontime", "2023-10-02"],
  ["Pooja", "Reddy", "Finance", "AR Executive", "absent", "2026-11-10"],
  ["Anil", "Mathew", "People", "Recruiter", "ontime", "2024-11-25"],
  ["Ritu", "Chawla", "People", "Payroll Executive", "leave", "2021-05-03"],
  ["Dev", "Patel", "Technology", "Engineering Lead", "late", "2021-01-18"],
  ["Nikhil", "Rao", "Technology", "Developer", "ontime", "2026-11-03"],
  ["Ayesha", "Siddiqui", "Technology", "QA Engineer", "ontime", "2025-07-14"],
  ["Suresh", "Kumar", "Technology", "DevOps", "absent", "2022-09-05"],
  ["Ishita", "Banerjee", "Technology", "Designer", "ontime", "2026-11-24"],
];
const SAAS_STAFF: Array<[string, string, string, string, Person["today"], string]> = [
  ["Ajay", "Kapoor", "Customer Success", "CS Manager", "ontime", "2022-04-18"],
  ["Megha", "Joshi", "Customer Success", "CS Executive", "ontime", "2025-03-03"],
  ["Rahul", "Saxena", "Engineering", "Developer", "leave", "2024-06-10"],
  ["Zoya", "Mirza", "Engineering", "Developer", "absent", "2026-11-19"],
  ["Tanmay", "Ghosh", "Engineering", "QA", "ontime", "2023-08-28"],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, "");
const emailOf = (p: Person) => (p.persona ? `${p.key}@profile-role.local` : `${slug(p.first)}.${slug(p.last)}@profile-role.local`);

const PEOPLE: Person[] = [
  ...PERSONAS,
  ...HOUSE_STAFF.map(([first, last, dept, designation, today, joined]) => ({
    key: `${slug(first)}${slug(last)}`, first, last, dept, designation, roles: ["EMPLOYEE"], ws: HOUSE, joined, today,
  })),
  ...SAAS_STAFF.map(([first, last, dept, designation, today, joined]) => ({
    key: `${slug(first)}${slug(last)}`, first, last, dept, designation, roles: ["EMPLOYEE"], ws: SAAS, joined, today,
  })),
];

/* ───────────────────────── main ───────────────────────── */

async function main() {
  const uri = process.env.MONGO_URI || "";
  const hosts = mongoHosts(uri);
  console.log(`[seed-profile-role] Mongo host(s): ${hosts ? hosts.join(", ") : "(unparseable)"}`);
  if (!isLocalOnly(uri)) {
    console.error("[seed-profile-role] REFUSING: MONGO_URI must be a mongodb:// URI on 127.0.0.1 or localhost only.");
    process.exit(1);
  }

  await mongoose.connect(uri, { dbName: DB_NAME, serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection.db!;
  if (db.databaseName !== DB_NAME) throw new Error(`connected to ${db.databaseName}, expected ${DB_NAME}`);
  console.log(`[seed-profile-role] database: ${db.databaseName}`);

  const now = new Date();
  const today = istDay(0);
  const nowIstHHMM = new Date(Date.now() + IST).toISOString().slice(11, 16);
  const col = (n: string) => db.collection(n);
  const upsert = (n: string, filter: any, set: any) =>
    col(n).updateOne(filter, { $set: { ...set, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });

  /* workspaces */
  const allOn = {
    sbtEnabled: true, approvalFlowEnabled: true, approvalDirectEnabled: true, flightBookingEnabled: true,
    hotelBookingEnabled: true, payrollEnabled: true, expensesEnabled: true, advancesEnabled: true,
    visaEnabled: true, hrmsEnabled: true, invoicesEnabled: true,
  };
  await upsert("customerworkspaces", { _id: HOUSE }, {
    customerId: "PLUMTRIPS-LOCAL", companyName: "Plumtrips (local QC)", name: "Plumtrips (local QC)", status: "ACTIVE", tenantType: "HOUSE",
    config: { travelFlow: "APPROVAL_FLOW", features: allOn, baseCurrency: "INR" },
    attendanceConfig: { workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], shiftStart: "09:30", shiftEnd: "18:30", graceMinutes: 15, halfDayHours: 4.5, minHoursForPresent: 8 },
  });
  await upsert("customerworkspaces", { _id: SAAS }, {
    customerId: "NORTHWIND-LOCAL", companyName: "Northwind HR (local QC)", name: "Northwind HR (local QC)", status: "ACTIVE", tenantType: "SAAS_HRMS",
    config: { travelFlow: "SBT", features: { ...Object.fromEntries(Object.keys(allOn).map((k) => [k, false])), hrmsEnabled: true }, baseCurrency: "INR" },
  });

  // The SaaS tenant has finished workspace setup, so its admin lands on
  // /profile/me instead of the setup wizard (router HomeIndexRoute).
  await upsert("tenantsetupprogresses", { workspaceId: SAAS }, {
    workspaceId: SAAS, tenantType: "SAAS_HRMS", currentStage: "COMPLETE", completedAt: now, firstLoginAt: now, lastActivityAt: now,
  });

  /* departments */
  for (const name of HOUSE_DEPTS) await upsert("departments", { workspaceId: HOUSE, name }, { isActive: true });
  for (const name of SAAS_DEPTS) await upsert("departments", { workspaceId: SAAS, name }, { isActive: true });

  /* users + permissions + employees */
  const passwordHash = await bcrypt.hash(LOCAL_PASSWORD, 12);
  const ids = new Map<string, mongoose.Types.ObjectId>();
  for (const p of PEOPLE) {
    const email = emailOf(p);
    await upsert("users", { email }, {
      email, workspaceId: p.ws, firstName: p.first, lastName: p.last, name: `${p.first} ${p.last}`, roles: p.roles,
      status: "ACTIVE", isActive: true, department: p.dept, designation: p.designation, dateOfJoining: p.joined,
      jobLocation: p.ws.equals(HOUSE) ? "Bengaluru" : "Gurugram", passwordHash,
      // never picked an accent → the default (orange) applies
      mySpaceAccent: "orange",
      phone: `+91 98${String(10000000 + ((p.first.length * 7919 + p.last.length * 104729) % 89999999)).slice(0, 8)}`,
      ...(p.persona && p.ws.equals(HOUSE) && p.key !== "manager" ? { managerName: "Meera Iyer" } : {}),
      ...(p.key === "tenantadmin" ? { managerName: "Ajay Kapoor" } : {}),
      ...(p.extra || {}),
    });
    const u = await col("users").findOne({ email }, { projection: { _id: 1 } });
    ids.set(p.key, u!._id as any);

    const code = p.level || "L1";
    await upsert("userpermissions", { userId: String(u!._id) }, {
      userId: String(u!._id), email, workspaceId: String(p.ws), universe: "STAFF", status: "active",
      tier: code === "L8" ? 8 : Math.max(1, Number(code.slice(1)) || 1), roleType: "EMPLOYEE",
      level: { code, name: LEVEL_METADATA.find((l) => l.code === code)?.name || (code === "L0" ? "Tenant Admin" : code), designation: p.designation },
      modules: { ...((LEVEL_TEMPLATES as any)[code] || (LEVEL_TEMPLATES as any).L1), ...(p.extraModules || {}) },
      grantedModules: [],
    });

    await upsert("employees", { workspaceId: p.ws, email }, {
      workspaceId: p.ws, ownerId: u!._id, email, name: `${p.first} ${p.last}`, fullName: `${p.first} ${p.last}`,
      department: p.dept, designation: p.designation, joiningDate: atIst(p.joined, "10:00"), isActive: true, status: "ACTIVE",
    });
  }
  // two inactive rows on the HOUSE roll (headcount total vs active)
  for (const [n, d] of [["Old Leaver", "2025-03-31"], ["Past Intern", "2026-06-30"]] as const) {
    await upsert("employees", { workspaceId: HOUSE, email: `${slug(n)}@profile-role.local` }, {
      workspaceId: HOUSE, name: n, fullName: n, department: "Operations", designation: "Former staff", joiningDate: atIst("2024-01-15", "10:00"),
      exitDate: atIst(d, "18:00"), isActive: false, status: "INACTIVE",
    });
  }

  /* today's attendance + leave */
  // On time: 09:02–09:44 (shift 09:30 + 15 min grace); late: 09:52–10:31.
  const plannedIn = (kind: "ontime" | "late", i: number) => {
    const m = kind === "ontime" ? 2 + ((i * 7) % 43) : 52 + ((i * 11) % 40);
    return `${String(9 + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  let punchedAhead = 0;
  for (const [i, p] of PEOPLE.entries()) {
    const userId = ids.get(p.key)!;
    if (p.today === "ontime" || p.today === "late") {
      let ts = atIst(today, plannedIn(p.today, i));
      // Never a punch in the future: run before the planned time and the IN
      // lands a few minutes ago instead (on time — late is then honestly 0).
      if (ts.getTime() > Date.now()) {
        ts = new Date(Date.now() - (5 + (punchedAhead++ % 40)) * 60e3);
      }
      const punches: any[] = [{ ts, type: "IN" }];
      await upsert("attendances", { userId, date: today }, { workspaceId: p.ws, userId, date: today, punches });
    }
    if (p.today === "leave") {
      await upsert("leaverequests", { seedKey: `pr-leave-today-${p.key}` }, {
        seedKey: `pr-leave-today-${p.key}`, workspaceId: p.ws, userId, type: "CL",
        from: atIst(today, "00:00"), to: atIst(today, "00:00"), days: 1, status: "APPROVED", reason: "Personal work",
      });
    }
  }

  /* pending leave (HOUSE 3, SaaS 1) */
  const pendingLeave: Array<[string, number, number, string]> = [
    ["employee", 6, 7, "Cousin's wedding"],
    ["priyasharma", 12, 12, "Medical appointment"],
    ["karanmalhotra", 20, 22, "Trip home"],
    ["meghajoshi", 9, 9, "Personal"],
  ];
  for (const [k, a, b, reason] of pendingLeave) {
    const p = PEOPLE.find((x) => x.key === k);
    if (!p) continue;
    await upsert("leaverequests", { seedKey: `pr-leave-pending-${k}` }, {
      seedKey: `pr-leave-pending-${k}`, workspaceId: p.ws, userId: ids.get(k), type: "EL",
      from: atIst(istDay(a), "00:00"), to: atIst(istDay(b), "00:00"), days: b - a + 1, status: "PENDING", reason,
    });
  }

  /* pending travel: requests approved by the customer, waiting on the Plumtrips desk */
  const travel: Array<[string, string, string]> = [
    ["TR-PR-101", "BLR → DEL", "Client review, Delhi"],
    ["TR-PR-102", "BOM → DXB", "Dubai trade fair"],
    ["TR-PR-103", "Hyderabad hotel", "Offsite stay"],
    ["TR-PR-104", "MAA → SIN", "Partner visit"],
  ];
  for (const [ticketId, title, reason] of travel) {
    await upsert("approvalrequests", { ticketId }, {
      ticketId, workspaceId: SAAS, customerId: "NORTHWIND-LOCAL", customerName: "Northwind HR (local QC)", status: "approved",
      adminState: "pending", stage: "REQUEST_APPROVED", frontlinerEmail: "megha.joshi@profile-role.local", frontlinerName: "Megha Joshi",
      managerEmail: "ajay.kapoor@profile-role.local", comments: reason,
      cartItems: [{ type: title.includes("hotel") ? "hotel" : "flight", title, qty: 1, price: 0 }],
    });
  }

  /* pending expenses (HOUSE): 2 submitted claims + 1 advance */
  for (const [ref, who, name] of [["CLM-PR-0001", "employee", "Client visit — Pune"], ["CLM-PR-0002", "divyapillai", "Mumbai roadshow"]] as const) {
    await upsert("reports", { ref }, {
      ref, workspaceId: HOUSE, employeeId: ids.get(who), name, status: "submitted", approverId: ids.get("manager"),
      approvalChain: [{ level: 1, approverId: ids.get("manager"), status: "pending" }], currentLevel: 0, submittedAt: new Date(Date.now() - 2 * 864e5),
    });
  }
  await upsert("expenseadvances", { ref: "ADV-PR-0001" }, {
    ref: "ADV-PR-0001", workspaceId: HOUSE, requesterId: ids.get("rohitverma"), amount: 15000, currency: "INR", purpose: "Visa desk float",
    status: "awaiting_approval", approverId: ids.get("admin"), approvalChain: [{ level: 1, approverId: ids.get("admin"), status: "pending" }], currentLevel: 0,
    submittedAt: new Date(Date.now() - 864e5),
  });

  /* onboarding: employee invites in every status */
  const future = new Date(Date.now() + 10 * 864e5);
  const ob: Array<[string, string, string, string]> = [
    ["pr-ob-1", "sent", "Rahul Menon", "rahul.menon@example.test"],
    ["pr-ob-2", "sent", "Fatima Sheikh", "fatima.sheikh@example.test"],
    ["pr-ob-3", "started", "Aditya Rao", "aditya.rao@example.test"],
    ["pr-ob-7", "started", "Kavya Nair", "kavya.nair@example.test"],
    ["pr-ob-4", "submitted", "Mohit Arora", "mohit.arora@example.test"],
    ["pr-ob-8", "submitted", "Leena Dsouza", "leena.dsouza@example.test"],
    ["pr-ob-5", "approved", "Tanvi Joshi", "tanvi.joshi@example.test"],
    ["pr-ob-6", "approved", "Harsh Vora", "harsh.vora@example.test"],
  ];
  for (const [token, status, inviteeName, email] of ob) {
    await upsert("onboardings", { token }, { token, workspaceId: HOUSE, type: "employee", status, email, inviteeName, expiresAt: future });
  }
  await upsert("onboardings", { token: "pr-ob-saas-1" }, { token: "pr-ob-saas-1", workspaceId: SAAS, type: "employee", status: "started", email: "neel.shah@example.test", inviteeName: "Neel Shah", expiresAt: future });

  /* bookings this month (HOUSE desk, platform-wide) */
  const day1 = monthDay(1);
  const bookingDay = (i: number) => (istDay(0) > monthDay(Math.min(1 + i * 3, 27)) ? monthDay(Math.min(1 + i * 3, 27)) : day1);
  const bookings: Array<[string, string, number, string]> = [
    ["PR-BK-1", "flight", 6480, "CONFIRMED"],
    ["PR-BK-2", "hotel", 14200, "CONFIRMED"],
    ["PR-BK-3", "flight", 38950, "CONFIRMED"],
    ["PR-BK-4", "flight", 5120, "CONFIRMED"],
    ["PR-BK-5", "hotel", 22800, "CONFIRMED"],
    ["PR-BK-6", "flight", 9100, "CANCELLED"], // never counts
  ];
  for (const [i, [reference, service, amount, status]] of bookings.entries()) {
    const d = bookingDay(i);
    await upsert("travelbookings", { reference }, {
      reference, workspaceId: SAAS, tenantId: "NORTHWIND-LOCAL", userId: ids.get("meghajoshi"),
      service, amount, status, source: "SBT", bookedAt: atIst(d, "11:00"), isActive: true,
    });
  }

  /* invoices this month (HOUSE) */
  const invoices: Array<[string, string, number]> = [
    ["PR/26-27/0001", "PAID", 48500],
    ["PR/26-27/0002", "PAID", 23600],
    ["PR/26-27/0003", "SENT", 61200],
    ["PR/26-27/0004", "DRAFT", 12950],
  ];
  for (const [i, [invoiceNo, status, grandTotal]] of invoices.entries()) {
    const d = bookingDay(i);
    await upsert("invoices", { invoiceNo }, {
      invoiceNo, workspaceId: SAAS, customerId: "NORTHWIND-LOCAL", status, grandTotal, currency: "INR",
      generatedAt: atIst(d, "12:00"), invoiceDate: atIst(d, "12:00"),
    });
  }

  /* ───────── Phase 2b: data the reference-style sections read ───────── */

  // employee@ today: in, a break, back in (open punch — the ring keeps ticking).
  const emp = ids.get("employee")!;
  const mgr = ids.get("manager")!;
  {
    const plan: Array<[string, "IN" | "OUT"]> = [["09:52", "IN"], ["13:10", "OUT"], ["13:45", "IN"]];
    const punches = plan.map(([t, type]) => ({ ts: atIst(today, t), type })).filter((p) => p.ts.getTime() <= Date.now());
    await upsert("attendances", { userId: emp, date: today }, { workspaceId: HOUSE, userId: emp, date: today, punches });
  }

  // Weekday history since January (at least six months) for employee@, manager@ and admin@ for the two Employee-layout personas
  // (≈8 % absent, ≈12 % late, a lunch break each day). Deterministic.
  const hist = (n: number, salt: number) => ((n * 2654435761 + salt) >>> 0) % 100;
  // From 1 Jan (or six months back, if earlier) — the year summary counts every working day since January.
  const startHist = (() => {
    const d = new Date(Date.now() + IST);
    d.setUTCMonth(d.getUTCMonth() - 5, 1);
    const six = d.toISOString().slice(0, 10);
    const jan = `${istDay(0).slice(0, 4)}-01-01`;
    return six < jan ? six : jan;
  })();
  let histDays = 0;
  for (const [who, salt] of [[emp, 7], [mgr, 13], [ids.get("admin")!, 21]] as const) {
    for (let off = -1; ; off--) {
      const day = istDay(off);
      if (day < startHist) break;
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const r = hist(-off, salt);
      if (r < 8) continue; // absent
      const inAt = r < 20 ? `09:${String(50 + (r % 9)).padStart(2, "0")}` : `09:${String(5 + (r % 35)).padStart(2, "0")}`;
      const outAt = `18:${String(10 + (r % 40)).padStart(2, "0")}`;
      await upsert("attendances", { userId: who, date: day }, {
        workspaceId: HOUSE, userId: who, date: day,
        punches: [
          { ts: atIst(day, inAt), type: "IN" },
          { ts: atIst(day, "13:15"), type: "OUT" },
          { ts: atIst(day, "13:50"), type: "IN" },
          { ts: atIst(day, outAt), type: "OUT" },
        ],
      });
      histDays++;
    }
  }

  // A leave approved 2 days ago (the banner) + an older sick leave (the donut).
  const leaveDay = istDay(-9);
  await upsert("leaverequests", { seedKey: "pr-leave-approved-employee" }, {
    seedKey: "pr-leave-approved-employee", workspaceId: HOUSE, userId: emp, type: "CL",
    from: atIst(istDay(-3), "00:00"), to: atIst(istDay(-3), "00:00"), days: 1, status: "APPROVED", reason: "Family function",
    history: [{ action: "APPROVED", at: new Date(Date.now() - 2 * 864e5), by: mgr }],
  });
  await upsert("leaverequests", { seedKey: "pr-leave-sick-employee" }, {
    seedKey: "pr-leave-sick-employee", workspaceId: HOUSE, userId: emp, type: "SL",
    from: atIst(leaveDay, "00:00"), to: atIst(leaveDay, "00:00"), days: 1, status: "APPROVED", reason: "Fever",
    history: [{ action: "APPROVED", at: new Date(Date.now() - 20 * 864e5), by: mgr }],
  });

  // Leave balances this year (employee@ confirmed; three staff on probation).
  const year = Number(today.slice(0, 4));
  const bal = (cl: number[], sl: number[], el: number[]) => ({
    CL: { entitled: cl[0], accrued: cl[0], used: cl[1], pending: cl[2], adjusted: 0 },
    SL: { entitled: sl[0], accrued: sl[0], used: sl[1], pending: sl[2], adjusted: 0 },
    EL: { entitled: el[0], accrued: el[0], used: el[1], pending: el[2], adjusted: 0, carriedForward: 0 },
  });
  const ev = { BEREAVEMENT: { occurrences: 0, daysUsed: 0 }, PATERNITY: { occurrences: 0, daysUsed: 0 } };
  for (const [k, confirmed, b] of [
    ["employee", true, bal([8, 3, 0], [6, 1, 0], [12, 2, 2])],
    ["manager", true, bal([8, 4, 0], [6, 0, 0], [15, 6, 0])],
    ["snehakulkarni", false, bal([4, 0, 0], [3, 0, 0], [0, 0, 0])],
    ["nikhilrao", false, bal([4, 0, 0], [3, 0, 0], [0, 0, 0])],
    ["ishitabanerjee", false, bal([4, 0, 0], [3, 0, 0], [0, 0, 0])],
  ] as const) {
    const uid = ids.get(k);
    if (!uid) continue;
    await upsert("leavebalances", { userId: uid, year }, {
      workspaceId: HOUSE, userId: uid, year, isConfirmed: confirmed, balances: b, eventLeaves: ev,
      ...(confirmed ? {} : { probationEndDate: atIst(istDay(80), "00:00") }),
    });
  }

  // A published payslip with loss of pay (Loss of Pay figure).
  const lastMonth = (() => {
    const d = new Date(Date.now() + IST);
    d.setUTCMonth(d.getUTCMonth() - 1, 1);
    return d.toISOString().slice(0, 7);
  })();
  await upsert("payslips", { userId: emp, month: lastMonth, workspaceId: HOUSE }, {
    workspaceId: HOUSE, userId: emp, month: lastMonth, status: "PUBLISHED", payrollRunId: new mongoose.Types.ObjectId("6a0000000000000000000d01"),
    attendance: { lopDays: 1 },
  });

  // employee@'s travel requests (My Travel Requests).
  const myTrips: Array<[string, string, string, number, string, string | null]> = [
    ["TR-PR-201", "Mumbai — client workshop", "flight", 12, "pending", null],
    ["TR-PR-202", "Delhi — partner review", "flight", 20, "approved", "assigned"],
    ["TR-PR-203", "Goa — offsite stay", "hotel", -14, "approved", "done"],
  ];
  for (const [ticketId, title, type, inDays, status, adminState] of myTrips) {
    await upsert("approvalrequests", { ticketId }, {
      ticketId, workspaceId: HOUSE, customerId: "PLUMTRIPS-LOCAL", status, adminState,
      stage: status === "pending" ? "REQUEST_RAISED" : "REQUEST_APPROVED",
      frontlinerId: String(emp), frontlinerEmail: "employee@profile-role.local", frontlinerName: "Asha Rao",
      managerEmail: "manager@profile-role.local", managerName: "Meera Iyer",
      cartItems: [{ type, title, qty: 1, price: 0, meta: type === "hotel" ? { checkIn: istDay(inDays) } : { departDate: istDay(inDays) } }],
    });
  }

  // Tasks (HOUSE): employee@'s own and admin@'s To Do.
  const tasks: Array<[string, string, string, string, number | null]> = [
    ["pr-task-1", "employee", "Submit Q4 travel receipts", "OPEN", 2],
    ["pr-task-2", "employee", "Update passport copy in Documents", "IN_PROGRESS", 5],
    ["pr-task-3", "employee", "Complete Learning Hub module 3", "DONE", null],
    ["pr-task-4", "employee", "Share client feedback notes", "OPEN", 9],
    ["pr-task-5", "admin", "Review November invoices", "OPEN", 1],
    ["pr-task-6", "admin", "Approve holiday calendar 2027", "IN_PROGRESS", 4],
    ["pr-task-7", "admin", "Renew vendor contracts", "OPEN", 12],
  ];
  for (const [seedKey, who, title, status, due] of tasks) {
    await upsert("tasks", { seedKey }, {
      seedKey, workspaceId: String(HOUSE), title, status, priority: status === "IN_PROGRESS" ? "HIGH" : "MEDIUM", isActive: true,
      assignedTo: ids.get(who), createdBy: ids.get("admin"), ...(due === null ? {} : { dueDate: atIst(istDay(due), "18:00") }),
    });
  }

  // Manual bookings this month → Top Performer (top booker).
  const mbs: Array<[string, string, string]> = [
    ["MB-PR-0001", "ops", "CONFIRMED"], ["MB-PR-0002", "ops", "INVOICED"], ["MB-PR-0003", "ops", "CONFIRMED"],
    ["MB-PR-0004", "vikramnair", "CONFIRMED"], ["MB-PR-0005", "vikramnair", "PENDING"],
  ];
  for (const [i, [bookingRef, who, status]] of mbs.entries()) {
    const d = bookingDay(i);
    await upsert("manualbookings", { bookingRef }, {
      bookingRef, workspaceId: SAAS, assignPerson: ids.get(who), createdBy: ids.get(who), status, type: "FLIGHT",
      bookingDate: atIst(d, "12:00"),
    });
  }

  /* ───────── Rebuild 3: v3 content needs ───────── */

  // admin@ approves 6 expense claims (section C "Needs your action").
  const adminId = ids.get("admin")!;
  const claimants = ["divyapillai", "gauravjain", "rohitverma", "priyasharma", "anilmathew", "nikhilrao"];
  const claimNames = ["Client lunch — Indiranagar", "Airport cabs", "Visa courier fees", "Team offsite snacks", "Recruiting event", "Laptop bag"];
  for (const [i, who] of claimants.entries()) {
    const ref = `CLM-PR-${1001 + i}`;
    const rid = ids.get(who)!;
    await upsert("reports", { ref }, {
      ref, workspaceId: HOUSE, employeeId: rid, name: claimNames[i], status: "submitted", approverId: adminId,
      approvalChain: [{ level: 1, approverId: adminId, status: "pending" }], currentLevel: 0, submittedAt: new Date(Date.now() - (i + 1) * 3600e3 * 5),
    });
    const rep = await col("reports").findOne({ ref }, { projection: { _id: 1 } });
    const amt = [1850, 1240, 3600, 2150, 4800, 2799][i];
    await upsert("expenses", { seedKey: `pr-exp-${ref}` }, {
      seedKey: `pr-exp-${ref}`, workspaceId: HOUSE, employeeId: rid, reportId: rep!._id, amount: amt, currency: "INR", amountBase: amt,
      date: atIst(istDay(-2 - i), "13:00"), lifecycleStatus: "awaiting_approval", merchant: claimNames[i],
    });
  }

  // admin@ has a real upcoming trip (itinerary boarding pass); employee@ has none (SAMPLE).
  {
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
    await upsert("sbtbookings", { bookingId: "PR-SBT-1" }, {
      bookingId: "PR-SBT-1", pnr: "PR7K2M", workspaceId: HOUSE, userId: adminId, status: "CONFIRMED", ticketingStatus: "TICKETED",
      origin: { code: "BLR", city: "Bengaluru" }, destination: { code: "BOM", city: "Mumbai" }, airlineCode: "6E", airlineName: "IndiGo", flightNumber: "2802",
      cabin: 2, baseFare: 4800, totalFare: 5620, currency: "INR", passengers: [{ firstName: "Arjun", lastName: "Menon", isLead: true }],
      paymentMode: "official", isDemo: false, departureTime: `${fut}T18:25:00`, arrivalTime: `${fut}T20:30:00`, raw, bookedAt: new Date(Date.now() - 4 * 864e5),
    });
    await upsert("sbthotelbookings", { bookingId: "PR-SBT-H1" }, {
      bookingId: "PR-SBT-H1", workspaceId: HOUSE, userId: adminId, status: "CONFIRMED", hotelName: "Harbour View Hotel", cityName: "Mumbai",
      checkIn: fut, checkOut: istDay(14), confirmationNo: "HV-PR-1", isDemo: false,
    });
  }

  // prodsa@ — the prod account's shape: zero-entitlement leave balance (bug b)…
  const prodsa = ids.get("prodsa")!;
  await upsert("leavebalances", { userId: prodsa, year }, {
    workspaceId: HOUSE, userId: prodsa, year, isConfirmed: true,
    balances: { CL: { entitled: 0, accrued: 0, used: 0, pending: 0, adjusted: 0 }, SL: { entitled: 0, accrued: 0, used: 0, pending: 0, adjusted: 0 }, EL: { entitled: 0, accrued: 0, used: 0, pending: 0, adjusted: 0, carriedForward: 0 } },
    eventLeaves: ev,
  });
  // …and attendance that drops from 18 of the previous window's weekdays to 7 of this one's (bug a).
  {
    const weekdays = (fromOff: number, toOff: number) => {
      const out: string[] = [];
      for (let o = fromOff; o <= toOff; o++) {
        const d = istDay(o);
        const w = new Date(`${d}T00:00:00Z`).getUTCDay();
        if (w !== 0 && w !== 6) out.push(d);
      }
      return out;
    };
    const prevDays = weekdays(-59, -30);
    const curDays = weekdays(-29, -1);
    const mark = async (days: string[]) => {
      for (const d of days)
        await upsert("attendances", { userId: prodsa, date: d }, {
          workspaceId: HOUSE, userId: prodsa, date: d,
          punches: [{ ts: atIst(d, "09:20"), type: "IN" }, { ts: atIst(d, "18:10"), type: "OUT" }],
        });
    };
    await mark(prevDays.slice(0, 18));
    await mark(curDays.slice(0, 7));
    console.log(`[seed-profile-role] prodsa attendance: previous window 18/${prevDays.length} weekdays, current 7/${curDays.length} (+ today unpunched)`);
  }

  /* summary */
  const count = (n: string, f: any) => col(n).countDocuments(f);
  console.log(`[seed-profile-role] IST today ${today}, now ${nowIstHHMM} IST${punchedAhead ? ` — ${punchedAhead} planned punch(es) were in the future and landed just before now (on time)` : ""}`);
  console.log(`[seed-profile-role] HOUSE users ${await count("users", { workspaceId: HOUSE })}, SaaS users ${await count("users", { workspaceId: SAAS })}, employees ${await count("employees", {})}`);
  console.log(`[seed-profile-role] history days ${histDays}, attendance today ${await count("attendances", { date: today })}, pending leave ${await count("leaverequests", { status: "PENDING" })}, onboarding ${await count("onboardings", {})}, bookings ${await count("travelbookings", {})}, invoices ${await count("invoices", {})}`);
  console.log("\nPersonas (LOCAL ONLY) — password for all:", LOCAL_PASSWORD);
  for (const p of PERSONAS) console.log(`  ${p.key.padEnd(12)} ${emailOf(p).padEnd(36)} ${p.roles.join(",").padEnd(13)} ${p.ws.equals(HOUSE) ? "HOUSE" : "SaaS "} ${p.level}`);
  await mongoose.disconnect();
}

// Runs when executed directly; importing it (tests) only loads the helpers.
if (process.argv[1]?.includes("seed-profile-role-local")) {
  main().catch(async (e) => {
    console.error(e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
