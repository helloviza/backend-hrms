// apps/backend/src/routes/cstep.financeAdjust.test.ts
//
// Finance-c — Finance reduces and disallows at the Finance stage
// (TRANSFERRED_TO_FINANCE), through its own routes (routes/cstep.ts
// runFinanceAdjustment):
//   PATCH /finance/lines/:lineId          reduce a traveller-paid line — the
//                                         ceiling is the FINALIZED amount
//   POST  /finance/lines/:lineId/reject   disallow it (→ ₹0, marked)
//   PATCH /finance/perdiem                deduction-only
//   POST  /finance/reject-all             every payable item, one reason
// Gated like a payment (callerPaymentRefusal — the assigned Finance user
// only). Totals recompute, a Tour's CstepClaim follows, nothing owed closes
// the case SETTLED at ₹0 (kept on Finance's list), a claim still owed back
// stays with Finance. Every entry is stage FINANCE; the traveller is emailed
// (FINANCE_ADJUSTED). Ride-alongs: the payment reads its amount inside its
// transaction (a reduction racing it is never paid stale), Finance reads the
// lines on GET /requests/:id, and an Admin's send-back is logged as an
// override.
//
// Real: cstep router, models, notification module + outbox, in-memory Mongo
//   REPLICA SET (transactions) on a fresh database, cstep_qc_finance_adjust.
// Stubbed: the SMTP send, S3 + PDF helpers, auth (x-test-user), the
//   workspace resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_finance_adjust";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
process.env.DISABLE_EMAILS = "";
process.env.CSTEP_NOTIFICATIONS_ENABLED = "true";

vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async () => ({ key: "qc" })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({})) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({})) }));

vi.setConfig({ testTimeout: 60_000 });

const { default: cstepRouter } = await import("./cstep.js");
const { default: CstepSettlement } = await import("../models/cstep/CstepSettlement.js");
const { encryptCstepSmtpPass } = await import("../services/cstepMailTransport.js");
const { default: CstepNotificationSettings } = await import("../models/cstep/CstepNotificationSettings.js");

const DB = "cstep_qc_finance_adjust";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const ONLY = "Only the assigned finance user can record payments";
const NONE = "No finance user is assigned to this traveller — assign a finance user first";

const WS = oid();
const QC_PROJECT = oid();
const VENDOR = oid();
const U = { traveller: oid(), solo: oid(), selfFin: oid(), manager: oid(), official: oid(), finance: oid(), desk: oid(), admin: oid(), adminFinance: oid() };
const TP = { main: oid(), unassigned: oid(), adminFinanced: oid() };
const TRAVELLER_EMAIL = "traveller@qc.local";

const app = express();
app.use(express.json());
app.use(
  "/api/cstep",
  (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.workspaceObjectId = WS;
    next();
  },
  cstepRouter,
);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"], email = `${id}@qc.local`) => ({
  _id: String(id), id: String(id), sub: String(id), email, roles, workspaceId: String(WS),
});
const ACT = {
  traveller: who(U.traveller, ["REQUESTER"], TRAVELLER_EMAIL),
  solo: who(U.solo),
  selfFin: who(U.selfFin),
  manager: who(U.manager, ["APPROVER"]),
  official: who(U.official),
  finance: who(U.finance),
  desk: who(U.desk),
  admin: who(U.admin, ["ADMIN"]),
  // A CSTEP Admin who IS one traveller's assigned Finance user.
  adminFinance: who(U.adminFinance, ["ADMIN"]),
};
const NOT_FINANCE = [ACT.admin, ACT.desk, ACT.official, ACT.manager, ACT.traveller];

const send = (m: "get" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  if (m === "get") return r;
  return r.send(path === "/requests" && body?.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body || {});
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body?: any) => send("post", as, path, body);
const patch = (as: any, path: string, body?: any) => send("patch", as, path, body);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const id$ = (id: string) => new mongoose.Types.ObjectId(id);
const statusOf = async (id: string) => (await col("csteptravelrequests").findOne({ _id: id$(id) }))!.status;
const settlementOf = async (id: string) => (await col("cstepsettlements").findOne({ requestId: id$(id) }))!;
const linesOf = async (id: string) => col("cstepsettlementlines").find({ requestId: id$(id) }).sort({ _id: 1 }).toArray();
const entries = (id: string, action?: string) =>
  col("cstepapprovals").find({ entityId: id$(id), ...(action ? { action } : {}) }).sort({ _id: 1 }).toArray();
