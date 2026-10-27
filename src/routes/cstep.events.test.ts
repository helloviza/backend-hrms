// apps/backend/src/routes/cstep.events.test.ts
//
// CSTEP Event Master (#15) — routes/cstep.events.ts, the "Related to an
// event?" tag on all four intake forms (routes/cstep.ts
// applyEventSelection), the Travel Register's event filter + appended
// Event column, the Finance "Traveller-paid expenses" event column + filter,
// and GET /reports/event-spend (utils/cstepEventSpend.ts). Access (the
// master is Admin only; the options search is any requester; event spend is
// Admin + Finance, Finance scoped to their travellers), CRUD with a manual
// unique code and optional dates, import preview → commit, Yes needs an
// event / No leaves it blank, the snapshot surviving a rename, and the
// per-event totals (settled vs provisional, the paid split, the category
// breakdown) with a BOM'd CSV.
//
// Real: cstep + events routers, models, sheetImport, the register builder,
//   in-memory Mongo REPLICA SET on a fresh database, cstep_qc_event.
// Stubbed: S3, mail, PDF helpers, auth (x-test-user) and the workspace
//   resolver (x-test-ws).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_event";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {
    constructor(public input: any) {}
  },
  GetObjectCommand: class {
    constructor(public input: any) {}
  },
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async (args: any) => ({ key: `${args.keyPrefix}/qc` })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));

const { default: cstepRouter } = await import("./cstep.js");
const { default: eventsRouter } = await import("./cstep.events.js");
const { default: projectsRouter } = await import("./cstep.projects.js");

const DB = "cstep_qc_event";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const U = { traveller: oid(), other: oid(), approver: oid(), finance: oid(), finance2: oid(), admin: oid() };
const TP = oid(); //   Asha — Finance: U.finance
const TP2 = oid(); //  Ravi — Finance: U.finance2

const fakeAuth = (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = new mongoose.Types.ObjectId(String(req.headers["x-test-ws"] || WS));
  next();
};
const app = express();
app.use(express.json());
app.use("/api/cstep/events", fakeAuth, eventsRouter);
app.use("/api/cstep/projects", fakeAuth, projectsRouter);
app.use("/api/cstep", fakeAuth, cstepRouter);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = {
  traveller: who(U.traveller),
  approver: who(U.approver, ["APPROVER"]),
  finance: who(U.finance),
  finance2: who(U.finance2),
  admin: who(U.admin, ["ADMIN"]),
};
const send = (method: "get" | "post" | "put" | "patch" | "delete", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
  return body === undefined ? r : r.send(body);
};
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
const getBinary = (as: any, path: string) =>
  binary(request(app).get(`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS)));
const upload = (step: "preview" | "commit", as: any, buf: Buffer, name = "events.csv") =>
  request(app).post(`/api/cstep/events/import/${step}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS)).attach("file", buf, name);
const stage = async () =>
  String(
    ok(
      await request(app)
        .post("/api/cstep/attachments/staging")
        .set("x-test-user", JSON.stringify(ACT.traveller))
        .set("x-test-ws", String(WS))
        .field("documentType", "TAX_INVOICE")
        .attach("file", Buffer.from("%PDF-1.4 qc"), { filename: "inv.pdf", contentType: "application/pdf" }),
    ).body.attachment._id,
  );
const reqDoc = (id: string) => col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) });

const E: Record<string, string> = {};
let PROJECT = "";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);

  // Step 0 gate: a local server and an empty database, or nothing is seeded.
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);

  await mongoose.connection.syncIndexes();

  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertMany([
    {
      _id: TP, workspaceId: WS, travelerId: "E-001", firstName: "Asha", lastName: "Rao", isActive: true,
      email: `${U.traveller}@qc.local`, claimedBy: U.traveller, tourApproverId: U.approver, financeUserId: U.finance,
    },
    {
      _id: TP2, workspaceId: WS, travelerId: "E-002", firstName: "Ravi", lastName: "Iyer", isActive: true,
      email: `${U.other}@qc.local`, claimedBy: U.other, tourApproverId: U.approver, financeUserId: U.finance2,
    },
  ] as any[]);
  PROJECT = String(ok(await send("post", ACT.admin, "/projects", { projectCode: "PRJ-QC", projectName: "QC Programme" })).body.project._id);
}, 240_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

/* ── 1. the master ─────────────────────────────────────────────────── */

