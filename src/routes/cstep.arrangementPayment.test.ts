// apps/backend/src/routes/cstep.arrangementPayment.test.ts
//
// CSTEP vendor + payment on arrangement rows — routes/cstep.ts. A vendor
// chosen on a ledger row while ARRANGING (active vendors only, code + name
// snapshotted, and the choice counts as a touch so mark-arranged keeps the
// row), PATCH …/arrangements/:lineId/payment for the traveller's Official
// (at the arrange step), Finance user or a CSTEP Admin, from ARRANGING
// onwards (needs a vendor; UNPAID ↔ PAID with ref + date, logged as
// VENDOR_PAYMENT; a paid line's vendor and amount are locked), the Travel Register's Agency / Paid / Cheque & Date
// columns, and an Event Request taking a vendor + manual payment the same way.
//
// Real: cstep router, models, the register workbook, in-memory Mongo REPLICA
//   SET (approve runs in a transaction) on a fresh database, cstep_qc_arrpay.
// Stubbed: S3 upload/presign, mail, the Event Request + packet PDF helpers,
//   auth (x-test-user) and the workspace resolver (x-test-ws).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_arrpay";
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

const DB = "cstep_qc_arrpay";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
// Project Master — every request needs a project picked from the master.
// One QC project, added to a create body that names none (QC_PROJECT seeded
// in beforeAll).
const QC_PROJECT = oid();
const withProject = (path: string, body: any) =>
  path === "/requests" && body && body.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body;
const U = { traveller: oid(), approver: oid(), official: oid(), finance: oid(), admin: oid(), other: oid(), otherFinance: oid() };
const TP = { main: oid(), other: oid() };
const VT = { airline: oid(), cab: oid(), venue: oid() };
const V = { sky: oid(), uk: oid(), hall: oid(), retired: oid() };

const app = express();
app.use(express.json());
app.use(
  "/api/cstep",
  (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.workspaceObjectId = new mongoose.Types.ObjectId(String(req.headers["x-test-ws"] || WS));
    next();
  },
  cstepRouter,
);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = {
  traveller: who(U.traveller),
  approver: who(U.approver, ["APPROVER"]),
  official: who(U.official),
  finance: who(U.finance),
  admin: who(U.admin, ["ADMIN"]),
  other: who(U.other),
  // Finance for a DIFFERENT traveller — must not reach this traveller's lines.
  otherFinance: who(U.otherFinance),
};
const send = (method: "get" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
  return body === undefined ? r : r.send(body);
};
const post = (as: any, path: string, body: any = {}) => send("post", as, path, withProject(path, body));
const patch = (as: any, path: string, body: any = {}) => send("patch", as, path, body);
const get = (as: any, path: string) => send("get", as, path);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const lines = async (requestId: string) =>
  col("csteparrangements").find({ requestId: new mongoose.Types.ObjectId(requestId) }).sort({ createdAt: 1, _id: 1 }).toArray();
const trail = async (requestId: string, action: string) =>
  col("cstepapprovals").find({ entityId: new mongoose.Types.ObjectId(requestId), action }).sort({ at: 1 }).toArray();

