// apps/backend/src/routes/cstep.vendorPayables.test.ts
//
// CSTEP Finance vendor payables + payment upload — routes/cstep.vendorPayables.ts,
// plus the EVR reference Event Requests now get at approval (routes/cstep.ts).
// The payables list and its scoping (Finance → own travellers, Admin → all),
// an xlsx export that IS the import template (Reference typed as text), and
// the preview → commit import: vendor by code, request by reference read as
// text (new "0001/MMYY", an old suffixed TIN, an EVR), every unpaid line of
// the pair flipped with Paid On + ref, IMPORT source and one batch id, a
// VENDOR_PAYMENT entry per line, one outcome per row, and a harmless re-import.
//
// Real: cstep + vendor-payables routers, models, sheetImport, in-memory Mongo
//   REPLICA SET (approve runs in a transaction) on a fresh database,
//   cstep_qc_vendorpay.
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
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_vendorpay";
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
const { default: payablesRouter } = await import("./cstep.vendorPayables.js");

const DB = "cstep_qc_vendorpay";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
// Project Master — every request needs a project picked from the master.
// One QC project, added to a create body that names none (QC_PROJECT seeded
// in beforeAll).
const QC_PROJECT = oid();
const withProject = (path: string, body: any) =>
  path === "/requests" && body && body.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body;
const U = { travA: oid(), travB: oid(), approver: oid(), official: oid(), finA: oid(), finB: oid(), admin: oid(), plain: oid() };
const TP = { a: oid(), b: oid() };
const VT = oid();
const V = { sky: oid(), uk: oid(), hall: oid() };