describe("Event Master — access and CRUD", () => {
  it("everything but the options search is CSTEP Admin only — Requester, Approver and Finance get 403", async () => {
    for (const as of [ACT.traveller, ACT.approver, ACT.finance]) {
      expect((await send("get", as, "/events")).status).toBe(403);
      expect((await send("get", as, "/events/export")).status).toBe(403);
      expect((await send("get", as, "/events/template")).status).toBe(403);
      expect((await send("post", as, "/events", { eventCode: "X", eventName: "X" })).status).toBe(403);
    }
    expect(ok(await send("get", ACT.admin, "/events")).body).toMatchObject({ ok: true, canEdit: true, events: [] });
  });

  it("creates with a manual code — trimmed, uppercased, unique — optional dates / location, and validates", async () => {
    const r = ok(
      await send("post", ACT.admin, "/events", {
        eventCode: " icse-2026 ", eventName: "Int'l Conference on Solar Energy", startDate: "2026-11-05", endDate: "2026-11-07", location: "Bengaluru",
      }),
    ).body.event;
    expect(r).toMatchObject({ eventCode: "ICSE-2026", eventName: "Int'l Conference on Solar Energy", startDate: "2026-11-05", endDate: "2026-11-07", location: "Bengaluru", isActive: true });
    E.icse = String(r._id);
    const bare = ok(await send("post", ACT.admin, "/events", { eventCode: "GRID-WS", eventName: "Grid Workshop" })).body.event;
    expect(bare.startDate).toBeUndefined();
    expect(bare.location).toBeUndefined();
    E.grid = String(bare._id);

    expect((await send("post", ACT.admin, "/events", { eventCode: "icse-2026", eventName: "Dup" })).status).toBe(409);
    expect((await send("post", ACT.admin, "/events", { eventCode: "", eventName: "No code" })).body.error).toBe("Event code is required");
    expect((await send("post", ACT.admin, "/events", { eventCode: "BAD*CODE", eventName: "X" })).status).toBe(400);
    expect((await send("post", ACT.admin, "/events", { eventCode: "EV-X" })).body.error).toBe("Event name is required");
    expect((await send("post", ACT.admin, "/events", { eventCode: "EV-X", eventName: "X", startDate: "05/11/2026" })).body.error).toBe("Start date must be a date (YYYY-MM-DD)");
    expect((await send("post", ACT.admin, "/events", { eventCode: "EV-X", eventName: "X", startDate: "2026-11-07", endDate: "2026-11-05" })).body.error).toBe(
      "The end date can't be before the start date",
    );
  });

  it("edits name / dates / location / active; the code is fixed; a blank date clears it", async () => {
    const r = ok(await send("put", ACT.admin, `/events/${E.grid}`, { location: "Pune", startDate: "2026-12-01" })).body.event;
    expect(r).toMatchObject({ eventCode: "GRID-WS", location: "Pune", startDate: "2026-12-01" });
    expect(ok(await send("put", ACT.admin, `/events/${E.grid}`, { startDate: "" })).body.event.startDate).toBeUndefined();
    expect((await send("put", ACT.admin, `/events/${E.grid}`, { eventCode: "GRID-NEW" })).status).toBe(400);
    expect((await send("put", ACT.admin, `/events/${E.icse}`, { endDate: "2026-11-01" })).body.error).toBe("The end date can't be before the start date");
    expect((await send("put", ACT.finance, `/events/${E.grid}`, { eventName: "X" })).status).toBe(403);
  });

  it("import: preview writes nothing; commit creates and updates by code, skipping bad rows", async () => {
    const csv = Buffer.from(
      [
        "Event Code,Event Name,Start Date,End Date,Location,Active",
        "EV-SUMMIT,Energy Summit,2026-12-10,2026-12-11,Delhi,Yes", //  create
        "grid-ws,,,,Mumbai,", //                                         update (blank name kept)
        ",Nameless,,,,", //                                              no code
        "EV-NEW,,,,,", //                                                new without a name
        "EV-SUMMIT,Again,,,,", //                                        same code twice
        "EV-BADDATE,Bad date,10-12-2026,,,", //                          bad date
        "EV-BACK,Backwards,2026-12-10,2026-12-01,,", //                  end before start
        "EV-OLD,Old Expo,,,,No", //                                      create, inactive
      ].join("\n") + "\n",
    );
    const pv = ok(await upload("preview", ACT.admin, csv)).body;
    expect(pv).toMatchObject({ created: 2, updated: 1, skipped: 5 });
    expect(pv.results.filter((r: any) => r.action === "skip").map((r: any) => r.reason)).toEqual([
      "Event code is required",
      "Event Name is required for a new event",
      "Event Code EV-SUMMIT is also on row 2 of this file",
      "Start Date must be in YYYY-MM-DD format",
      "The end date can't be before the start date",
    ]);
    expect(await col("cstepevents").countDocuments({})).toBe(2);
    expect((await upload("preview", ACT.finance, csv)).status).toBe(403);

    ok(await upload("commit", ACT.admin, csv));
    const all = await col("cstepevents").find({}).sort({ eventCode: 1 }).toArray();
    expect(all.map((e: any) => [e.eventCode, e.eventName, e.startDate ?? "", e.location ?? "", e.isActive])).toEqual([
      ["EV-OLD", "Old Expo", "", "", false],
      ["EV-SUMMIT", "Energy Summit", "2026-12-10", "Delhi", true],
      ["GRID-WS", "Grid Workshop", "", "Mumbai", true],
      ["ICSE-2026", "Int'l Conference on Solar Energy", "2026-11-05", "Bengaluru", true],
    ]);
    E.old = String(all[0]._id);
    E.summit = String(all[1]._id);
  });

  it("export (Admin) has the template columns with the code and dates as text", async () => {
    const r = await getBinary(ACT.admin, "/events/export");
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as any);
    const ws = wb.worksheets[0];
    expect((ws.getRow(1).values as any[]).slice(1)).toEqual(["Event Code", "Event Name", "Start Date", "End Date", "Location", "Active"]);
    expect(ws.actualRowCount).toBe(5);
    for (const c of [1, 3, 4]) expect(ws.getColumn(c).numFmt).toBe("@");
    expect((ws.getRow(5).values as any[]).slice(1)).toEqual(["ICSE-2026", "Int'l Conference on Solar Energy", "2026-11-05", "2026-11-07", "Bengaluru", "Yes"]);
  });

  it("the options search is open to a Requester: active events only, by code or name, code prefix first", async () => {
    const all = ok(await send("get", ACT.traveller, "/events/options")).body.events;
    expect(all.map((e: any) => e.eventCode)).toEqual(["EV-SUMMIT", "GRID-WS", "ICSE-2026"]); // EV-OLD is inactive
    expect(ok(await send("get", ACT.approver, "/events/options?q=solar")).body.events.map((e: any) => e.eventCode)).toEqual(["ICSE-2026"]);
    expect(ok(await send("get", ACT.traveller, "/events/options?q=gr")).body.events[0].eventCode).toBe("GRID-WS");
    // The reports' filters list the inactive ones too.
    const withOld = ok(await send("get", ACT.finance, "/events/options?includeInactive=1")).body.events;
    expect(withOld.map((e: any) => [e.eventCode, e.isActive])).toEqual([["EV-OLD", false], ["EV-SUMMIT", true], ["GRID-WS", true], ["ICSE-2026", true]]);
  });
});

