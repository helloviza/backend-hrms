// apps/backend/src/routes/cstep.perDiemDeduction.test.ts
//
// #10 — a manual meal / provided-benefit deduction on the settlement per
// diem (PATCH /requests/:id/settlement/perdiem, deductionInr +
// deductionReason). Net = max(0, days × rate − deduction); days × rate stays
// the gross. The net feeds the buckets, amountClaimed, the claim's
// amountDueByCstep at finalize and Finance's figure. Every per-diem change
// needs a reason — the deduction, an overridden day count and (new) a rate
// change — and is logged as PERDIEM_ADJUST with days / rate / deduction /
// net before → after. Same gate as the day-count override: the traveller's
// Official or a CSTEP Admin, only while the settlement is VERIFYING.
//
// Real: cstep router, models, in-memory Mongo REPLICA SET (approve runs in a
//   transaction) on a fresh database, cstep_qc_pddeduct.
// Stubbed: mail, S3 + PDF helpers, auth (x-test-user) and the workspace
//   resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_pddeduct";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";

vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async () => ({ key: "qc" })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({})) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({})) }));

const { default: cstepRouter } = await import("./cstep.js");

const DB = "cstep_qc_pddeduct";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), approver: oid(), official: oid(), finance: oid(), stranger: oid(), admin: oid() };
const TP = oid();
const RATE = 1000; // the traveller's own domestic ₹/day, seeded onto the settlement at start

const app = express();
app.use(express.json());
app.use((req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = WS;
  next();
});
app.use("/api/cstep", cstepRouter);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${String(id)}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = {
  traveller: who(U.traveller),
  approver: who(U.approver, ["APPROVER"]),
  official: who(U.official),
  finance: who(U.finance),
  stranger: who(U.stranger),
  admin: who(U.admin, ["ADMIN"]),
};
const send = (m: "get" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  if (m === "get") return r;
  return r.send(path === "/requests" ? { projectId: String(QC_PROJECT), ...body } : body || {});
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body?: any) => send("post", as, path, body);
const patch = (as: any, path: string, body?: any) => send("patch", as, path, body);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const perdiem = (as: any, id: string, body: any) => patch(as, `/requests/${id}/settlement/perdiem`, body);
const settlementOf = (id: string) => col("cstepsettlements").findOne({ requestId: new mongoose.Types.ObjectId(id) }) as Promise<any>;
const audit = (id: string, action: string) =>
  col("cstepapprovals").find({ entityId: new mongoose.Types.ObjectId(id), action }).sort({ at: 1 }).toArray();

const TOUR = {
  type: "DOMESTIC",
  purpose: "QC per-diem deduction",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04", // 3 days inclusive → gross 3 × 1000 = 3000
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
};