const fakeAuth = (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = new mongoose.Types.ObjectId(String(req.headers["x-test-ws"] || WS));
  next();
};
const app = express();
app.use(express.json());
app.use("/api/cstep/vendor-payables", fakeAuth, payablesRouter);
app.use("/api/cstep", fakeAuth, cstepRouter);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = {
  travA: who(U.travA),
  travB: who(U.travB),
  approver: who(U.approver, ["APPROVER"]),
  official: who(U.official),
  finA: who(U.finA),
  finB: who(U.finB),
  admin: who(U.admin, ["ADMIN"]),
  plain: who(U.plain),
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
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
const upload = (step: "preview" | "commit", as: any, buf: Buffer, name = "payments.xlsx") =>
  request(app)
    .post(`/api/cstep/vendor-payables/import/${step}`)
    .set("x-test-user", JSON.stringify(as))
    .set("x-test-ws", String(WS))
    .attach("file", buf, name);

const MMYY = (() => {
  const d = new Date(Date.now() + 330 * 60 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
})();
const TODAY = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

const OLD_TIN = "CSTEP-004/1026-2";
const ids: Record<string, string> = {};

/** Files + approves + arranges a request with the given vendor lines, marks it arranged. */
async function arrangedRequest(as: any, body: any, lines: Array<{ type: string; vendorId: any; amount: number }>) {
  const id = String(ok(await post(as, "/requests", body)).body.request._id);
  const ref = ok(await post(ACT.approver, `/requests/${id}/approve`)).body.claimReference;
  ok(await post(ACT.official, `/requests/${id}/start-arranging`));
  for (const l of lines) {
    const line = ok(await post(ACT.official, `/requests/${id}/arrangements`, { arrangedType: l.type, vendorId: String(l.vendorId), amount: l.amount, currency: "INR" })).body.line;
    ok(await patch(ACT.official, `/requests/${id}/arrangements/${line._id}`, { status: "ARRANGED" }));
  }
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  return { id, ref };
}

/** A request planted directly (old-format TIN / another traveller / cancelled). */
async function plantRequest(ref: string, travelerProfileId: any, status: string, lines: Array<{ type: string; vendor: "sky" | "uk" | "hall"; amount: number }>) {
  const _id = oid();
  const now = new Date();
  await col("csteptravelrequests").insertOne({
    _id, workspaceId: WS, travelerProfileId, createdBy: U.travA, formType: "TOUR_PROPOSAL", type: "DOMESTIC",
    purpose: `Planted ${ref}`, departureDate: "2026-11-20", returnDate: "2026-11-21", stations: [{ from: "A", to: "B" }],
    status, claimReference: ref, createdAt: now, updatedAt: now,
  } as any);
  const vendors: any = await col("cstepvendors").find({}).toArray();
  const byKey = { sky: V.sky, uk: V.uk, hall: V.hall };
  await col("csteparrangements").insertMany(
    lines.map((l) => {
      const v = vendors.find((x: any) => String(x._id) === String(byKey[l.vendor]));
      return {
        workspaceId: WS, requestId: _id, source: "ADDED", arrangedType: l.type, status: "ARRANGED", currency: "INR",
        amount: l.amount, exchangeRate: 1, amountInr: l.amount, vendorId: v._id, vendorCode: v.vendorCode, vendorName: v.name,
        paymentStatus: "UNPAID", createdBy: U.official, createdAt: now, updatedAt: now,
      };
    }) as any[],
  );
  return String(_id);
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
      _id: TP.a, workspaceId: WS, travelerId: "E-001", firstName: "Asha", lastName: "Rao", isActive: true,
      email: `${U.travA}@qc.local`, claimedBy: U.travA, tourApproverId: U.approver, officialUserId: U.official, financeUserId: U.finA,
    },
    {
      _id: TP.b, workspaceId: WS, travelerId: "E-002", firstName: "Ravi", lastName: "Kumar", isActive: true,
      email: `${U.travB}@qc.local`, claimedBy: U.travB, tourApproverId: U.approver, officialUserId: U.official, financeUserId: U.finB,
    },
  ] as any[]);
  await col("cstepvendortypes").insertOne({ _id: VT, workspaceId: WS, name: "Travel", isActive: true } as any);
  const vendor = (_id: any, vendorCode: string, name: string) => ({ _id, workspaceId: WS, vendorCode, name, vendorTypeId: VT, isActive: true, createdAt: now, updatedAt: now });
  await col("cstepvendors").insertMany([
    vendor(V.sky, "CSTEPVEN0001", "Skyline Travels"),
    vendor(V.uk, "CSTEPVEN0002", "U K Cabs"),
    vendor(V.hall, "CSTEPVEN0003", "Lakeside Convention Hall"),
  ] as any[]);

  // Tour (traveller A): two Skyline lines + one U K Cabs line.
  const tour = await arrangedRequest(
    ACT.travA,
    { type: "DOMESTIC", purpose: "QC tour", departureDate: "2026-11-10", returnDate: "2026-11-12", stations: [{ from: "Bengaluru", to: "Delhi" }] },
    [
      { type: "FLIGHT", vendorId: V.sky, amount: 5200 },
      { type: "FLIGHT", vendorId: V.sky, amount: 4800 },
      { type: "CAB", vendorId: V.uk, amount: 1485 },
    ],
  );
  ids.tour = tour.id;
  ids.tourRef = tour.ref;
  // Event Request (traveller A) — Option A: EVR reference at approval.
  const event = await arrangedRequest(
    ACT.travA,
    {
      formType: "EVENT_REQUEST", purpose: "QC workshop", departureDate: "2026-11-02", returnDate: "2026-11-04",
      hostInstitution: "QC Institute", eventNature: "WORKSHOP", eventLocation: "Bengaluru", eventParticipants: [{ organisation: "CSTEP" }],
    },
    [{ type: "OTHER", vendorId: V.hall, amount: 50000 }],
  );
  ids.event = event.id;
  ids.eventRef = event.ref;
  ids.old = await plantRequest(OLD_TIN, TP.a, "REPORT_PENDING", [{ type: "CAB", vendor: "uk", amount: 900 }]);
  ids.other = await plantRequest(`0099/${MMYY}`, TP.b, "ARRANGED", [{ type: "HOTEL", vendor: "sky", amount: 7000 }]);
  // Not payable: a cancelled case's vendor lines never reach the payables.
  ids.arranging = await plantRequest(`0098/${MMYY}`, TP.a, "CANCELLED", [{ type: "HOTEL", vendor: "sky", amount: 3000 }]);
}, 240_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("Option A — Event Request reference", () => {
  it("an approved Event Request carries EVR0001/MMYY and its own counter", async () => {
    expect(ids.tourRef).toBe(`0001/${MMYY}`);
    expect(ids.eventRef).toBe(`EVR0001/${MMYY}`);
    expect((await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(ids.event) }))!.claimReference).toBe(`EVR0001/${MMYY}`);
  });
});