/* ── 2. the tag on every form ──────────────────────────────────────── */

describe("intake forms — Related to an event? Yes needs an event; the snapshot is kept", () => {
  const bodies = async (): Promise<Record<string, any>> => ({
    TOUR_PROPOSAL: { type: "DOMESTIC", purpose: "QC tour", departureDate: "2026-11-05", returnDate: "2026-11-07", stations: [{ from: "Pune", to: "Bengaluru" }] },
    EVENT_REQUEST: {
      formType: "EVENT_REQUEST", purpose: "QC workshop", departureDate: "2026-11-05", returnDate: "2026-11-07",
      hostInstitution: "QC Institute", eventNature: "CONFERENCE", eventLocation: "Bengaluru", eventParticipants: [{ organisation: "CSTEP" }],
    },
    LOCAL_TRAVEL_CLAIM: {
      formType: "LOCAL_TRAVEL_CLAIM", purpose: "Venue visits", departureDate: "2026-10-05", returnDate: "2026-10-09",
      travelLines: [], foodLines: [], otherExpenses: 80,
    },
    EXPENSE_CLAIM: {
      formType: "EXPENSE_CLAIM", purpose: "Conference kits", departureDate: "2026-10-12", returnDate: "2026-10-16",
      expenseLines: [{ date: "2026-10-12", description: "Stationery", amount: 300 }], invoiceAttachmentIds: [await stage()],
    },
  });

  it("Yes refuses no event, an unknown one and an inactive one — on every form", async () => {
    const before = await col("csteptravelrequests").countDocuments({});
    for (const [formType, body] of Object.entries(await bodies())) {
      const b = { ...body, projectId: PROJECT };
      const none = await send("post", ACT.traveller, "/requests", { ...b, eventRelated: true });
      expect([formType, none.status, none.body.error]).toEqual([formType, 400, "Choose an event"]);
      expect((await send("post", ACT.traveller, "/requests", { ...b, eventRelated: true, eventId: "" })).body.error).toBe("Choose an event");
      expect((await send("post", ACT.traveller, "/requests", { ...b, eventRelated: true, eventId: String(oid()) })).body.error).toBe("Unknown event");
      expect((await send("post", ACT.traveller, "/requests", { ...b, eventRelated: true, eventId: E.old })).body.error).toBe("Event EV-OLD is inactive — choose another");
    }
    expect(await col("csteptravelrequests").countDocuments({})).toBe(before);
  });

  it("No leaves the event blank (even with an eventId sent); not answering stores nothing", async () => {
    for (const [formType, body] of Object.entries(await bodies())) {
      const no = ok(await send("post", ACT.traveller, "/requests", { ...body, projectId: PROJECT, eventRelated: false, eventId: E.icse })).body.request;
      expect([formType, no.eventRelated, no.eventId, no.eventCode, no.eventName]).toEqual([formType, false, undefined, undefined, undefined]);
    }
    const legacy = ok(await send("post", ACT.traveller, "/requests", { ...(await bodies()).TOUR_PROPOSAL, projectId: PROJECT })).body.request;
    expect(legacy.eventRelated).toBeUndefined();
    expect(legacy.eventId).toBeUndefined();
  });

  it("Yes stores the picked event's snapshot on every form", async () => {
    for (const [formType, body] of Object.entries(await bodies())) {
      const doc = ok(await send("post", ACT.traveller, "/requests", { ...body, projectId: PROJECT, eventRelated: true, eventId: E.icse })).body.request;
      expect([formType, doc.eventRelated, doc.eventId, doc.eventCode, doc.eventName]).toEqual([
        formType, true, E.icse, "ICSE-2026", "Int'l Conference on Solar Energy",
      ]);
      E[formType] = String(doc._id);
    }
  });

  it("a rename in the master leaves every tagged request's snapshot alone", async () => {
    ok(await send("put", ACT.admin, `/events/${E.icse}`, { eventName: "ICSE 2026 — Bengaluru" }));
    for (const id of [E.TOUR_PROPOSAL, E.EVENT_REQUEST, E.LOCAL_TRAVEL_CLAIM, E.EXPENSE_CLAIM]) {
      const g = ok(await send("get", ACT.traveller, `/requests/${id}`)).body.request;
      expect([g.eventCode, g.eventName]).toEqual(["ICSE-2026", "Int'l Conference on Solar Energy"]);
    }
  });

  it("editing switches the event or answers No (the snapshot is removed, not nulled); an approver can't amend it", async () => {
    await col("csteptravelrequests").updateOne({ _id: new mongoose.Types.ObjectId(E.TOUR_PROPOSAL) }, { $set: { status: "RETURNED" } });
    const sw = ok(await send("patch", ACT.traveller, `/requests/${E.TOUR_PROPOSAL}`, { eventRelated: true, eventId: E.grid })).body.request;
    expect([sw.eventCode, sw.eventName]).toEqual(["GRID-WS", "Grid Workshop"]);
    // An edit that doesn't touch the answer keeps it.
    ok(await send("patch", ACT.traveller, `/requests/${E.TOUR_PROPOSAL}`, { purpose: "QC tour, edited" }));
    expect((await reqDoc(E.TOUR_PROPOSAL))!.eventCode).toBe("GRID-WS");
    ok(await send("patch", ACT.traveller, `/requests/${E.TOUR_PROPOSAL}`, { eventRelated: false }));
    const raw: any = await reqDoc(E.TOUR_PROPOSAL);
    expect(raw.eventRelated).toBe(false);
    for (const k of ["eventId", "eventCode", "eventName"]) expect(k in raw).toBe(false);
    expect((await send("patch", ACT.traveller, `/requests/${E.TOUR_PROPOSAL}`, { eventRelated: true })).body.error).toBe("Choose an event");
    // Back on ICSE for the reports below; an inactive event already on the request stays acceptable.
    ok(await send("patch", ACT.traveller, `/requests/${E.TOUR_PROPOSAL}`, { eventRelated: true, eventId: E.icse }));

    await col("csteptravelrequests").updateOne({ _id: new mongoose.Types.ObjectId(E.EVENT_REQUEST) }, { $set: { status: "SUBMITTED" } });
    for (const field of ["eventId", "eventRelated"]) {
      const r = await send("post", ACT.approver, `/requests/${E.EVENT_REQUEST}/amend`, { field, newValue: E.grid, reason: "x" });
      expect([field, r.status]).toEqual([field, 400]);
    }
  });

  it("an inactive event stays on the request that already has it", async () => {
    ok(await send("put", ACT.admin, `/events/${E.grid}`, { isActive: false }));
    await col("csteptravelrequests").updateOne({ _id: new mongoose.Types.ObjectId(E.LOCAL_TRAVEL_CLAIM) }, { $set: { status: "RETURNED", eventId: new mongoose.Types.ObjectId(E.grid), eventCode: "GRID-WS", eventName: "Grid Workshop" } });
    ok(await send("patch", ACT.traveller, `/requests/${E.LOCAL_TRAVEL_CLAIM}`, { eventRelated: true, eventId: E.grid, purpose: "Venue visits, edited" }));
    // …but nothing else can pick it.
    expect((await send("post", ACT.traveller, "/requests", { ...(await bodies()).TOUR_PROPOSAL, projectId: PROJECT, eventRelated: true, eventId: E.grid })).body.error).toBe(
      "Event GRID-WS is inactive — choose another",
    );
    ok(await send("put", ACT.admin, `/events/${E.grid}`, { isActive: true }));
  });

  it("an event a request uses can't be deleted (deactivate instead); an unused one can", async () => {
    expect((await send("delete", ACT.admin, `/events/${E.icse}`)).status).toBe(409);
    expect(ok(await send("delete", ACT.admin, `/events/${E.old}`)).body.ok).toBe(true);
  });
});