const outbox = (id: string, event: string) => col("emailoutboxes").find({ requestId: id$(id), event }).sort({ _id: 1 }).toArray();

const TOUR = {
  type: "DOMESTIC",
  purpose: "QC finance adjust",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
};

type TourCase = { id: string; personal: any[]; official: any; settlement: any };

/**
 * A Tour taken to TRANSFERRED_TO_FINANCE: one CSTEP-paid flight (₹6,400 —
 * company-paid, OFFICIAL), one self-paid cab leg per fare (PERSONAL), and a
 * per diem at `rate` (0 = none). `deskCut` lowers the first personal line
 * at settlement before finalize (a Desk reduction).
 */
async function tourWithFinance(
  as: any,
  fares: number[],
  opts: { rate?: number; deskCut?: { to: number } } = {},
): Promise<TourCase> {
  const id = String(ok(await post(as, "/requests", TOUR)).body.request._id);
  ok(await post(ACT.manager, `/requests/${id}/approve`));
  const [flight] = ok(await post(ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
  ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { vendorId: String(VENDOR), amount: 6400, currency: "INR", status: "ARRANGED" }));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  ok(await post(as, `/requests/${id}/report/start`));
  for (const fare of fares) {
    const leg = ok(
      await post(as, `/requests/${id}/report/legs`, {
        direction: "ONWARD", travelMode: "CAB", paidBy: "SELF", fare, currency: "INR",
        fromLocation: "Airport", toLocation: "Office", fromDate: "2026-11-02", toDate: "2026-11-02",
      }),
    ).body.leg;
    await col("cstepreportlegs").updateOne({ _id: id$(leg._id) }, { $set: { attachmentId: oid() } });
  }
  // Every leg the report carries needs its document; the seeded flight leg too.
  await col("cstepreportlegs").updateMany({ requestId: id$(id), attachmentId: { $exists: false } }, { $set: { attachmentId: oid() } });
  ok(await post(as, `/requests/${id}/report/submit`));
  ok(await post(ACT.manager, `/requests/${id}/report/approve`));
  ok(await post(ACT.official, `/requests/${id}/settlement/start`));
  ok(await patch(ACT.official, `/requests/${id}/settlement/perdiem`, { rate: opts.rate ?? 0, rateReason: "QC rate" }));
  let lines = ok(await get(ACT.official, `/requests/${id}/settlement`)).body.lines;
  if (opts.deskCut) {
    const first = lines.find((l: any) => l.classification === "PERSONAL");
    ok(await patch(ACT.official, `/requests/${id}/settlement/lines/${first._id}`, { amountInr: opts.deskCut.to, amountReason: "Desk: policy cap" }));
  }
  const fin = ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true })).body;
  expect(fin.request.status).toBe("TRANSFERRED_TO_FINANCE");
  lines = await linesOf(id);
  const personal = lines.filter((l: any) => l.classification === "PERSONAL").sort((a: any, b: any) => fares.indexOf(a.claimedAmountInr) - fares.indexOf(b.claimedAmountInr));
  const official = lines.find((l: any) => l.classification === "OFFICIAL");
  return { id, personal, official, settlement: fin.settlement };
}