describe("payables list — scoping and filters", () => {
  it("a user with no Finance mapping is refused; Admin sees every line, Finance A only traveller A's", async () => {
    expect((await get(ACT.plain, "/vendor-payables")).status).toBe(403);
    const all = ok(await get(ACT.admin, "/vendor-payables")).body;
    expect(all.scope).toBe("ALL");
    // tour 3 + event 1 + old 1 + other traveller 1 — the ARRANGING one is not payable yet
    expect(all.rows).toHaveLength(6);
    const mine = ok(await get(ACT.finA, "/vendor-payables")).body;
    expect(mine.scope).toBe("MINE");
    expect(mine.rows.map((r: any) => r.reference).sort()).toEqual(
      [OLD_TIN, `0001/${MMYY}`, `0001/${MMYY}`, `0001/${MMYY}`, `EVR0001/${MMYY}`].sort(),
    );
    expect(mine.totals).toMatchObject({ lines: 5, unpaidLines: 5, unpaidInr: 5200 + 4800 + 1485 + 50000 + 900 });
    const b = ok(await get(ACT.finB, "/vendor-payables")).body.rows;
    expect(b.map((r: any) => r.reference)).toEqual([`0099/${MMYY}`]);
  });

  it("filters by vendor, payment status and departure period", async () => {
    const sky = ok(await get(ACT.admin, `/vendor-payables?vendorId=${V.sky}`)).body.rows;
    expect(sky.map((r: any) => r.vendorCode)).toEqual(["CSTEPVEN0001", "CSTEPVEN0001", "CSTEPVEN0001"]);
    expect(ok(await get(ACT.admin, "/vendor-payables?paymentStatus=PAID")).body.rows).toHaveLength(0);
    const nov = ok(await get(ACT.admin, "/vendor-payables?from=2026-11-01&to=2026-11-05")).body.rows;
    expect(nov.map((r: any) => r.reference)).toEqual([`EVR0001/${MMYY}`]);
    expect((await get(ACT.admin, "/vendor-payables?paymentStatus=maybe")).status).toBe(400);
  });
});