/* ── 3–4. the reports ──────────────────────────────────────────────── */

// Raw cases for the reports — each its own request, tagged (or not), with
// the arrangements / settlement / lines its stage would have.
const R: Record<string, mongoose.Types.ObjectId> = {};
async function seedCase(opts: {
  key: string;
  tp?: mongoose.Types.ObjectId;
  formType?: string;
  status: string;
  event?: string; // E key
  ref: string;
  departureDate?: string;
  arrangements?: Array<{ arrangedType: string; amount?: number; currency?: string; amountInr?: number; status?: string }>;
  settlement?: { status: string; total: number; perDiem?: number };
  lines?: Array<{ classification: "OFFICIAL" | "PERSONAL"; mode: string; amountInr: number; category?: string; description?: string }>;
}) {
  const id = oid();
  R[opts.key] = id;
  const now = new Date();
  const ev: any = opts.event ? await col("cstepevents").findOne({ _id: new mongoose.Types.ObjectId(E[opts.event]) }) : null;
  await col("csteptravelrequests").insertOne({
    _id: id, workspaceId: WS, travelerProfileId: opts.tp || TP, createdBy: opts.tp === TP2 ? U.other : U.traveller,
    formType: opts.formType || "TOUR_PROPOSAL", type: "DOMESTIC", purpose: `Case ${opts.key}`, project: "PRJ-QC — QC Programme",
    departureDate: opts.departureDate || "2026-10-20", returnDate: opts.departureDate || "2026-10-22",
    stations: [{ from: "Pune", to: "Bengaluru" }], status: opts.status, claimReference: opts.ref,
    ...(ev ? { eventRelated: true, eventId: ev._id, eventCode: ev.eventCode, eventName: "Snapshot name" } : {}),
    createdAt: now, updatedAt: now,
  } as any);
  for (const a of opts.arrangements || []) {
    await col("csteparrangements").insertOne({
      workspaceId: WS, requestId: id, source: "REQUESTED", requestedType: a.arrangedType, arrangedType: a.arrangedType,
      currency: a.currency || "INR", amount: a.amount, amountInr: a.amountInr, status: a.status || "ARRANGED",
      createdBy: U.admin, createdAt: now, updatedAt: now,
    } as any);
  }
  if (opts.settlement) {
    const sid = oid();
    await col("cstepsettlements").insertOne({
      _id: sid, workspaceId: WS, requestId: id, status: opts.settlement.status,
      perDiem: { days: opts.settlement.perDiem ? 3 : 0, rate: 1000, currency: "INR", amountInr: opts.settlement.perDiem || 0, computedDays: 3 },
      buckets: { airRailBus: 0, perDiem: 0, boardingLodging: 0, cab: 0, other: 0 },
      totalCostOfTour: opts.settlement.total, amountClaimed: 0, startedBy: U.admin, startedAt: now, createdAt: now, updatedAt: now,
    } as any);
    for (const l of opts.lines || []) {
      await col("cstepsettlementlines").insertOne({
        workspaceId: WS, settlementId: sid, requestId: id, source: "ARRANGEMENT", sourceId: oid(), mode: l.mode,
        description: l.description || l.mode, amountInr: l.amountInr, claimedAmountInr: l.amountInr, classification: l.classification,
        classificationOverridden: false, verified: true, ...(l.category ? { category: l.category } : {}), createdBy: U.admin, createdAt: now, updatedAt: now,
      } as any);
    }
  }
}