/** A Tour taken through arrange → report → report approval to an open (VERIFYING) settlement. */
async function verifying(purpose: string): Promise<string> {
  const id = String(ok(await post(ACT.traveller, "/requests", { ...TOUR, purpose })).body.request._id);
  ok(await post(ACT.approver, `/requests/${id}/approve`));
  ok(await post(ACT.official, `/requests/${id}/start-arranging`));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  ok(await post(ACT.traveller, `/requests/${id}/report/start`));
  ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
  ok(await post(ACT.approver, `/requests/${id}/report/approve`));
  ok(await post(ACT.official, `/requests/${id}/settlement/start`));
  return id;
}

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);
  await mongoose.connection.syncIndexes();

  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany(
    (Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${String(U[k])}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[],
  );
  await col("travellerprofiles").insertOne({
    _id: TP, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "QC", isActive: true,
    claimedBy: U.traveller, tourApproverId: U.approver, officialUserId: U.official, financeUserId: U.finance,
    perDiemRateDomesticInr: RATE,
  } as any);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("meal / provided-benefit deduction — net = max(0, gross − deduction)", () => {
  let id = "";

  it("seeds a gross-only per diem: 3 days × ₹1000, no deduction", async () => {
    id = await verifying("QC deduction net");
    const s = await settlementOf(id);
    expect(s.perDiem).toMatchObject({ days: 3, rate: RATE, amountInr: 3000 });
    expect(s.perDiem.deductionInr).toBeUndefined();
    expect(s.amountClaimed).toBe(3000);
  });

  it("a deduction with a reason reduces the net and every total built on it", async () => {
    const r = ok(await perdiem(ACT.official, id, { deductionInr: 450, deductionReason: "Lunch provided by host, day 2" }));
    expect(r.body.settlement.perDiem).toMatchObject({
      days: 3, rate: RATE, deductionInr: 450, deductionReason: "Lunch provided by host, day 2", amountInr: 2550,
    });
    const s = await settlementOf(id);
    expect(s.perDiem.amountInr).toBe(2550);
    expect(s.buckets.perDiem).toBe(2550);
    expect(s.amountClaimed).toBe(2550);
    expect(s.totalCostOfTour).toBe(2550);
  });

  it("is logged as PERDIEM_ADJUST with each figure's before → after and the reason — not VERIFY_LINE", async () => {
    const rows = await audit(id, "PERDIEM_ADJUST");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "OFFICIAL", actor: U.official });
    expect(rows[0].comment).toBe(
      "Per diem: days 3 => 3, rate 1000 => 1000, deduction 0 => 450, net 3000 => 2550 (deduction: Lunch provided by host, day 2)",
    );
    expect(await audit(id, "VERIFY_LINE")).toHaveLength(0);
  });

  it("a rate change (with its reason) keeps the deduction off the new gross", async () => {
    ok(await perdiem(ACT.official, id, { rate: 1200, rateReason: "Revised grade rate" }));
    const s = await settlementOf(id);
    expect(s.perDiem).toMatchObject({ rate: 1200, deductionInr: 450, amountInr: 3150 }); // 3 × 1200 − 450
    expect(s.amountClaimed).toBe(3150);
    const rows = await audit(id, "PERDIEM_ADJUST");
    expect(rows[1].comment).toBe(
      "Per diem: days 3 => 3, rate 1000 => 1200, deduction 450 => 450, net 2550 => 3150 (rate: Revised grade rate)",
    );
  });

  it("can't take the net below ₹0", async () => {
    ok(await perdiem(ACT.official, id, { deductionInr: 99999, deductionReason: "All meals and stay provided" }));
    const s = await settlementOf(id);
    expect(s.perDiem).toMatchObject({ deductionInr: 99999, amountInr: 0 });
    expect(s.buckets.perDiem).toBe(0);
    expect(s.amountClaimed).toBe(0);
  });

  it("null clears the deduction (no reason needed) and the net returns to the gross", async () => {
    ok(await perdiem(ACT.official, id, { deductionInr: null }));
    const s = await settlementOf(id);
    expect(s.perDiem.deductionInr).toBeUndefined();
    expect(s.perDiem.deductionReason).toBeUndefined();
    expect(s.perDiem.amountInr).toBe(3600);
    expect(s.amountClaimed).toBe(3600);
    const rows = await audit(id, "PERDIEM_ADJUST");
    expect(rows[rows.length - 1].comment).toBe("Per diem: days 3 => 3, rate 1200 => 1200, deduction 99999 => 0, net 0 => 3600");
  });

  it("days override + deduction together: net off the overridden gross, both reasons logged", async () => {
    ok(await perdiem(ACT.official, id, { overrideDays: 2, overrideReason: "Left a day early", deductionInr: 300, deductionReason: "Breakfast at hotel" }));
    const s = await settlementOf(id);
    expect(s.perDiem).toMatchObject({ days: 2, overrideDays: 2, deductionInr: 300, amountInr: 2100 }); // 2 × 1200 − 300
    const rows = await audit(id, "PERDIEM_ADJUST");
    expect(rows[rows.length - 1].comment).toBe(
      "Per diem: days 3 => 2, rate 1200 => 1200, deduction 0 => 300, net 3600 => 2100 (days: Left a day early; deduction: Breakfast at hotel)",
    );
  });
});