describe("export = import template", () => {
  let exported: Buffer;

  it("the template is the import columns with no rows, text columns kept; a plain user is refused", async () => {
    const get = (as: any) => binary(request(app).get("/api/cstep/vendor-payables/template").set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS)));
    expect((await get(ACT.plain)).status).toBe(403);
    const r = await get(ACT.finA);
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as any);
    const ws = wb.worksheets[0];
    expect((ws.getRow(1).values as any[]).slice(1)).toEqual([
      "Vendor Code", "Vendor Name", "Reference", "Traveller", "Service", "Amount INR", "Payment Status", "Paid On", "Payment Ref",
    ]);
    expect(ws.actualRowCount).toBe(1);
    for (const c of [1, 3, 8, 9]) expect(ws.getColumn(c).numFmt).toBe("@");
  });

  it("exports the payables with the template columns, Reference typed as text", async () => {
    // Pay the tour's U K Cabs line by hand first, so the sheet carries a PAID row.
    const cab = await col("csteparrangements").findOne({ requestId: new mongoose.Types.ObjectId(ids.tour), vendorId: V.uk });
    ok(await patch(ACT.finA, `/requests/${ids.tour}/arrangements/${cab!._id}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-MANUAL", paidAt: "2026-10-10" }));

    const r = await binary(request(app).get("/api/cstep/vendor-payables/export").set("x-test-user", JSON.stringify(ACT.finA)).set("x-test-ws", String(WS)));
    expect(r.status).toBe(200);
    exported = r.body as Buffer;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exported as any);
    const ws = wb.worksheets[0];
    expect((ws.getRow(1).values as any[]).slice(1)).toEqual([
      "Vendor Code", "Vendor Name", "Reference", "Traveller", "Service", "Amount INR", "Payment Status", "Paid On", "Payment Ref",
    ]);
    expect(ws.getColumn(3).numFmt).toBe("@");
    const rows: any[] = [];
    ws.eachRow((row, n) => n > 1 && rows.push((row.values as any[]).slice(1)));
    expect(rows).toHaveLength(5);
    expect(rows.every((x) => typeof x[2] === "string")).toBe(true);
    const cabRow = rows.find((x) => x[0] === "CSTEPVEN0002" && x[2] === `0001/${MMYY}`);
    expect(cabRow.slice(3)).toEqual(["Asha Rao", "Cab", 1485, "Paid", "2026-10-10", "UTR-MANUAL"]);
    expect(rows.find((x) => x[2] === OLD_TIN)[6]).toBe("Unpaid");
  });

  describe("import — preview then commit", () => {
    let file: Buffer;

    beforeAll(async () => {
      // Finance fills in the exported sheet and adds a few rows of their own.
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(exported as any);
      const ws = wb.worksheets[0];
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const code = row.getCell(1).value;
        const ref = row.getCell(3).value;
        if (code === "CSTEPVEN0001" && ref === `0001/${MMYY}`) {
          row.getCell(8).value = "2026-10-15";
          row.getCell(9).value = "UTR-SKY-778";
        }
        if (ref === OLD_TIN) {
          row.getCell(8).value = "16/10/2026"; // DD/MM/YYYY typed as text
          row.getCell(9).value = "CHQ 4512";
        }
        if (ref === `EVR0001/${MMYY}`) {
          row.getCell(8).value = new Date(Date.UTC(2026, 9, 14)); // a real Excel date cell
          row.getCell(9).value = "UTR-HALL";
        }
        if (code === "CSTEPVEN0002" && ref === `0001/${MMYY}`) row.getCell(8).value = "2026-10-12"; // already paid by hand
      });
      const extra = (vals: any[]) => ws.addRow(vals);
      extra(["CSTEPVEN0999", "Nobody", `0001/${MMYY}`, "", "", "", "Paid", "2026-10-15", "X"]); //  unknown vendor
      extra(["CSTEPVEN0001", "Skyline", "7777/1026", "", "", "", "Paid", "2026-10-15", "X"]); //          unknown reference
      extra(["CSTEPVEN0001", "Skyline", `0099/${MMYY}`, "", "", "", "Paid", "2026-10-15", "X"]); //       other traveller
      extra(["CSTEPVEN0003", "Hall", `0001/${MMYY}`, "", "", "", "Paid", "2026-10-15", "X"]); //          vendor not on that tour
      extra(["CSTEPVEN0001", "Skyline", `0098/${MMYY}`, "", "", "", "Paid", "2026-10-15", "X"]); //       cancelled
      // A reference Excel turned into a date (cell re-formatted as a date) …
      extra(["CSTEPVEN0001", "Skyline", new Date(Date.UTC(2026, 0, 1)), "", "", "", "Paid", "2026-10-15", "X"]).getCell(3).numFmt = "dd-mm-yyyy";
      // … and one that became a number.
      extra(["CSTEPVEN0001", "Skyline", 11026, "", "", "", "Paid", "2026-10-15", "X"]).getCell(3).numFmt = "0";
      extra(["CSTEPVEN0002", "U K Cabs", OLD_TIN, "", "", "", "Paid", "2099-01-01", "X"]); //              future date (pair still unpaid)
      file = Buffer.from(await wb.xlsx.writeBuffer());
    });

    const outcomes = (body: any) =>
      body.results.map((r: any) => [r.vendorCode, r.reference, r.outcome, r.paidLines ?? null]);

    it("preview reports one outcome per row and writes nothing", async () => {
      const before = await col("csteparrangements").find({}).sort({ _id: 1 }).toArray();
      const auditBefore = await col("cstepapprovals").countDocuments({ action: "VENDOR_PAYMENT" });
      const r = ok(await upload("preview", ACT.finA, file)).body;
      expect(r.dryRun).toBe(true);
      expect(r.batchId).toBeNull();
      expect(r.counts).toMatchObject({ PAID: 3, ALREADY_PAID: 2, UNKNOWN_VENDOR: 1, UNKNOWN_REFERENCE: 3, OUT_OF_SCOPE: 1, NO_UNPAID_LINES: 2, INVALID: 1, NOT_MARKED_PAID: 0 });
      expect(await col("csteparrangements").find({}).sort({ _id: 1 }).toArray()).toEqual(before);
      expect(await col("cstepapprovals").countDocuments({ action: "VENDOR_PAYMENT" })).toBe(auditBefore);
      const byRef = (code: string, ref: string) => r.results.filter((x: any) => x.vendorCode === code && x.reference === ref);
      // The tour's two Skyline rows are one (vendor, reference) pair: the first pays both lines.
      expect(byRef("CSTEPVEN0001", `0001/${MMYY}`).map((x: any) => [x.outcome, x.paidLines ?? null])).toEqual([["PAID", 2], ["ALREADY_PAID", null]]);
      expect(byRef("CSTEPVEN0001", `0001/${MMYY}`)[1].reason).toMatch(/^Same vendor and reference as row \d+ of this file/);
      expect(byRef("CSTEPVEN0002", OLD_TIN)[0]).toMatchObject({ outcome: "PAID", paidLines: 1 }); // old suffixed TIN, exact
      expect(byRef("CSTEPVEN0003", `EVR0001/${MMYY}`)[0]).toMatchObject({ outcome: "PAID", paidLines: 1 }); // Option A
      expect(byRef("CSTEPVEN0002", `0001/${MMYY}`)[0].outcome).toBe("ALREADY_PAID");
      expect(byRef("CSTEPVEN0999", `0001/${MMYY}`)[0].outcome).toBe("UNKNOWN_VENDOR");
      expect(byRef("CSTEPVEN0001", "7777/1026")[0].outcome).toBe("UNKNOWN_REFERENCE");
      expect(byRef("CSTEPVEN0001", `0099/${MMYY}`)[0].outcome).toBe("OUT_OF_SCOPE");
      expect(byRef("CSTEPVEN0003", `0001/${MMYY}`)[0]).toMatchObject({ outcome: "NO_UNPAID_LINES", reason: `No arrangement line on 0001/${MMYY} is booked with CSTEPVEN0003` });
      expect(byRef("CSTEPVEN0001", `0098/${MMYY}`)[0].reason).toBe(`0098/${MMYY} is CANCELLED — vendor payments are recorded once it is being arranged`);
      const garbled = r.results.filter((x: any) => x.outcome === "UNKNOWN_REFERENCE" && !x.reference).map((x: any) => x.reason);
      expect(garbled).toHaveLength(2);
      expect(garbled[0]).toMatch(/^Reference was read as a date/);
      expect(garbled[1]).toMatch(/^Reference was read as a number/);
      expect(r.results.find((x: any) => x.outcome === "INVALID").reason).toMatch(/is in the future/);
    });

    it("commit flips the matched lines with ref, date, IMPORT and one batch id, logging each", async () => {
      const r = ok(await upload("commit", ACT.finA, file)).body;
      expect(r).toMatchObject({ dryRun: false, paidRows: 3, paidLines: 4 });
      expect(r.batchId).toMatch(/^[0-9a-f]{24}$/);
      const flipped = await col("csteparrangements").find({ paymentSource: "IMPORT" }).toArray();
      expect(flipped).toHaveLength(4);
      expect(new Set(flipped.map((l: any) => String(l.paymentBatchId)))).toEqual(new Set([r.batchId]));
      for (const l of flipped) expect(l).toMatchObject({ paymentStatus: "PAID", paidBy: U.finA });
      const sky = flipped.filter((l: any) => String(l.vendorId) === String(V.sky));
      expect(sky.map((l: any) => [l.paymentRef, l.paidAt.toISOString()])).toEqual([
        ["UTR-SKY-778", "2026-10-15T06:30:00.000Z"],
        ["UTR-SKY-778", "2026-10-15T06:30:00.000Z"],
      ]);
      expect(flipped.find((l: any) => String(l.requestId) === ids.old)).toMatchObject({ paymentRef: "CHQ 4512" });
      expect(flipped.find((l: any) => String(l.requestId) === ids.old)!.paidAt.toISOString()).toBe("2026-10-16T06:30:00.000Z");
      expect(flipped.find((l: any) => String(l.requestId) === ids.event)!.paidAt.toISOString()).toBe("2026-10-14T06:30:00.000Z");
      // The hand-paid line kept its own payment.
      const cab = await col("csteparrangements").findOne({ requestId: new mongoose.Types.ObjectId(ids.tour), vendorId: V.uk });
      expect(cab).toMatchObject({ paymentSource: "MANUAL", paymentRef: "UTR-MANUAL" });
      // One VENDOR_PAYMENT per flipped line, naming the batch.
      const audit = await col("cstepapprovals").find({ action: "VENDOR_PAYMENT", comment: { $regex: r.batchId } }).toArray();
      expect(audit).toHaveLength(4);
      expect(audit.find((a: any) => String(a.entityId) === ids.event)!.comment).toBe(
        `OTHER — CSTEPVEN0003 Lakeside Convention Hall: UNPAID => PAID | Ref: UTR-HALL | Paid on 2026-10-14 | Import batch ${r.batchId}`,
      );
      // Out-of-scope and cancelled lines untouched.
      expect(await col("csteparrangements").findOne({ requestId: new mongoose.Types.ObjectId(ids.other) })).toMatchObject({ paymentStatus: "UNPAID" });
      expect(await col("csteparrangements").findOne({ requestId: new mongoose.Types.ObjectId(ids.arranging) })).toMatchObject({ paymentStatus: "UNPAID" });
    });

    it("re-importing the same sheet changes nothing", async () => {
      const before = await col("csteparrangements").find({}).sort({ _id: 1 }).toArray();
      const auditBefore = await col("cstepapprovals").countDocuments({ action: "VENDOR_PAYMENT" });
      const r = ok(await upload("commit", ACT.finA, file)).body;
      expect(r.paidLines).toBe(0);
      expect(r.batchId).toBeNull();
      expect(r.counts.ALREADY_PAID).toBe(5);
      expect(r.counts.PAID).toBe(0);
      expect(await col("csteparrangements").find({}).sort({ _id: 1 }).toArray()).toEqual(before);
      expect(await col("cstepapprovals").countDocuments({ action: "VENDOR_PAYMENT" })).toBe(auditBefore);
    });

    it("the payables view reflects the import", async () => {
      const paid = ok(await get(ACT.finA, "/vendor-payables?paymentStatus=PAID")).body.rows;
      expect(paid).toHaveLength(5);
      expect(paid.find((x: any) => x.reference === OLD_TIN)).toMatchObject({ paidOn: "2026-10-16", paymentRef: "CHQ 4512", paymentSource: "IMPORT" });
      expect(ok(await get(ACT.finA, "/vendor-payables?paymentStatus=UNPAID")).body.rows).toHaveLength(0);
    });
  });
});

describe("Admin pays any traveller; CSV works too", () => {
  it("the row Finance A was refused, Admin pays (CSV, reference as text)", async () => {
    const csv = Buffer.from(
      ["Vendor Code,Vendor Name,Reference,Traveller,Service,Amount INR,Payment Status,Paid On,Payment Ref", `CSTEPVEN0001,Skyline,0099/${MMYY},,,,Paid,${TODAY},UTR-ADMIN`].join("\n") + "\n",
    );
    expect(ok(await upload("commit", ACT.finA, csv, "p.csv")).body.counts.OUT_OF_SCOPE).toBe(1);
    const r = ok(await upload("commit", ACT.admin, csv, "p.csv")).body;
    expect(r.results[0]).toMatchObject({ outcome: "PAID", paidLines: 1 });
    expect(await col("csteparrangements").findOne({ requestId: new mongoose.Types.ObjectId(ids.other) })).toMatchObject({
      paymentStatus: "PAID", paymentRef: "UTR-ADMIN", paymentSource: "IMPORT", paidBy: U.admin,
    });
  });

  it("a row not marked paid is left alone; a plain user can't import", async () => {
    const csv = Buffer.from(
      ["Vendor Code,Reference,Payment Status,Paid On", `CSTEPVEN0001,0098/${MMYY},Unpaid,`].join("\n") + "\n",
    );
    expect(ok(await upload("preview", ACT.admin, csv, "p.csv")).body.results[0]).toMatchObject({ outcome: "NOT_MARKED_PAID" });
    expect((await upload("preview", ACT.plain, csv, "p.csv")).status).toBe(403);
  });
});

describe("payment at the arrange step — one source of truth per line", () => {
  it("an ARRANGING request's vendor line is listed, payable by import, and its paid state shows in the payables", async () => {
    const ref = `0097/${MMYY}`;
    const id = await plantRequest(ref, TP.a, "ARRANGING", [{ type: "FLIGHT", vendor: "sky", amount: 6400 }]);
    const listed = ok(await get(ACT.finA, "/vendor-payables?paymentStatus=UNPAID")).body.rows.filter((r: any) => r.reference === ref);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ requestStatus: "ARRANGING", vendorCode: "CSTEPVEN0001", amountInr: 6400, paymentStatus: "UNPAID" });

    const csv = Buffer.from(["Vendor Code,Reference,Paid On,Payment Ref", `CSTEPVEN0001,${ref},2026-10-16,UTR-ARR-IMP`].join("\n") + "\n");
    const r = ok(await upload("commit", ACT.finA, csv, "arranging.csv")).body;
    expect(r.results[0]).toMatchObject({ outcome: "PAID" });
    const line: any = await col("csteparrangements").findOne({ requestId: new mongoose.Types.ObjectId(id) });
    expect(line).toMatchObject({ paymentStatus: "PAID", paymentRef: "UTR-ARR-IMP", paymentSource: "IMPORT" });

    const paidRow = ok(await get(ACT.admin, "/vendor-payables?paymentStatus=PAID")).body.rows.find((x: any) => x.reference === ref);
    expect(paidRow).toMatchObject({ paymentStatus: "PAID", paidOn: "2026-10-16", paymentRef: "UTR-ARR-IMP", requestStatus: "ARRANGING" });
  });
});

describe("Option A — the register's TIN column carries the EVR reference", () => {
  it("Event row shows EVR0001/MMYY", async () => {
    const r = await binary(
      request(app)
        .get("/api/cstep/reports/travel-register?period=custom&from=2026-11-01&to=2026-11-05")
        .set("x-test-user", JSON.stringify(ACT.admin))
        .set("x-test-ws", String(WS)),
    );
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as any);
    const tins: any[] = [];
    wb.worksheets[0].eachRow((row, n) => n > 2 && row.getCell(5).value === "QC workshop" && tins.push(row.getCell(2).value));
    expect(tins.length).toBeGreaterThan(0);
    expect(new Set(tins)).toEqual(new Set([`EVR0001/${MMYY}`]));
  });
});