describe("reports — Travel Register, Traveller-paid expenses, per-event spend", () => {
  beforeAll(async () => {
    // The tagged requests from the form tests are DRAFT / RETURNED / SUBMITTED
    // with no spend; take them out of the reports' way.
    await col("csteptravelrequests").updateMany({}, { $set: { status: "CANCELLED" } });

    // ICSE — settled tour: flight + hotel booked by CSTEP, a self-paid cab, per diem.
    await seedCase({
      key: "settled", status: "REIMBURSED", event: "icse", ref: "0101/1026",
      settlement: { status: "FINALIZED", total: 19500, perDiem: 2400 },
      lines: [
        { classification: "OFFICIAL", mode: "FLIGHT", amountInr: 9400, category: "FLIGHT" },
        { classification: "OFFICIAL", mode: "HOTEL", amountInr: 7200, category: "HOTEL" },
        { classification: "PERSONAL", mode: "CAB", amountInr: 500, category: "CAB", description: "Airport → Venue" },
      ],
    });
    // ICSE — arranged, not settled: an INR flight, a USD hotel with no rate yet, and an untouched seed row.
    await seedCase({
      key: "arranged", status: "ARRANGED", event: "icse", ref: "0102/1026",
      arrangements: [
        { arrangedType: "FLIGHT", amount: 5000, amountInr: 5000 },
        { arrangedType: "HOTEL", amount: 100, currency: "USD" },
        { arrangedType: "CAB", status: "PENDING" },
      ],
    });
    // ICSE — an Expense Claim still being verified (a settlement, but not final).
    await seedCase({
      key: "verifying", formType: "EXPENSE_CLAIM", status: "TRANSFERRED_TO_FINANCE", event: "icse", ref: "EXP0001/1026",
      settlement: { status: "VERIFYING", total: 1200 },
      lines: [
        { classification: "PERSONAL", mode: "OTHER", amountInr: 1000, category: "STATIONERY" },
        { classification: "PERSONAL", mode: "OTHER", amountInr: 200, category: "TAX" },
      ],
    });
    // ICSE — left out: a draft, a rejected and a cancelled one.
    await seedCase({ key: "draft", status: "DRAFT", event: "icse", ref: "", arrangements: [{ arrangedType: "FLIGHT", amount: 999, amountInr: 999 }] });
    await seedCase({ key: "rejected", status: "REJECTED", event: "icse", ref: "" });
    await seedCase({ key: "cancelled", status: "CANCELLED", event: "icse", ref: "0103/1026", arrangements: [{ arrangedType: "FLIGHT", amount: 777, amountInr: 777 }] });
    // SUMMIT — Ravi's settled Local Travel Claim (Finance: finance2), a line filed before categories.
    await seedCase({
      key: "summit", tp: TP2, formType: "LOCAL_TRAVEL_CLAIM", status: "REIMBURSED", event: "summit", ref: "LTC0001/1026",
      settlement: { status: "FINALIZED", total: 3000 },
      lines: [
        { classification: "PERSONAL", mode: "CAB", amountInr: 2000, category: "CAB" },
        { classification: "PERSONAL", mode: "OTHER", amountInr: 1000 },
      ],
    });
    // Not tagged — settled, in no event's row.
    await seedCase({
      key: "untagged", status: "REIMBURSED", ref: "0104/1026",
      settlement: { status: "FINALIZED", total: 4000 },
      lines: [{ classification: "PERSONAL", mode: "CAB", amountInr: 4000, category: "CAB" }],
    });
  });

  it("Travel Register: Event is appended as column S (A:R and the merged title untouched), and ?event= keeps that event's trips", async () => {
    const load = async (q: string) => {
      const r = await getBinary(ACT.admin, `/reports/travel-register?period=custom&from=2026-10-01&to=2026-10-31${q}`);
      expect(r.status).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.body as any);
      return wb.worksheets[0];
    };
    const ws = await load("");
    expect((ws.getRow(2).values as any[]).slice(1)).toEqual([
      "Month", "TIN", "TYPE", "NAME", "REASON", "From", "Destination", "From", "To", "Mode ",
      "Agency", "Invoice date", "Invoice No", "Amount", "TDS", "Paid", "Project ", "Cheque & Date", "Event",
    ]);
    expect((ws as any).model.merges).toEqual(["A1:R1"]);
    const eventOf = new Map<string, Set<string>>();
    ws.eachRow((row, n) => {
      const tin = String(row.getCell(2).value ?? "");
      if (n > 2 && tin) eventOf.set(tin, new Set([...(eventOf.get(tin) || []), String(row.getCell(19).value ?? "")]));
    });
    // Every row of a trip carries its snapshot; an untagged trip's cell is blank.
    expect([...eventOf.get("0101/1026")!]).toEqual(["ICSE-2026 — Snapshot name"]);
    expect([...eventOf.get("LTC0001/1026")!]).toEqual(["EV-SUMMIT — Snapshot name"]);
    expect([...eventOf.get("0104/1026")!]).toEqual([""]);

    const only = await load(`&event=${E.icse}`);
    const tins = new Set<string>();
    only.eachRow((row, n) => {
      if (n > 2 && row.getCell(2).value && row.getCell(3).value) tins.add(String(row.getCell(2).value));
    });
    // The register shows cancelled and rejected trips too ("—": the rejected one has no TIN); not the Expense Claim.
    expect([...tins].sort()).toEqual(["0101/1026", "0102/1026", "0103/1026", "—"]);
    expect((await send("get", ACT.admin, "/reports/travel-register?period=fy&event=nope")).status).toBe(400);
  });

  it("Traveller-paid expenses: every item has its case's event; ?event= filters; the event list is in scope only", async () => {
    const all = ok(await send("get", ACT.admin, "/finance-expenses")).body;
    const byRef = (ref: string) => all.items.filter((i: any) => i.reference === ref);
    expect(byRef("0101/1026").map((i: any) => [i.eventId, i.event])).toEqual([
      [E.icse, "ICSE-2026 — Snapshot name"],
      [E.icse, "ICSE-2026 — Snapshot name"], // the per diem
    ]);
    expect(byRef("0104/1026").map((i: any) => [i.eventId, i.event])).toEqual([["", ""]]);
    expect(all.events.map((e: any) => e.id).sort()).toEqual([E.icse, E.summit].sort());

    const icse = ok(await send("get", ACT.admin, `/finance-expenses?event=${E.icse}`)).body.items;
    expect([...new Set(icse.map((i: any) => i.reference))].sort()).toEqual(["0101/1026", "EXP0001/1026"]);
    // Finance sees only their travellers' cases — and only those events in the filter list.
    const fin = ok(await send("get", ACT.finance, "/finance-expenses")).body;
    expect(fin.events.map((e: any) => e.id)).toEqual([E.icse]);
    expect(ok(await send("get", ACT.finance, `/finance-expenses?event=${E.summit}`)).body.items).toEqual([]);
  });

  it("Traveller-paid expenses CSV: Event after Traveller, BOM'd, — and → intact", async () => {
    const r = await getBinary(ACT.admin, `/finance-expenses?format=csv&event=${E.icse}`);
    const buf: Buffer = r.body;
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const [header, ...data] = buf.subarray(3).toString("utf8").trim().split("\n");
    expect(header).toBe("Reference,Traveller,Event,Date,Category,Description,Amount claimed (INR),Amount now (INR),Status,Paid on,Payment ref,Reason");
    expect(data.length).toBe(4); // cab + per diem + stationery + tax
    expect(data.every((l) => l.split(",")[2] === "ICSE-2026 — Snapshot name")).toBe(true);
    expect(data.some((l) => l.includes("Airport → Venue"))).toBe(true);
  });

  it("event spend: settled vs provisional, the CSTEP-paid / traveller-paid split and the category breakdown", async () => {
    const { rows, total } = ok(await send("get", ACT.admin, "/reports/event-spend")).body;
    expect(rows.map((r: any) => r.eventCode)).toEqual(["EV-SUMMIT", "ICSE-2026"]);
    const icse = rows.find((r: any) => r.eventId === E.icse);
    expect(icse).toEqual({
      eventId: E.icse,
      eventCode: "ICSE-2026",
      eventName: "ICSE 2026 — Bengaluru", // the master's current name, not a request's snapshot
      cases: 3, // settled + arranged + verifying; not the draft / rejected / cancelled
      settledCases: 1,
      provisionalCases: 2,
      totalInr: 25700, // 19,500 settled + 5,000 arranged + 1,200 verifying
      settledInr: 19500,
      provisionalInr: 6200,
      cstepPaidInr: 21600, // 9,400 + 7,200 + 5,000
      travellerPaidInr: 4100, // 500 cab + 2,400 per diem + 1,000 + 200
      byCategory: { FLIGHT: 14400, HOTEL: 7200, CAB: 500, PER_DIEM: 2400, STATIONERY: 1000, TAX: 200 },
      unpricedBookings: 1, // the USD hotel with no rate — never guessed
    });
    const summit = rows.find((r: any) => r.eventId === E.summit);
    expect(summit).toMatchObject({ cases: 1, settledCases: 1, totalInr: 3000, cstepPaidInr: 0, travellerPaidInr: 3000, byCategory: { CAB: 2000, UNCATEGORISED: 1000 } });
    expect(total).toMatchObject({ eventName: "All events", cases: 4, totalInr: 28700, settledInr: 22500, provisionalInr: 6200 });
    expect(ok(await send("get", ACT.admin, `/reports/event-spend?event=${E.summit}`)).body.rows.map((r: any) => r.eventCode)).toEqual(["EV-SUMMIT"]);
    expect((await send("get", ACT.admin, "/reports/event-spend?event=nope")).status).toBe(400);
  });

  it("event spend scoping: Admin all; a Finance user their travellers' cases; Requester and Approver 403", async () => {
    expect(ok(await send("get", ACT.finance, "/reports/event-spend")).body.rows.map((r: any) => r.eventCode)).toEqual(["ICSE-2026"]);
    expect(ok(await send("get", ACT.finance2, "/reports/event-spend")).body.rows.map((r: any) => r.eventCode)).toEqual(["EV-SUMMIT"]);
    for (const as of [ACT.traveller, ACT.approver]) expect((await send("get", as, "/reports/event-spend")).status).toBe(403);
  });

  it("event spend CSV: UTF-8 with a BOM, one column per category, an All events total, — intact", async () => {
    const r = await getBinary(ACT.admin, "/reports/event-spend?format=csv");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="cstep-event-spend-\d{4}-\d{2}-\d{2}\.csv"$/);
    const buf: Buffer = r.body;
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buf.subarray(3).toString("utf8");
    expect(text).not.toMatch(/â€|Ã/);
    const [header, ...data] = text.trim().split("\n");
    const cols = header.split(",");
    expect(cols.slice(0, 10)).toEqual([
      "Event Code", "Event Name", "Cases", "Settled", "Provisional",
      "Total cost (INR)", "Settled (INR)", "Provisional (INR)", "CSTEP-paid (INR)", "Traveller-paid (INR)",
    ]);
    expect(cols.slice(10)).toEqual([
      "Flight (INR)", "Hotel (INR)", "Cab (INR)", "Train (INR)", "Bus (INR)", "Own vehicle (INR)", "Food (INR)", "Per diem (INR)",
      "Visa (INR)", "Forex (INR)", "Stationery (INR)", "Tax (INR)", "Other (INR)", "Expense (no head) (INR)", "Not categorised yet (INR)",
      "Bookings without an INR rate",
    ]);
    expect(data.length).toBe(3);
    const icse = data[1].split(",");
    expect(icse.slice(0, 10)).toEqual(["ICSE-2026", "ICSE 2026 — Bengaluru", "3", "1", "2", "25700", "19500", "6200", "21600", "4100"]);
    expect(icse[cols.indexOf("Flight (INR)")]).toBe("14400");
    expect(icse[cols.indexOf("Bookings without an INR rate")]).toBe("1");
    expect(data[2].split(",").slice(0, 6)).toEqual(["", "All events", "4", "2", "2", "28700"]);
  });
});
