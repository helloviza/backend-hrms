// apps/backend/src/routes/cstep.sequence.test.ts
//
// CSTEP reference series — the shared serial counter (utils/cstepSequence.ts)
// and the references approve issues from it: Tour TIN "0001/1026", Local
// Travel "LTC0001/1026", Expense "EXP0001/1026", Event Request
// "EVR0001/1026". Covers per-series increments, independence of the per-FY
// series, the IST financial-year reset (31 Mar 23:30 vs 1 Apr 00:30 IST),
// IST MMYY across the UTC midnight, the continuous vendor series, the
// forward-only start (helper + CSTEP-Admin route), growth past 9999,
// rollback with an aborted transaction, concurrent takes, the duplicate-key
// backstop, and that references issued in the old formats are never touched.
//
// Real: cstep router, models, Counter, in-memory Mongo REPLICA SET (approve
//   runs in a transaction) on a fresh database, cstep_qc_seq.
// Stubbed: S3 upload/presign, mail, the Event Request + packet PDF helpers,
//   auth (x-test-user) and the workspace resolver (x-test-ws).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_seq";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

let uploadSeq = 0;
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async (args: any) => ({ key: `${args.keyPrefix}/qc-${++uploadSeq}` })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));

const { default: cstepRouter } = await import("./cstep.js");
const { default: Counter } = await import("../models/Counter.js");
const seqLib = await import("../utils/cstepSequence.js");
const {
  nextCstepSerial,
  seedCstepSerial,
  peekCstepSerial,
  cstepSeriesKey,
  cstepFyStartYear,
  cstepMMYY,
  formatCstepTin,
  formatCstepClaimReference,
  formatCstepVendorCode,
} = seqLib;

const DB = "cstep_qc_seq";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
// Project Master — every request needs a project picked from the master.
// One QC project, added to a create body that names none (QC_PROJECT seeded
// in beforeAll).
const QC_PROJECT = oid();
const withProject = (path: string, body: any) =>
  path === "/requests" && body && body.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body; // the router workspace — approve + the admin routes
const WS_LIB = oid(); // helper-level checks, kept apart from the router's counters
const U = { traveller: oid(), approver: oid(), noCode: oid(), admin: oid(), other: oid() };
const TP = { main: oid(), noCode: oid() };

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
  noCode: who(U.noCode),
  admin: who(U.admin, ["ADMIN"]),
  other: who(U.other),
};
const send = (method: "get" | "post" | "put", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
  return body === undefined ? r : r.send(body);
};
const post = (as: any, path: string, body: any = {}) => send("post", as, path, withProject(path, body));
const put = (as: any, path: string, body: any = {}) => send("put", as, path, body);
const get = (as: any, path: string) => send("get", as, path);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const stage = async (as: any, documentType: string) =>
  String(
    ok(
      await request(app)
        .post("/api/cstep/attachments/staging")
        .set("x-test-user", JSON.stringify(as))
        .set("x-test-ws", String(WS))
        .field("documentType", documentType)
        .attach("file", Buffer.from("%PDF-1.4 qc"), { filename: "doc.pdf", contentType: "application/pdf" }),
    ).body.attachment._id,
  );

// IST instants used for the boundary checks (IST = UTC+05:30).
const IST = (iso: string) => new Date(`${iso}+05:30`);
const MAR31_2330 = IST("2027-03-31T23:30:00");
const APR01_0030 = IST("2027-04-01T00:30:00");

const NOW_MMYY = cstepMMYY();
const NOW_FY = cstepFyStartYear();