/** Files, approves and opens a request for arranging; returns its id. */
async function arrangingRequest(body: any): Promise<string> {
  const id = String(ok(await post(ACT.traveller, "/requests", body)).body.request._id);
  ok(await post(ACT.approver, `/requests/${id}/approve`));
  ok(await post(ACT.official, `/requests/${id}/start-arranging`));
  return id;
}

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
  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);

  const now = new Date();
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertMany([
    {
      _id: TP.main, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
      email: `${U.traveller}@qc.local`, claimedBy: U.traveller,
      tourApproverId: U.approver, officialUserId: U.official, financeUserId: U.finance,
    },
    {
      _id: TP.other, workspaceId: WS, travelerId: "CSTEP-002", firstName: "Ravi", lastName: "K", isActive: true,
      email: `${U.other}@qc.local`, claimedBy: U.other, tourApproverId: U.approver, financeUserId: U.otherFinance,
    },
  ] as any[]);
  await col("cstepvendortypes").insertMany([
    { _id: VT.airline, workspaceId: WS, name: "Airline", isActive: true },
    { _id: VT.cab, workspaceId: WS, name: "Cab", isActive: true },
    { _id: VT.venue, workspaceId: WS, name: "Venue", isActive: true },
  ] as any[]);
  const vendor = (_id: any, vendorCode: string, name: string, vendorTypeId: any, isActive = true) => ({
    _id, workspaceId: WS, vendorCode, name, vendorTypeId, isActive, createdAt: now, updatedAt: now,
  });
  await col("cstepvendors").insertMany([
    vendor(V.sky, "CSTEPVEN0001", "Skyline Travels", VT.airline),
    vendor(V.uk, "CSTEPVEN0002", "U K Cabs", VT.cab),
    vendor(V.hall, "CSTEPVEN0003", "Lakeside Convention Hall", VT.venue),
    vendor(V.retired, "CSTEPVEN0004", "Old Travels", VT.airline, false),
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

const TOUR = {
  type: "DOMESTIC", purpose: "QC vendor tour", departureDate: "2026-11-10", returnDate: "2026-11-12",
  stations: [{ from: "Bengaluru", to: "Delhi" }], modesRequested: ["AIR", "RAIL", "ROAD"],
};

describe("Tour Proposal — vendor on the ledger row", () => {
  let id: string;
  let flight: any, train: any, bus: any;

  beforeAll(async () => {
    id = await arrangingRequest(TOUR);
    [flight, train, bus] = await lines(id);
    expect([flight, train, bus].map((l) => l.arrangedType)).toEqual(["FLIGHT", "TRAIN", "BUS"]);
    expect(flight.paymentStatus).toBe("UNPAID"); // schema default on the seeded rows
  });

  it("the pick-list is active vendors only, for the arranger alone", async () => {
    const r = ok(await get(ACT.official, `/requests/${id}/vendor-options`)).body.vendors;
    expect(r.map((v: any) => v.vendorCode).sort()).toEqual(["CSTEPVEN0001", "CSTEPVEN0002", "CSTEPVEN0003"]);
    expect(r.find((v: any) => v.vendorCode === "CSTEPVEN0001").vendorTypeName).toBe("Airline");
    expect((await get(ACT.finance, `/requests/${id}/vendor-options`)).status).toBe(403);
    expect((await get(ACT.traveller, `/requests/${id}/vendor-options`)).status).toBe(403);
  });

  it("setting a vendor snapshots its code + name and logs it on ARRANGE_SERVICE", async () => {
    const r = ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { vendorId: String(V.sky) })).body.line;
    expect(r).toMatchObject({ vendorId: String(V.sky), vendorCode: "CSTEPVEN0001", vendorName: "Skyline Travels", status: "PENDING" });
    const log = (await trail(id, "ARRANGE_SERVICE")).pop()!;
    expect(log.comment).toContain("| Vendor: CSTEPVEN0001 Skyline Travels");
    // A rename in the Vendor Master never rewrites the row's snapshot.
    await col("cstepvendors").updateOne({ _id: V.sky }, { $set: { name: "Skyline Travels Pvt Ltd" } });
    expect((await lines(id))[0].vendorName).toBe("Skyline Travels");
  });

  it("refuses an inactive vendor, an unknown one, and another workspace's", async () => {
    const inactive = await patch(ACT.official, `/requests/${id}/arrangements/${train._id}`, { vendorId: String(V.retired) });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error).toBe("Vendor CSTEPVEN0004 (Old Travels) is inactive");
    expect((await patch(ACT.official, `/requests/${id}/arrangements/${train._id}`, { vendorId: String(oid()) })).status).toBe(404);
    expect((await patch(ACT.official, `/requests/${id}/arrangements/${train._id}`, { vendorId: "nope" })).status).toBe(400);
    expect((await lines(id))[1].vendorId).toBeUndefined();
  });

  it("an ADDED line can carry a vendor from the start", async () => {
    const r = ok(await post(ACT.official, `/requests/${id}/arrangements`, { arrangedType: "CAB", vendorId: String(V.uk), amount: 1485, currency: "INR" })).body.line;
    expect(r).toMatchObject({ source: "ADDED", vendorCode: "CSTEPVEN0002", vendorName: "U K Cabs", paymentStatus: "UNPAID" });
    expect((await trail(id, "ADD_SERVICE")).pop()!.comment).toContain("| Vendor: CSTEPVEN0002 U K Cabs");
  });

  it("at the arrange step the Official records a payment; the paid line's vendor + amount lock", async () => {
    // GET /requests/:id offers it while ARRANGING — to the Official, not the traveller.
    expect(ok(await get(ACT.official, `/requests/${id}`)).body.canPayVendors).toBe(true);
    expect(ok(await get(ACT.traveller, `/requests/${id}`)).body.canPayVendors).toBe(false);

    // No amount yet → it can't be paid; the message names the line.
    const unpriced = await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-ARR-1", paidAt: "2026-10-13" });
    expect(unpriced.status).toBe(409);
    expect(unpriced.body.error).toMatch(/^Flight — Skyline Travels on .+ has no amount — enter the amount before marking it paid$/);
    ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { amount: 8400, currency: "INR" }));

    const r = ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-ARR-1", paidAt: "2026-10-13" })).body.line;
    expect(r).toMatchObject({ paymentStatus: "PAID", paymentRef: "UTR-ARR-1", paymentSource: "MANUAL", paidBy: String(U.official) });
    const log = (await trail(id, "VENDOR_PAYMENT")).pop()!;
    expect(log).toMatchObject({ stage: "OFFICIAL", actor: U.official });
    expect(log.comment).toBe("FLIGHT — CSTEPVEN0001 Skyline Travels: UNPAID => PAID | Ref: UTR-ARR-1 | Paid on 2026-10-13");

    // Locked while paid: another vendor, clearing it, or a new amount → 409.
    const swap = await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { vendorId: String(V.uk) });
    expect(swap.status).toBe(409);
    expect(swap.body.error).toBe("This line's vendor is marked paid — mark it unpaid before changing the vendor");
    expect((await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { vendorId: null })).status).toBe(409);
    expect((await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { amount: 999, currency: "INR" })).status).toBe(409);
    // …but the same vendor resent, and details, still save.
    ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { vendorId: String(V.sky), details: "BLR-DEL" }));

    ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}/payment`, { paymentStatus: "UNPAID" }));
    expect((await lines(id))[0]).toMatchObject({ paymentStatus: "UNPAID", vendorCode: "CSTEPVEN0001" });
  });

  it("mark-arranged keeps the vendor-only row and drops the untouched one", async () => {
    ok(await patch(ACT.official, `/requests/${id}/arrangements/${train._id}`, { status: "ARRANGED", amount: 2200, currency: "INR" }));
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
    const after = await lines(id);
    expect(after.map((l) => l.arrangedType)).toEqual(["FLIGHT", "TRAIN", "CAB"]);
    expect(after[0]).toMatchObject({ vendorCode: "CSTEPVEN0001", vendorName: "Skyline Travels", status: "PENDING" });
    expect((await trail(id, "MARK_ARRANGED")).pop()!.comment).toBe("Dropped 1 untouched seed line(s): BUS");
    // Vendors are chosen only while ARRANGING.
    expect((await patch(ACT.official, `/requests/${id}/arrangements/${train._id}`, { vendorId: String(V.uk) })).status).toBe(409);
  });

  it("a line without a vendor can't be marked paid", async () => {
    const r = await patch(ACT.finance, `/requests/${id}/arrangements/${train._id}/payment`, { paymentStatus: "PAID", paymentRef: "UTR0" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Choose a vendor for this line before recording a payment");
  });

  it("only this traveller's Official or Finance user, or a CSTEP Admin, can record a payment", async () => {
    const cab = (await lines(id))[2];
    for (const as of [ACT.traveller, ACT.approver, ACT.other, ACT.otherFinance]) {
      expect((await patch(as, `/requests/${id}/arrangements/${cab._id}/payment`, { paymentStatus: "PAID", paymentRef: "X" })).status).toBe(403);
    }
    expect((await lines(id))[2].paymentStatus).toBe("UNPAID");
    // GET /requests/:id tells the UI who may.
    expect(ok(await get(ACT.finance, `/requests/${id}`)).body.canPayVendors).toBe(true);
    expect(ok(await get(ACT.admin, `/requests/${id}`)).body.canPayVendors).toBe(true);
    expect(ok(await get(ACT.official, `/requests/${id}`)).body.canPayVendors).toBe(true);
    expect(ok(await get(ACT.traveller, `/requests/${id}`)).body.canPayVendors).toBe(false);
  });

  it("Finance marks paid with a ref + date; logged as VENDOR_PAYMENT", async () => {
    const cab = (await lines(id))[2];
    const r = ok(await patch(ACT.finance, `/requests/${id}/arrangements/${cab._id}/payment`, { paymentStatus: "PAID", paymentRef: " CHQ 004512 ", paidAt: "2026-10-14" })).body.line;
    expect(r).toMatchObject({ paymentStatus: "PAID", paymentRef: "CHQ 004512", paymentSource: "MANUAL", paidBy: String(U.finance) });
    expect(new Date(r.paidAt).toISOString()).toBe("2026-10-14T06:30:00.000Z"); // midday IST
    const log = (await trail(id, "VENDOR_PAYMENT")).pop()!;
    expect(log).toMatchObject({ stage: "FINANCE", actor: U.finance });
    expect(log.comment).toBe("CAB — CSTEPVEN0002 U K Cabs: UNPAID => PAID | Ref: CHQ 004512 | Paid on 2026-10-14");
  });

  it("Admin can too; a future date or bad status is refused; UNPAID clears the payment", async () => {
    const fl = (await lines(id))[0];
    expect((await patch(ACT.admin, `/requests/${id}/arrangements/${fl._id}/payment`, { paymentStatus: "PAID", paidAt: "2099-01-01" })).status).toBe(400);
    expect((await patch(ACT.admin, `/requests/${id}/arrangements/${fl._id}/payment`, { paymentStatus: "DONE" })).status).toBe(400);
    ok(await patch(ACT.admin, `/requests/${id}/arrangements/${fl._id}/payment`, { paymentStatus: "PAID", paymentRef: "UTR9" }));
    expect((await lines(id))[0]).toMatchObject({ paymentStatus: "PAID", paymentRef: "UTR9", paidBy: U.admin });
    ok(await patch(ACT.admin, `/requests/${id}/arrangements/${fl._id}/payment`, { paymentStatus: "UNPAID" }));
    const back = (await lines(id))[0];
    expect(back.paymentStatus).toBe("UNPAID");
    expect(back.paidAt).toBeUndefined();
    expect(back.paymentRef).toBeUndefined();
    expect((await trail(id, "VENDOR_PAYMENT")).pop()!.comment).toBe("FLIGHT — CSTEPVEN0001 Skyline Travels: PAID => UNPAID");
    ok(await patch(ACT.finance, `/requests/${id}/arrangements/${fl._id}/payment`, { paymentStatus: "PAID", paymentRef: "UTR77", paidAt: "2026-10-15" }));
  });

  it("still payable once the case moves on (REPORT_PENDING)", async () => {
    ok(await post(ACT.traveller, `/requests/${id}/report/start`));
    expect((await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!.status).toBe("REPORT_PENDING");
    const cab = (await lines(id))[2];
    ok(await patch(ACT.finance, `/requests/${id}/arrangements/${cab._id}/payment`, { paymentStatus: "PAID", paymentRef: "CHQ 004512", paidAt: "2026-10-14" }));
  });

  it("the Travel Register shows Agency / Paid / Cheque & Date", async () => {
    const r = await request(app)
      .get("/api/cstep/reports/travel-register?period=custom&from=2026-11-01&to=2026-11-30")
      .set("x-test-user", JSON.stringify(ACT.finance))
      .set("x-test-ws", String(WS))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as any);
    const ws = wb.worksheets[0];
    const rows: any[] = [];
    ws.eachRow((row, n) => {
      if (n > 2 && row.getCell(5).value === "QC vendor tour") {
        rows.push({ mode: row.getCell(10).value, agency: row.getCell(11).value, paid: row.getCell(16).value, cheque: row.getCell(18).value });
      }
    });
    // The FLIGHT row is still PENDING but carries the amount it had to have
    // before it could be paid — a real arrangement, so it is on the register.
    expect(rows.filter((x) => x.mode)).toEqual([
      { mode: "Air", agency: "Skyline Travels", paid: 8400, cheque: "UTR77 15.10.26" },
      { mode: "Rail", agency: null, paid: null, cheque: null },
      { mode: "CAB", agency: "U K Cabs", paid: 1485, cheque: "CHQ 004512 14.10.26" },
    ]);
  });
});

describe("Event Request — vendor + manual payment work the same way", () => {
  it("takes a vendor while arranging and a payment once arranged", async () => {
    const id = await arrangingRequest({
      formType: "EVENT_REQUEST", purpose: "QC workshop", departureDate: "2026-11-02", returnDate: "2026-11-04",
      hostInstitution: "QC Institute", eventNature: "WORKSHOP", eventLocation: "Bengaluru",
      eventParticipants: [{ organisation: "CSTEP" }],
    });
    const added = ok(await post(ACT.official, `/requests/${id}/arrangements`, { arrangedType: "OTHER", details: "Hall hire", amount: 50000, currency: "INR" })).body.line;
    ok(await patch(ACT.official, `/requests/${id}/arrangements/${added._id}`, { vendorId: String(V.hall), status: "ARRANGED" }));
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
    expect(ok(await get(ACT.finance, `/requests/${id}`)).body.canPayVendors).toBe(true);
    const paid = ok(await patch(ACT.finance, `/requests/${id}/arrangements/${added._id}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-EV-1" })).body.line;
    expect(paid).toMatchObject({ vendorName: "Lakeside Convention Hall", paymentStatus: "PAID", paymentRef: "UTR-EV-1", paymentSource: "MANUAL" });
    expect((await trail(id, "VENDOR_PAYMENT")).length).toBe(1);
  });

  it("the Official pays at the arrange step; it survives mark-arranged and Finance still sees and changes it", async () => {
    const id = await arrangingRequest({
      formType: "EVENT_REQUEST", purpose: "QC workshop 2", departureDate: "2026-11-05", returnDate: "2026-11-06",
      hostInstitution: "QC Institute", eventNature: "WORKSHOP", eventLocation: "Bengaluru",
      eventParticipants: [{ organisation: "CSTEP" }],
    });
    const added = ok(await post(ACT.official, `/requests/${id}/arrangements`, { arrangedType: "OTHER", details: "Hall hire", amount: 42000, currency: "INR", vendorId: String(V.hall) })).body.line;
    const paid = ok(await patch(ACT.official, `/requests/${id}/arrangements/${added._id}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-EV-ARR", paidAt: "2026-10-12" })).body.line;
    expect(paid).toMatchObject({ paymentStatus: "PAID", paymentRef: "UTR-EV-ARR", paidBy: String(U.official) });

    ok(await patch(ACT.official, `/requests/${id}/arrangements/${added._id}`, { status: "ARRANGED" }));
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
    const after = (await lines(id)).find((l) => String(l._id) === String(added._id))!;
    expect(after).toMatchObject({ paymentStatus: "PAID", paymentRef: "UTR-EV-ARR" });
    expect(new Date(after.paidAt).toISOString()).toBe("2026-10-12T06:30:00.000Z");

    const g = ok(await get(ACT.finance, `/requests/${id}`)).body;
    expect(g.canPayVendors).toBe(true);
    expect(g.arrangements.find((l: any) => l._id === String(added._id)).paymentRef).toBe("UTR-EV-ARR");
    ok(await patch(ACT.finance, `/requests/${id}/arrangements/${added._id}/payment`, { paymentStatus: "UNPAID" }));
    ok(await patch(ACT.finance, `/requests/${id}/arrangements/${added._id}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-EV-FIN" }));
    expect((await trail(id, "VENDOR_PAYMENT")).map((e) => e.stage)).toEqual(["OFFICIAL", "FINANCE", "FINANCE"]);
  });
});

describe("claims have no arrangement lines to pay", () => {
  it("canPayVendors is false on a Local Travel Claim", async () => {
    const r = ok(
      await post(ACT.traveller, "/requests", {
        formType: "LOCAL_TRAVEL_CLAIM", purpose: "City meetings", project: "PRJ-QC",
        departureDate: "2026-10-05", returnDate: "2026-10-09", travelLines: [], foodLines: [], otherExpenses: 40,
      }),
    );
    expect(ok(await get(ACT.finance, `/requests/${r.body.request._id}`)).body.canPayVendors).toBe(false);
  });
});