describe("a reason is required — on the deduction and on a rate change", () => {
  let id = "";

  it("a deduction with no (or a blank) reason is 400 and changes nothing", async () => {
    id = await verifying("QC reasons");
    for (const body of [{ deductionInr: 200 }, { deductionInr: 200, deductionReason: "   " }]) {
      const r = await perdiem(ACT.official, id, body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("deductionReason is required for a per-diem deduction");
    }
    const s = await settlementOf(id);
    expect(s.perDiem.deductionInr).toBeUndefined();
    expect(s.perDiem.amountInr).toBe(3000);
    expect(await audit(id, "PERDIEM_ADJUST")).toHaveLength(0);
  });

  it("a rate change with no reason is 400 and changes nothing", async () => {
    const r = await perdiem(ACT.official, id, { rate: 1500 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("rateReason is required when changing the per-diem rate");
    expect((await settlementOf(id)).perDiem).toMatchObject({ rate: RATE, amountInr: 3000 });
    expect(await audit(id, "PERDIEM_ADJUST")).toHaveLength(0);
  });

  it("a refused field refuses the whole call — a valid rate change alongside a reasonless deduction is not applied", async () => {
    const r = await perdiem(ACT.official, id, { rate: 1500, rateReason: "Revised", deductionInr: 200 });
    expect(r.status).toBe(400);
    expect((await settlementOf(id)).perDiem).toMatchObject({ rate: RATE, amountInr: 3000 });
  });

  it("resending the stored rate needs no reason and logs nothing", async () => {
    ok(await perdiem(ACT.official, id, { rate: RATE }));
    expect(await audit(id, "PERDIEM_ADJUST")).toHaveLength(0);
  });

  it("a negative deduction is 400", async () => {
    const r = await perdiem(ACT.official, id, { deductionInr: -50, deductionReason: "x" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("deductionInr must be a non-negative number");
  });
});

describe("who and when — the traveller's Official or a CSTEP Admin, only while VERIFYING", () => {
  let id = "";

  it("the traveller, the Approver, the Finance user and a stranger are 403; nothing changes", async () => {
    id = await verifying("QC gate");
    for (const as of [ACT.traveller, ACT.approver, ACT.finance, ACT.stranger]) {
      const r = await perdiem(as, id, { deductionInr: 100, deductionReason: "not mine to set" });
      expect(r.status).toBe(403);
    }
    expect((await settlementOf(id)).perDiem.deductionInr).toBeUndefined();
    expect(await audit(id, "PERDIEM_ADJUST")).toHaveLength(0);
  });

  it("a CSTEP Admin can set it too, logged as that Admin", async () => {
    ok(await perdiem(ACT.admin, id, { deductionInr: 500, deductionReason: "Dinner at workshop" }));
    expect((await settlementOf(id)).perDiem.amountInr).toBe(2500);
    const rows = await audit(id, "PERDIEM_ADJUST");
    expect(rows).toHaveLength(1);
    expect(String(rows[0].actor)).toBe(String(U.admin));
  });

  it("finalize carries the NET to the claim and to Finance's figure", async () => {
    const r = ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true }));
    expect(r.body.request.status).toBe("TRANSFERRED_TO_FINANCE");
    const s = await settlementOf(id);
    expect(s).toMatchObject({ status: "FINALIZED", amountClaimed: 2500 });
    const claim: any = await col("cstepclaims").findOne({ travelRequestId: new mongoose.Types.ObjectId(id) });
    expect(claim).toMatchObject({ amountClaimed: 2500, amountDueByCstep: 2500 });
    expect(ok(await get(ACT.finance, `/requests/${id}`)).body.financeAmountClaimed).toBe(2500);
  });

  it("once FINALIZED, even the Official and an Admin are refused (409)", async () => {
    for (const as of [ACT.official, ACT.admin]) {
      const r = await perdiem(as, id, { deductionInr: 0, deductionReason: "too late" });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("This settlement has already been finalized");
    }
    expect((await settlementOf(id)).perDiem.amountInr).toBe(2500);
  });
});