// References issued in the old formats before this change — must survive untouched.
const HIST = {
  tour: oid(), tour2: oid(), ltc: oid(), exc: oid(), claim: oid(), claim2: oid(),
};
const HIST_REFS = {
  tour: `CSTEP-001/${NOW_MMYY}`,
  tour2: `CSTEP-001/${NOW_MMYY}-2`,
  ltc: `LTC/CSTEP-001/${NOW_MMYY}`,
  exc: `EXC/CSTEP-001/${NOW_MMYY}`,
};
const HIST_AT = new Date("2026-10-01T06:00:00Z");

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

  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertMany([
    {
      _id: TP.main, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
      email: `${U.traveller}@qc.local`, claimedBy: U.traveller, tourApproverId: U.approver,
    },
    // No travelerId at all — approve no longer needs one.
    { _id: TP.noCode, workspaceId: WS, firstName: "Neel", lastName: "M", isActive: true, email: `${U.noCode}@qc.local`, claimedBy: U.noCode, tourApproverId: U.approver },
  ] as any[]);

  const histBase = { workspaceId: WS, travelerProfileId: TP.main, status: "APPROVED", createdBy: U.traveller, createdAt: HIST_AT, updatedAt: HIST_AT };
  await col("csteptravelrequests").insertMany([
    { _id: HIST.tour, ...histBase, formType: "TOUR_PROPOSAL", type: "DOMESTIC", purpose: "Historical tour", claimReference: HIST_REFS.tour },
    { _id: HIST.tour2, ...histBase, formType: "TOUR_PROPOSAL", type: "DOMESTIC", purpose: "Historical tour 2", claimReference: HIST_REFS.tour2 },
    { _id: HIST.ltc, ...histBase, formType: "LOCAL_TRAVEL_CLAIM", purpose: "Historical LTC", claimReference: HIST_REFS.ltc, claimTotals: { gross: 1 } },
    { _id: HIST.exc, ...histBase, formType: "EXPENSE_CLAIM", purpose: "Historical EXC", claimReference: HIST_REFS.exc, claimTotals: { gross: 1 } },
  ] as any[]);
  await col("cstepclaims").insertMany([
    { _id: HIST.claim, workspaceId: WS, travelerProfileId: TP.main, travelRequestId: HIST.tour, claimReference: HIST_REFS.tour, status: "CLAIM_IN_PROGRESS", createdBy: U.traveller, createdAt: HIST_AT, updatedAt: HIST_AT },
    { _id: HIST.claim2, workspaceId: WS, travelerProfileId: TP.main, travelRequestId: HIST.tour2, claimReference: HIST_REFS.tour2, status: "CLAIM_IN_PROGRESS", createdBy: U.traveller, createdAt: HIST_AT, updatedAt: HIST_AT },
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("IST calendar — financial year and MMYY", () => {
  it("31 Mar 23:30 IST and 1 Apr 00:30 IST fall in different financial years (both are 31 Mar in UTC)", () => {
    expect(MAR31_2330.toISOString()).toBe("2027-03-31T18:00:00.000Z");
    expect(APR01_0030.toISOString()).toBe("2027-03-31T19:00:00.000Z");
    expect(cstepFyStartYear(MAR31_2330)).toBe(2026);
    expect(cstepFyStartYear(APR01_0030)).toBe(2027);
    expect(cstepSeriesKey(WS_LIB, "TIN", { at: MAR31_2330 })).toBe(`cstep:${WS_LIB}:TIN:FY2026`);
    expect(cstepSeriesKey(WS_LIB, "TIN", { at: APR01_0030 })).toBe(`cstep:${WS_LIB}:TIN:FY2027`);
  });

  it("MMYY follows the IST date across the UTC→IST midnight", () => {
    // 31 Oct 23:30 IST = 18:00 UTC; 1 Nov 00:30 IST = 31 Oct 19:00 UTC.
    expect(cstepMMYY(IST("2026-10-31T23:30:00"))).toBe("1026");
    expect(cstepMMYY(IST("2026-11-01T00:30:00"))).toBe("1126");
    expect(new Date(IST("2026-11-01T00:30:00")).getUTCMonth() + 1).toBe(10); // UTC would still say October
    // Year rollover too: 1 Jan 00:10 IST is still 31 Dec in UTC.
    expect(cstepMMYY(IST("2027-01-01T00:10:00"))).toBe("0127");
    expect(cstepMMYY(MAR31_2330)).toBe("0327");
    expect(cstepMMYY(APR01_0030)).toBe("0427");
  });
});

describe("formatters — exact formats, zero-pad to 4, grow past 9999", () => {
  it("TIN, LTC, EXP and vendor code", () => {
    expect(formatCstepTin(1, "1026")).toBe("0001/1026");
    expect(formatCstepClaimReference("LTC", 1, "1026")).toBe("LTC0001/1026");
    expect(formatCstepClaimReference("EXP", 1, "1026")).toBe("EXP0001/1026");
    expect(formatCstepVendorCode(1)).toBe("CSTEPVEN0001");
    expect(formatCstepTin(9999, "1026")).toBe("9999/1026");
    expect(formatCstepTin(10000, "1026")).toBe("10000/1026");
    expect(formatCstepClaimReference("LTC", 12345, "0427")).toBe("LTC12345/0427");
    expect(formatCstepVendorCode(10000)).toBe("CSTEPVEN10000");
  });
});

describe("nextCstepSerial — counters", () => {
  const at = IST("2026-10-17T12:00:00");

  it("increments per series", async () => {
    const got = [];
    for (let i = 0; i < 3; i++) got.push((await nextCstepSerial(WS_LIB, "TIN", { at })).seq);
    expect(got).toEqual([1, 2, 3]);
    const doc: any = await col("counters").findOne({ _id: `cstep:${WS_LIB}:TIN:FY2026` as any });
    expect(doc.seq).toBe(3);
  });

  it("the three per-FY series are independent", async () => {
    expect((await nextCstepSerial(WS_LIB, "LTC", { at })).seq).toBe(1);
    expect((await nextCstepSerial(WS_LIB, "EXP", { at })).seq).toBe(1);
    expect((await nextCstepSerial(WS_LIB, "LTC", { at })).seq).toBe(2);
    expect((await nextCstepSerial(WS_LIB, "TIN", { at })).seq).toBe(4);
    expect((await peekCstepSerial(WS_LIB, "EXP", { at })).next).toBe(2);
  });

  it("another workspace has its own series", async () => {
    expect((await nextCstepSerial(oid(), "TIN", { at })).seq).toBe(1);
  });

  it("FY reset at the IST 1 Apr boundary: 31 Mar 23:30 continues FY2026, 1 Apr 00:30 starts FY2027 at the seeded start", async () => {
    const ws = oid();
    await seedCstepSerial(ws, "TIN", 40, { fyStartYear: 2026 });
    expect(await seedCstepSerial(ws, "TIN", 7, { fyStartYear: 2027 })).toMatchObject({ ok: true, next: 7 });
    const before = await nextCstepSerial(ws, "TIN", { at: MAR31_2330 });
    const after = await nextCstepSerial(ws, "TIN", { at: APR01_0030 });
    expect(before).toEqual({ seq: 40, key: `cstep:${ws}:TIN:FY2026` });
    expect(after).toEqual({ seq: 7, key: `cstep:${ws}:TIN:FY2027` });
    // An unseeded series starts the new year at 1.
    await nextCstepSerial(ws, "LTC", { at: MAR31_2330 });
    await nextCstepSerial(ws, "LTC", { at: MAR31_2330 });
    expect((await nextCstepSerial(ws, "LTC", { at: APR01_0030 })).seq).toBe(1);
  });

  it("the vendor series is continuous — no FY in the key, no reset at 1 Apr", async () => {
    const ws = oid();
    const a = await nextCstepSerial(ws, "VENDOR", { at: MAR31_2330 });
    const b = await nextCstepSerial(ws, "VENDOR", { at: APR01_0030 });
    const c = await nextCstepSerial(ws, "VENDOR", { at: IST("2031-06-01T10:00:00") });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(a.key).toBe(`cstep:${ws}:VENDOR`);
    expect(c.key).toBe(a.key);
    expect(formatCstepVendorCode(c.seq)).toBe("CSTEPVEN0003");
  });

  it("the start is forward-only: raises, refuses lower (nothing changes), equal is a no-op", async () => {
    const ws = oid();
    await nextCstepSerial(ws, "EXP", { at }); // issued 1
    expect(await seedCstepSerial(ws, "EXP", 100, { at })).toMatchObject({ ok: true, next: 100 });
    expect(await seedCstepSerial(ws, "EXP", 50, { at })).toMatchObject({ ok: false, next: 100 });
    expect(await seedCstepSerial(ws, "EXP", 100, { at })).toMatchObject({ ok: true, next: 100 });
    expect((await nextCstepSerial(ws, "EXP", { at })).seq).toBe(100);
    expect(await seedCstepSerial(ws, "EXP", 100, { at })).toMatchObject({ ok: false, next: 101 });
  });

  it("grows past 9999", async () => {
    const ws = oid();
    await seedCstepSerial(ws, "TIN", 9999, { at });
    const a = await nextCstepSerial(ws, "TIN", { at });
    const b = await nextCstepSerial(ws, "TIN", { at });
    expect([formatCstepTin(a.seq, "1026"), formatCstepTin(b.seq, "1026")]).toEqual(["9999/1026", "10000/1026"]);
  });

  it("an aborted transaction rolls the increment back", async () => {
    const ws = oid();
    await nextCstepSerial(ws, "TIN", { at }); // 1, committed
    const session = await mongoose.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          await nextCstepSerial(ws, "TIN", { at, session });
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
    } finally {
      session.endSession();
    }
    expect((await peekCstepSerial(ws, "TIN", { at })).next).toBe(2);
  });

  it("concurrent transactional takes — including the first-of-year upsert — each get a distinct number", async () => {
    const ws = oid();
    const N = 12;
    const seqs = await Promise.all(
      Array.from({ length: N }, async () => {
        const session = await mongoose.startSession();
        try {
          let s = 0;
          await session.withTransaction(async () => {
            s = (await nextCstepSerial(ws, "TIN", { at: APR01_0030, session })).seq;
          });
          return s;
        } finally {
          session.endSession();
        }
      }),
    );
    expect([...seqs].sort((x, y) => x - y)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});

describe("approve issues references from the series", () => {
  const tourBody = (purpose: string) => ({
    type: "DOMESTIC", purpose, departureDate: "2026-11-10", returnDate: "2026-11-11", stations: [{ from: "Bengaluru", to: "Pune" }],
  });
  const approveNew = async (as: any, body: any) => {
    const id = String(ok(await post(as, "/requests", body)).body.request._id);
    return { id, body: ok(await post(ACT.approver, `/requests/${id}/approve`)).body };
  };

  it(`today's IST MMYY is ${NOW_MMYY}`, () => {
    // Run on 2026-10-17 (IST) — the brief's "0001/1026" examples.
    expect(NOW_MMYY).toMatch(/^\d{4}$/);
  });

  it(`Tour → 0001/${NOW_MMYY}, and a CstepClaim carrying the same TIN`, async () => {
    const { id, body } = await approveNew(ACT.traveller, tourBody("QC tour"));
    expect(body.claimReference).toBe(`0001/${NOW_MMYY}`);
    expect(body.request.claimReference).toBe(`0001/${NOW_MMYY}`);
    expect(body.claim.claimReference).toBe(`0001/${NOW_MMYY}`);
    expect(body.claim.travelRequestId).toBe(id);
  });

  it(`Local Travel claim → LTC0001/${NOW_MMYY}`, async () => {
    const { body } = await approveNew(ACT.traveller, {
      formType: "LOCAL_TRAVEL_CLAIM", purpose: "City meetings", project: "PRJ-QC",
      departureDate: "2026-10-05", returnDate: "2026-10-09", travelLines: [], foodLines: [], otherExpenses: 80,
    });
    expect(body.claimReference).toBe(`LTC0001/${NOW_MMYY}`);
    expect(body.claim).toBeNull();
  });

  it(`Expense claim → EXP0001/${NOW_MMYY} (EXC is retired)`, async () => {
    const inv = await stage(ACT.traveller, "TAX_INVOICE");
    const { body } = await approveNew(ACT.traveller, {
      formType: "EXPENSE_CLAIM", purpose: "Workshop materials", project: "PRJ-QC",
      departureDate: "2026-10-12", returnDate: "2026-10-16",
      expenseLines: [{ date: "2026-10-12", description: "Stationery", amount: 300 }], invoiceAttachmentIds: [inv],
    });
    expect(body.claimReference).toBe(`EXP0001/${NOW_MMYY}`);
  });

  it("Event Request → EVR0001/MMYY from its own series, still no CstepClaim; TIN untouched", async () => {
    const tinBefore = (await peekCstepSerial(WS, "TIN")).next;
    const { id, body } = await approveNew(ACT.traveller, {
      formType: "EVENT_REQUEST", purpose: "QC workshop", departureDate: "2026-11-02", returnDate: "2026-11-04",
      hostInstitution: "QC Institute", eventNature: "WORKSHOP", eventLocation: "Bengaluru",
      eventParticipants: [{ organisation: "CSTEP" }],
    });
    expect(body.claimReference).toBe(`EVR0001/${NOW_MMYY}`);
    expect(body.claim).toBeNull();
    const doc: any = await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(doc.status).toBe("APPROVED");
    expect(doc.claimReference).toBe(`EVR0001/${NOW_MMYY}`);
    expect(await col("cstepclaims").countDocuments({ travelRequestId: doc._id })).toBe(0);
    expect(await col("counters").findOne({ _id: `cstep:${WS}:EVR:FY${NOW_FY}` } as any)).toMatchObject({ seq: 1 });
    expect((await peekCstepSerial(WS, "TIN")).next).toBe(tinBefore);
  });

  it("the next Tour and the next LTC take 0002 — series stay independent", async () => {
    expect((await approveNew(ACT.traveller, tourBody("QC tour 2"))).body.claimReference).toBe(`0002/${NOW_MMYY}`);
    const ltc = await approveNew(ACT.traveller, {
      formType: "LOCAL_TRAVEL_CLAIM", purpose: "More meetings", project: "PRJ-QC",
      departureDate: "2026-10-05", returnDate: "2026-10-09", travelLines: [], foodLines: [], otherExpenses: 40,
    });
    expect(ltc.body.claimReference).toBe(`LTC0002/${NOW_MMYY}`);
  });

  it("a traveller with no travelerId can now be approved (the TIN no longer contains it)", async () => {
    const { body } = await approveNew(ACT.noCode, tourBody("QC tour, no code"));
    expect(body.claimReference).toBe(`0003/${NOW_MMYY}`);
  });

  it("duplicate-key backstop: a reference that already exists is skipped, not reissued or failed", async () => {
    // 0004 exists although the counter never issued it.
    await col("cstepclaims").insertOne({
      _id: oid(), workspaceId: WS, travelerProfileId: TP.main, travelRequestId: oid(), claimReference: `0004/${NOW_MMYY}`,
      status: "CLAIM_IN_PROGRESS", createdBy: U.traveller, createdAt: new Date(), updatedAt: new Date(),
    } as any);
    const { id, body } = await approveNew(ACT.traveller, tourBody("QC tour 4"));
    expect(body.claimReference).toBe(`0005/${NOW_MMYY}`);
    expect(await col("cstepclaims").countDocuments({ workspaceId: WS, claimReference: `0004/${NOW_MMYY}` })).toBe(1);
    expect(await col("cstepclaims").countDocuments({ travelRequestId: new mongoose.Types.ObjectId(id) })).toBe(1);
  });

  it("historical references are untouched — same strings, same updatedAt", async () => {
    const reqs = await col("csteptravelrequests").find({ _id: { $in: [HIST.tour, HIST.tour2, HIST.ltc, HIST.exc] } }).toArray();
    const byId = new Map(reqs.map((d: any) => [String(d._id), d]));
    expect(byId.get(String(HIST.tour))!.claimReference).toBe(HIST_REFS.tour);
    expect(byId.get(String(HIST.tour2))!.claimReference).toBe(HIST_REFS.tour2);
    expect(byId.get(String(HIST.ltc))!.claimReference).toBe(HIST_REFS.ltc);
    expect(byId.get(String(HIST.exc))!.claimReference).toBe(HIST_REFS.exc);
    for (const d of reqs) expect((d as any).updatedAt.toISOString()).toBe(HIST_AT.toISOString());
    const claims = await col("cstepclaims").find({ _id: { $in: [HIST.claim, HIST.claim2] } }).toArray();
    expect(claims.map((c: any) => c.claimReference).sort()).toEqual([HIST_REFS.tour, HIST_REFS.tour2].sort());
    for (const c of claims) expect((c as any).updatedAt.toISOString()).toBe(HIST_AT.toISOString());
  });
});

describe("series admin routes — CSTEP Admin only, forward-only", () => {
  it("non-admins are refused both routes", async () => {
    expect((await get(ACT.traveller, "/sequences")).status).toBe(403);
    expect((await put(ACT.approver, "/sequences/TIN", { startNumber: 500 })).status).toBe(403);
  });

  it("GET lists the next number of every series for the current FY", async () => {
    const s = ok(await get(ACT.admin, "/sequences")).body.series;
    const by = Object.fromEntries(s.map((x: any) => [x.series, x]));
    expect(by.TIN).toEqual({ series: "TIN", next: 6, fyStartYear: NOW_FY, upcoming: { fyStartYear: NOW_FY + 1, next: 1 } });
    expect(by.LTC.next).toBe(3);
    expect(by.EXP.next).toBe(2);
    expect(by.EVR).toEqual({ series: "EVR", next: 2, fyStartYear: NOW_FY, upcoming: { fyStartYear: NOW_FY + 1, next: 1 } });
    expect(by.VENDOR).toEqual({ series: "VENDOR", next: 1, fyStartYear: null });
  });

  it("PUT raises a series; the next approve uses it", async () => {
    expect(ok(await put(ACT.admin, "/sequences/TIN", { startNumber: 120 })).body).toMatchObject({ ok: true, series: "TIN", next: 120, fyStartYear: NOW_FY });
    const id = String(ok(await post(ACT.traveller, "/requests", {
      type: "DOMESTIC", purpose: "QC tour after seed", departureDate: "2026-11-10", returnDate: "2026-11-11", stations: [{ from: "A", to: "B" }],
    })).body.request._id);
    expect(ok(await post(ACT.approver, `/requests/${id}/approve`)).body.claimReference).toBe(`0120/${NOW_MMYY}`);
  });

  it("PUT refuses a lower start with 409 and changes nothing", async () => {
    const r = await put(ACT.admin, "/sequences/TIN", { startNumber: 50 });
    expect(r.status).toBe(409);
    expect(r.body.next).toBe(121);
    expect((await peekCstepSerial(WS, "TIN")).next).toBe(121);
  });

  it("PUT seeds LTC / EXP / VENDOR, and a later FY ahead of time", async () => {
    expect(ok(await put(ACT.admin, "/sequences/ltc", { startNumber: 30 })).body.next).toBe(30);
    expect(ok(await put(ACT.admin, "/sequences/EXP", { startNumber: 45 })).body.next).toBe(45);
    expect(ok(await put(ACT.admin, "/sequences/VENDOR", { startNumber: 9 })).body).toMatchObject({ next: 9, fyStartYear: null });
    expect(ok(await put(ACT.admin, "/sequences/evr", { startNumber: 70 })).body).toMatchObject({ next: 70, fyStartYear: NOW_FY });
    expect((await put(ACT.admin, "/sequences/EVR", { startNumber: 5 })).status).toBe(409);
    expect(ok(await put(ACT.admin, "/sequences/TIN", { startNumber: 11, fyStartYear: NOW_FY + 1 })).body).toMatchObject({ next: 11, fyStartYear: NOW_FY + 1 });
    expect((await peekCstepSerial(WS, "TIN", { fyStartYear: NOW_FY + 1 })).next).toBe(11);
    expect((await peekCstepSerial(WS, "TIN")).next).toBe(121); // the current year is unaffected
  });

  it("each change that moved a counter is audited; equal / refused starts are not", async () => {
    const before = await col("cstepsequencechanges").countDocuments({});
    // Equal to the current next — a no-op success, nothing written.
    expect(ok(await put(ACT.admin, "/sequences/TIN", { startNumber: 121 })).body).toMatchObject({ next: 121, changed: false });
    expect(await col("cstepsequencechanges").countDocuments({})).toBe(before);
    expect((await put(ACT.admin, "/sequences/TIN", { startNumber: 10 })).status).toBe(409);
    expect(await col("cstepsequencechanges").countDocuments({})).toBe(before);

    expect(ok(await put(ACT.admin, "/sequences/TIN", { startNumber: 200 })).body).toMatchObject({ next: 200, previousNext: 121, changed: true });
    const g = ok(await get(ACT.admin, "/sequences")).body;
    expect(g.currentFyStartYear).toBe(NOW_FY);
    expect(g.series.find((x: any) => x.series === "TIN").upcoming).toEqual({ fyStartYear: NOW_FY + 1, next: 11 });
    expect(g.changes[0]).toMatchObject({ series: "TIN", fyStartYear: NOW_FY, oldNext: 121, newNext: 200, changedBy: String(ACT.admin.id) });
    // The earlier seeds in this block are listed too, newest first.
    const listed = g.changes.map((c: any) => `${c.series}:${c.fyStartYear}:${c.oldNext}->${c.newNext}`);
    expect(listed).toContain(`TIN:${NOW_FY + 1}:1->11`);
    expect(listed).toContain(`VENDOR:null:1->9`);
    expect(listed).toContain(`TIN:${NOW_FY}:6->120`);
  });

  it("PUT validates its input", async () => {
    expect((await put(ACT.admin, "/sequences/INVOICE", { startNumber: 5 })).status).toBe(400);
    expect((await put(ACT.admin, "/sequences/TIN", { startNumber: 0 })).status).toBe(400);
    expect((await put(ACT.admin, "/sequences/TIN", { startNumber: 2.5 })).status).toBe(400);
    expect((await put(ACT.admin, "/sequences/TIN", { startNumber: 900, fyStartYear: NOW_FY - 1 })).status).toBe(400);
    expect((await put(ACT.admin, "/sequences/VENDOR", { startNumber: 900, fyStartYear: NOW_FY })).status).toBe(400);
  });
});