/** A Local Travel Claim at TRANSFERRED_TO_FINANCE (verified by the Admin). */
async function claimWithFinance(over: any): Promise<string> {
  const id = String(
    ok(
      await post(ACT.traveller, "/requests", {
        formType: "LOCAL_TRAVEL_CLAIM",
        purpose: "QC local travel",
        departureDate: "2026-10-05",
        returnDate: "2026-10-09",
        travelLines: [],
        foodLines: [],
        ...over,
      }),
    ).body.request._id,
  );
  ok(await post(ACT.manager, `/requests/${id}/approve`));
  const v = ok(await post(ACT.admin, `/requests/${id}/claim/verify`, { force: true })).body;
  expect(v.request.status).toBe("TRANSFERRED_TO_FINANCE");
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

  await CstepNotificationSettings.create({
    workspaceId: WS, enabled: true, senderMailbox: "notify@cstep-qc.local", senderName: "CSTEP",
    smtpHost: "smtp.cstep-qc.local", smtpPort: 587, smtpPassEnc: encryptCstepSmtpPass("qc-app-password", WS),
  });
  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("cstepvendors").insertOne({ _id: VENDOR, workspaceId: WS, vendorCode: "CSTEPVEN0001", name: "Skyline Travels", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany(
    (Object.keys(U) as Array<keyof typeof U>).map((k) => ({
      _id: U[k], email: k === "traveller" ? TRAVELLER_EMAIL : `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS,
    })) as any[],
  );
  await col("csteptraveldeskgrants").insertOne({ workspaceId: WS, userId: U.desk, grantedBy: U.admin, grantedAt: new Date() } as any);
  const profile = (_id: mongoose.Types.ObjectId, code: string, extra: any) => ({
    _id, workspaceId: WS, travelerId: code, firstName: "Asha", lastName: code, isActive: true,
    tourApproverId: U.manager, officialUserId: U.official, ...extra,
  });
  await col("travellerprofiles").insertMany([
    profile(TP.main, "CSTEP-001", { claimedBy: U.traveller, email: TRAVELLER_EMAIL, financeUserId: U.finance }),
    profile(TP.unassigned, "CSTEP-002", { claimedBy: U.solo }), // no financeUserId
    profile(TP.adminFinanced, "CSTEP-003", { claimedBy: U.selfFin, financeUserId: U.adminFinance }),
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("gating — the assigned Finance user only (the #5 payment gate)", () => {
  let t: TourCase;

  it("Admin, Travel Desk (grant), Official, Manager and the traveller are refused every lever; nothing changes", async () => {
    t = await tourWithFinance(ACT.traveller, [1200], { rate: 1000 });
    const lineId = String(t.personal[0]._id);
    const before = await settlementOf(t.id);
    for (const as of NOT_FINANCE) {
      const calls = [
        await patch(as, `/requests/${t.id}/finance/lines/${lineId}`, { amountInr: 100, amountReason: "x" }),
        await post(as, `/requests/${t.id}/finance/lines/${lineId}/reject`, { reason: "x" }),
        await patch(as, `/requests/${t.id}/finance/perdiem`, { deductionInr: 500, deductionReason: "x" }),
        await post(as, `/requests/${t.id}/finance/reject-all`, { reason: "x" }),
      ];
      for (const r of calls) {
        expect(r.status).toBe(403);
        expect(r.body.error).toBe(ONLY);
      }
    }
    const after = await settlementOf(t.id);
    expect(after.amountClaimed).toBe(before.amountClaimed);
    expect(after.financeRevision).toBeUndefined();
    expect((await linesOf(t.id)).find((l: any) => String(l._id) === lineId)!.amountInr).toBe(1200);
    expect(await statusOf(t.id)).toBe("TRANSFERRED_TO_FINANCE");
    expect((await entries(t.id)).filter((e: any) => e.stage === "FINANCE")).toHaveLength(0);
  });

  it("with no Finance user mapped, nobody may — not even an Admin", async () => {
    const solo = await tourWithFinance(ACT.solo, [500]);
    for (const as of [ACT.admin, ACT.finance, ACT.desk]) {
      const r = await post(as, `/requests/${solo.id}/finance/reject-all`, { reason: "x" });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(NONE);
    }
  });

  it("an Admin who IS the mapped Finance user acts as that Finance user", async () => {
    const mine = await tourWithFinance(ACT.selfFin, [700]);
    const r = ok(await patch(ACT.adminFinance, `/requests/${mine.id}/finance/lines/${mine.personal[0]._id}`, { amountInr: 600, amountReason: "Receipt shows ₹600" }));
    expect(r.body.changed).toBe(true);
    const [e] = await entries(mine.id, "REDUCE_AMOUNT");
    expect(e.stage).toBe("FINANCE");
    expect(e.adminOverride).toBeUndefined();
  });

  it("only while the case is with Finance", async () => {
    const draft = String(ok(await post(ACT.traveller, "/requests", TOUR)).body.request._id);
    const r = await post(ACT.finance, `/requests/${draft}/finance/reject-all`, { reason: "x" });
    expect(r.status).toBe(409);
  });
});

describe("Finance reduce — reduce-only, capped at the finalized amount", () => {
  let t: TourCase;

  it("a Desk reduction can't be undone: above the finalized figure is refused even below the claimed one", async () => {
    t = await tourWithFinance(ACT.traveller, [1200, 300], { deskCut: { to: 1000 } });
    const line = t.personal[0];
    expect(line.claimedAmountInr).toBe(1200);
    expect(line.amountInr).toBe(1000);
    const up = await patch(ACT.finance, `/requests/${t.id}/finance/lines/${line._id}`, { amountInr: 1100, amountReason: "back up" });
    expect(up.status).toBe(400);
    expect(up.body.error).toBe("An amount can only be reduced — this line stands at ₹1,000 as finalized");
  });

  it("a reason is required; resending the same amount changes nothing", async () => {
    const line = t.personal[0];
    const noReason = await patch(ACT.finance, `/requests/${t.id}/finance/lines/${line._id}`, { amountInr: 800 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toBe("amountReason is required to change a line's amount");
    const same = ok(await patch(ACT.finance, `/requests/${t.id}/finance/lines/${line._id}`, { amountInr: 1000 }));
    expect(same.body.changed).toBe(false);
    expect(await entries(t.id, "REDUCE_AMOUNT")).toHaveLength(1); // the Desk's only
  });

  it("company-paid lines are not Finance's to change", async () => {
    const r = await patch(ACT.finance, `/requests/${t.id}/finance/lines/${t.official._id}`, { amountInr: 100, amountReason: "x" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Finance can only change a traveller-paid line — this one was paid by CSTEP");
  });

  it("reduces, recomputes the payout and the CstepClaim, and logs REDUCE_AMOUNT at stage FINANCE", async () => {
    const line = t.personal[0];
    const before = await settlementOf(t.id);
    expect(before.amountClaimed).toBe(1300);
    const r = ok(await patch(ACT.finance, `/requests/${t.id}/finance/lines/${line._id}`, { amountInr: 800, amountReason: "Receipt shows ₹800" })).body;
    expect(r).toMatchObject({ changed: true, closed: false });
    const s = await settlementOf(t.id);
    expect(s.amountClaimed).toBe(1100);
    expect(s.totalCostOfTour).toBe(before.totalCostOfTour - 200);
    expect(s.status).toBe("FINALIZED");
    expect(s.financeRevision).toBe(1);
    const changed = (await linesOf(t.id)).find((l: any) => String(l._id) === String(line._id))!;
    expect(changed).toMatchObject({ amountInr: 800, claimedAmountInr: 1200 });
    const claim = (await col("cstepclaims").findOne({ travelRequestId: id$(t.id) }))!;
    expect(claim).toMatchObject({ amountClaimed: 1100, amountDueByCstep: 1100, totalCostOfTour: s.totalCostOfTour, status: "ADMIN_VERIFIED" });
    const finance = (await entries(t.id, "REDUCE_AMOUNT")).filter((e: any) => e.stage === "FINANCE");
    expect(finance).toHaveLength(1);
    expect(finance[0].comment).toBe("Airport → Office: ₹1,000 → ₹800 (finalized ₹1,000) — Receipt shows ₹800");
    expect(await statusOf(t.id)).toBe("TRANSFERRED_TO_FINANCE");
  });

  it("the traveller is emailed the change (FINANCE_ADJUSTED) with the reason and the new payout", async () => {
    const [mail] = await outbox(t.id, "cstep_finance_adjusted");
    expect(mail.to).toEqual([TRAVELLER_EMAIL]);
    expect(mail.subject).toBe("[CSTEP] Your claim payout was changed by Finance");
    expect(mail.text).toContain("Receipt shows ₹800");
    expect(mail.text).toContain("₹1,300 → ₹1,100");
    expect(mail.text).toContain("₹1,100 is now payable to you");
  });

  it("then paying uses the reduced figure", async () => {
    ok(await post(ACT.finance, `/requests/${t.id}/finance/settle`, { reference: "UTR-1" }));
    expect(await statusOf(t.id)).toBe("REIMBURSED");
    const [pay] = await entries(t.id, "FINANCE_SETTLE");
    expect(pay.comment).toMatch(/^₹1100 reimbursed to the traveller \| Ref: UTR-1/);
    const [mail] = await outbox(t.id, "cstep_reimbursed");
    expect(mail.text).toContain("₹1,100 has been reimbursed");
    // Closed: no more Finance changes.
    const late = await patch(ACT.finance, `/requests/${t.id}/finance/lines/${t.personal[1]._id}`, { amountInr: 100, amountReason: "late" });
    expect(late.status).toBe(409);
  });
});

describe("Finance per diem — deduction only", () => {
  let t: TourCase;

  it("the rate and days are refused; lowering a deduction is refused", async () => {
    t = await tourWithFinance(ACT.traveller, [400], { rate: 1000 });
    const pd = (await settlementOf(t.id)).perDiem;
    expect(pd.amountInr).toBe(pd.days * 1000);
    for (const body of [{ rate: 2000, rateReason: "x" }, { overrideDays: 9, overrideReason: "x" }]) {
      const r = await patch(ACT.finance, `/requests/${t.id}/finance/perdiem`, body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("Finance can only add or raise a per-diem deduction — not change the rate or days");
    }
    expect((await patch(ACT.finance, `/requests/${t.id}/finance/perdiem`, { deductionInr: 300 })).body.error).toBe(
      "deductionReason is required for a per-diem deduction",
    );
    ok(await patch(ACT.finance, `/requests/${t.id}/finance/perdiem`, { deductionInr: 300, deductionReason: "Lunch provided" }));
    const lower = await patch(ACT.finance, `/requests/${t.id}/finance/perdiem`, { deductionInr: 100, deductionReason: "x" });
    expect(lower.status).toBe(400);
    expect(lower.body.error).toBe("Finance can only add or raise a deduction — it stands at ₹300");
  });

  it("a deduction lowers the net per diem and the payout; logged PERDIEM_ADJUST at stage FINANCE", async () => {
    const s = await settlementOf(t.id);
    const gross = s.perDiem.days * 1000;
    expect(s.perDiem).toMatchObject({ deductionInr: 300, deductionReason: "Lunch provided", amountInr: gross - 300, rate: 1000 });
    expect(s.amountClaimed).toBe(400 + gross - 300);
    const [e] = (await entries(t.id, "PERDIEM_ADJUST")).filter((x: any) => x.stage === "FINANCE");
    expect(e.comment).toBe(`Per diem: days ${s.perDiem.days} => ${s.perDiem.days}, rate 1000 => 1000, deduction 0 => 300, net ${gross} => ${gross - 300} (deduction: Lunch provided)`);
  });

  it("a claim has no per diem", async () => {
    const cid = await claimWithFinance({ otherExpenses: 250 });
    const r = await patch(ACT.finance, `/requests/${cid}/finance/perdiem`, { deductionInr: 10, deductionReason: "x" });
    expect(r.status).toBe(409);
  });
});

describe("Finance line reject — disallowed, ₹0, the rest still paid", () => {
  let t: TourCase;

  it("a reason is required", async () => {
    t = await tourWithFinance(ACT.traveller, [900, 350]);
    const r = await post(ACT.finance, `/requests/${t.id}/finance/lines/${t.personal[0]._id}/reject`, {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("reason is required");
  });

  it("the line goes to ₹0, marked Disallowed by Finance (reason, who, when); payout recomputes; stays with Finance", async () => {
    const lineId = String(t.personal[0]._id);
    const r = ok(await post(ACT.finance, `/requests/${t.id}/finance/lines/${lineId}/reject`, { reason: "Personal trip, not official" })).body;
    expect(r).toMatchObject({ changed: true, closed: false });
    const line = (await linesOf(t.id)).find((l: any) => String(l._id) === lineId)!;
    expect(line).toMatchObject({
      amountInr: 0, claimedAmountInr: 900, financeRejected: true, financeRejectedFromInr: 900,
      financeRejectedReason: "Personal trip, not official", financeRejectedBy: U.finance,
    });
    expect(line.financeRejectedAt).toBeInstanceOf(Date);
    expect((await settlementOf(t.id)).amountClaimed).toBe(350);
    expect(await statusOf(t.id)).toBe("TRANSFERRED_TO_FINANCE");
    const [e] = await entries(t.id, "FINANCE_REJECT_LINE");
    expect(e).toMatchObject({ stage: "FINANCE", comment: "Airport → Office: ₹900 → ₹0, disallowed by Finance — Personal trip, not official" });
    const [mail] = await outbox(t.id, "cstep_finance_adjusted");
    expect(mail.text).toContain("Finance has disallowed an item on your claim");
    expect(mail.text).toContain("Personal trip, not official");
  });

  it("a disallowed line can be neither disallowed again nor reduced", async () => {
    const lineId = String(t.personal[0]._id);
    expect((await post(ACT.finance, `/requests/${t.id}/finance/lines/${lineId}/reject`, { reason: "again" })).status).toBe(409);
    expect((await patch(ACT.finance, `/requests/${t.id}/finance/lines/${lineId}`, { amountInr: 0, amountReason: "x" })).status).toBe(409);
  });

  it("Finance sees the lines (with the mark) on the case; the Admin sees them but can't adjust; the Desk doesn't get them", async () => {
    const fin = ok(await get(ACT.finance, `/requests/${t.id}`)).body;
    expect(fin.canFinanceAdjust).toBe(true);
    expect(fin.financeSettlement.lines).toHaveLength(3);
    expect(fin.financeSettlement.lines.find((l: any) => l.financeRejected)).toMatchObject({
      amountInr: 0, financeRejectedFromInr: 900, financeRejectedReason: "Personal trip, not official", classification: "PERSONAL",
    });
    expect(fin.financeSettlement.amountClaimed).toBe(350);
    const admin = ok(await get(ACT.admin, `/requests/${t.id}`)).body;
    expect(admin.canFinanceAdjust).toBe(false);
    expect(admin.financeSettlement.lines).toHaveLength(3);
    expect(ok(await get(ACT.desk, `/requests/${t.id}`)).body.financeSettlement).toBeUndefined();
  });

  it("some rejected → REIMBURSED for the remainder", async () => {
    ok(await post(ACT.finance, `/requests/${t.id}/finance/settle`, { reference: "UTR-2" }));
    expect(await statusOf(t.id)).toBe("REIMBURSED");
    const [pay] = await entries(t.id, "FINANCE_SETTLE");
    expect(pay.comment).toMatch(/^₹350 reimbursed to the traveller/);
  });
});

describe("Reject all — landing states", () => {
  it("Tour, everything rejected → SETTLED at ₹0; the cost of tour keeps the company-paid flight", async () => {
    const t = await tourWithFinance(ACT.traveller, [500, 250], { rate: 1000 });
    expect((await post(ACT.finance, `/requests/${t.id}/finance/reject-all`, {})).status).toBe(400);
    const r = ok(await post(ACT.finance, `/requests/${t.id}/finance/reject-all`, { reason: "No approval for these expenses" })).body;
    expect(r).toMatchObject({ changed: true, closed: true });
    expect(await statusOf(t.id)).toBe("SETTLED");
    const s = await settlementOf(t.id);
    expect(s).toMatchObject({ amountClaimed: 0, totalCostOfTour: 6400, outcome: "CLOSE", status: "FINALIZED" });
    expect(s.perDiem.amountInr).toBe(0);
    expect(s.perDiem.deductionInr).toBe(s.perDiem.days * 1000);
    expect(s.perDiem.deductionReason).toBe("Disallowed by Finance — No approval for these expenses");
    expect(s.financeClosedAt).toBeInstanceOf(Date);
    expect(s.financeClosedBy).toEqual(U.finance);
    expect(s.paidOn).toBeUndefined();
    const lines = await linesOf(t.id);
    expect(lines.filter((l: any) => l.classification === "PERSONAL").every((l: any) => l.financeRejected && l.amountInr === 0)).toBe(true);
    expect(lines.find((l: any) => l.classification === "OFFICIAL")).toMatchObject({ amountInr: 6400 });
    expect((await col("cstepclaims").findOne({ travelRequestId: id$(t.id) }))!).toMatchObject({ status: "SETTLED", amountClaimed: 0, totalCostOfTour: 6400 });
    const fin = (await entries(t.id)).filter((e: any) => e.stage === "FINANCE");
    expect(fin.map((e: any) => e.action)).toEqual(["FINANCE_REJECT", "SETTLE"]);
    expect(fin[0].comment).toBe(`All claimed items disallowed by Finance (Airport → Office ₹500, Airport → Office ₹250, Per diem ₹${(s.perDiem.days * 1000).toLocaleString("en-IN")}) — No approval for these expenses`);
    const [mail] = await outbox(t.id, "cstep_finance_adjusted");
    expect(mail.text).toContain("Finance has disallowed every item on your claim");
    expect(mail.text).toContain("Nothing is now owed either way, so the claim is closed.");
    // Nothing left to pay.
    expect((await post(ACT.finance, `/requests/${t.id}/finance/settle`)).status).toBe(409);
  });

  it("a rejected-to-₹0 case stays on Finance's Reimbursed & settled list, and its case page keeps the record", async () => {
    const t = await tourWithFinance(ACT.traveller, [610]);
    ok(await post(ACT.finance, `/requests/${t.id}/finance/reject-all`, { reason: "Duplicate of an earlier claim" }));
    const q = ok(await get(ACT.finance, "/finance-queue")).body;
    expect(q.requests.map((d: any) => String(d._id))).not.toContain(t.id);
    const row = q.closed.find((d: any) => String(d._id) === t.id);
    expect(row.status).toBe("SETTLED");
    expect(row.financePaid).toMatchObject({ amountInr: 0, closedAtZero: true });
    const page = ok(await get(ACT.finance, `/requests/${t.id}`)).body;
    expect(page.financePaid).toMatchObject({ amountInr: 0, closedAtZero: true });
    expect(page.financeSettlement.lines.find((l: any) => l.classification === "PERSONAL")).toMatchObject({ financeRejected: true });
  });

  it("a payout reduced (not rejected) to ₹0 closes SETTLED too", async () => {
    const t = await tourWithFinance(ACT.traveller, [180]);
    const r = ok(await patch(ACT.finance, `/requests/${t.id}/finance/lines/${t.personal[0]._id}`, { amountInr: 0, amountReason: "No receipt" })).body;
    expect(r.closed).toBe(true);
    expect(await statusOf(t.id)).toBe("SETTLED");
  });

  it("claim, no advance, everything rejected → SETTLED at ₹0 (settlement finalized CLOSE)", async () => {
    const cid = await claimWithFinance({ otherExpenses: 250, foodLines: [{ date: "2026-10-06", amount: 300 }] });
    ok(await post(ACT.finance, `/requests/${cid}/finance/reject-all`, { reason: "Outside policy" }));
    expect(await statusOf(cid)).toBe("SETTLED");
    const s = await settlementOf(cid);
    expect(s).toMatchObject({ amountClaimed: 0, amountDueByCstep: 0, amountDueToCstep: 0, status: "FINALIZED", outcome: "CLOSE" });
    expect(s.financeClosedAt).toBeInstanceOf(Date);
    const fin = (await entries(cid)).filter((e: any) => e.stage === "FINANCE");
    expect(fin.map((e: any) => e.action)).toEqual(["FINANCE_REJECT", "SETTLE"]);
  });

  it("claim with an advance, everything rejected → stays with Finance, owed back; SETTLED when the repayment is recorded", async () => {
    const cid = await claimWithFinance({ otherExpenses: 900, advanceTaken: 400 });
    expect((await settlementOf(cid)).amountDueByCstep).toBe(500);
    const r = ok(await post(ACT.finance, `/requests/${cid}/finance/reject-all`, { reason: "No bills" })).body;
    expect(r.closed).toBe(false);
    expect(await statusOf(cid)).toBe("TRANSFERRED_TO_FINANCE");
    expect(await settlementOf(cid)).toMatchObject({ amountClaimed: 0, amountDueByCstep: 0, amountDueToCstep: 400, status: "VERIFYING" });
    const [mail] = await outbox(cid, "cstep_finance_adjusted");
    expect(mail.text).toContain("₹400 is now to be recovered from you");
    expect(mail.text).toContain("₹500 → ₹400 to recover");
    expect((await post(ACT.finance, `/requests/${cid}/finance/reject-all`, { reason: "again" })).status).toBe(409);
    ok(await post(ACT.finance, `/requests/${cid}/finance/settle`, { reference: "RCPT-1" }));
    expect(await statusOf(cid)).toBe("SETTLED");
    const [pay] = await entries(cid, "FINANCE_SETTLE");
    expect(pay.comment).toBe("₹400 received back from the claimant | Ref: RCPT-1");
  });
});

describe("the race — a reduction landing while Finance pays is never paid stale", () => {
  it("a reduce committed mid-payment: the payment pays the reduced figure", async () => {
    const t = await tourWithFinance(ACT.traveller, [2000]);
    const lineId = String(t.personal[0]._id);
    // The payment's FIRST settlement read is held until a Finance reduction
    // (another request) has committed — the interleaving a double-click or a
    // second tab produces.
    const realFindOne = CstepSettlement.findOne.bind(CstepSettlement);
    let armed = true;
    const spy = vi.spyOn(CstepSettlement, "findOne").mockImplementation(((...args: any[]) => {
      const q: any = (realFindOne as any)(...args);
      if (armed) {
        armed = false;
        const exec = q.exec.bind(q);
        q.exec = async (...a: any[]) => {
          const result = await exec(...a);
          ok(await patch(ACT.finance, `/requests/${t.id}/finance/lines/${lineId}`, { amountInr: 1500, amountReason: "Cap" }));
          return result;
        };
      }
      return q;
    }) as any);
    try {
      ok(await post(ACT.finance, `/requests/${t.id}/finance/settle`, { reference: "UTR-RACE" }));
    } finally {
      spy.mockRestore();
    }
    expect(armed).toBe(false);
    expect(await statusOf(t.id)).toBe("REIMBURSED");
    expect((await settlementOf(t.id)).amountClaimed).toBe(1500);
    const [pay] = await entries(t.id, "FINANCE_SETTLE");
    expect(pay.comment).toMatch(/^₹1500 reimbursed to the traveller \| Ref: UTR-RACE/);
    const [mail] = await outbox(t.id, "cstep_reimbursed");
    expect(mail.text).toContain("₹1,500 has been reimbursed");
  });
});

describe("send-back consistency — an Admin's send-back is an override", () => {
  it("Finance's own send-back carries no flag", async () => {
    const t = await tourWithFinance(ACT.traveller, [100]);
    ok(await post(ACT.finance, `/requests/${t.id}/finance/return`, { reason: "Bill unreadable" }));
    const [e] = await entries(t.id, "RETURN_TO_OFFICIAL");
    expect(e.stage).toBe("FINANCE");
    expect(e.adminOverride).toBeUndefined();
  });

  it("an Admin who is not the Finance user sends back as an override (Tour and claim)", async () => {
    const t = await tourWithFinance(ACT.traveller, [100]);
    ok(await post(ACT.admin, `/requests/${t.id}/finance/return`, { reason: "Wrong project" }));
    const [e] = await entries(t.id, "RETURN_TO_OFFICIAL");
    expect(e.adminOverride).toBe(true);

    const cid = await claimWithFinance({ otherExpenses: 120 });
    ok(await post(ACT.admin, `/requests/${cid}/finance/return`, { reason: "Recheck" }));
    const [c] = await entries(cid, "RETURN_TO_ADMIN");
    expect(c.adminOverride).toBe(true);
  });

  it("the Travel Desk still can't send back", async () => {
    const t = await tourWithFinance(ACT.traveller, [100]);
    expect((await post(ACT.desk, `/requests/${t.id}/finance/return`, { reason: "x" })).status).toBe(403);
  });
});
