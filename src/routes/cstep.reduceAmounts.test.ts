// apps/backend/src/routes/cstep.reduceAmounts.test.ts
//
// CSTEP reduce-only amounts (#11): who may lower a claim's figures, where,
// and that nobody can raise them.
//
//   Travel Desk / Admin — settlement lines (PATCH /settlement/lines/:id):
//     never above claimedAmountInr (seeded with the line), reason mandatory,
//     REDUCE_AMOUNT logged, totals + what Finance pays recomputed; a line
//     seeded before this change takes its current amount as the ceiling.
//   Manager — claim lines at approval (POST /amend): never above what the
//     traveller submitted (the value at the last SUBMIT/RESUBMIT), no new
//     lines, dropping a line is a reduction to 0; a resubmit resets the
//     ceiling.
//   Manager — report-leg fares while the report awaits them
//     (PATCH /report/legs/:legId/reduce): never above claimedFare (stamped
//     at report submit); the settlement then seeds from the reduced fare.
//   Finance — no direct edit anywhere; it sends the case back.
// Every reduction is visible in the request's activity.
//
// Real: cstep router, models, in-memory Mongo REPLICA SET (approve runs a
//   transaction) on a fresh database, cstep_qc_reduce_amounts. Fixtures go
//   through the real routes; only a leg's document id and one pre-change
//   settlement line are written raw.
// Stubbed: S3, mail, the PDF helpers, auth (x-test-user), the workspace
//   resolver (x-test-ws). Notifications stay off.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_reduce_amounts";
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
  PutObjectCommand: class {},
  GetObjectCommand: class {},
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async () => ({ key: "qc" })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));

const { default: cstepRouter } = await import("./cstep.js");

const DB = "cstep_qc_reduce_amounts";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), manager: oid(), official: oid(), finance: oid(), admin: oid() };
const TP = oid();

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
  manager: who(U.manager),
  official: who(U.official),
  finance: who(U.finance),
  admin: who(U.admin, ["ADMIN"]),
};
const send = (method: "get" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
  return body === undefined ? r : r.send(body);
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body: any = {}) =>
  send("post", as, path, path === "/requests" && body.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body);
const patch = (as: any, path: string, body: any = {}) => send("patch", as, path, body);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const logs = async (id: string, action: string) =>
  col("cstepapprovals").find({ entityId: new mongoose.Types.ObjectId(id), action }).sort({ _id: 1 }).toArray();

const TOUR = {
  type: "DOMESTIC",
  purpose: "QC reduce tour",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
  perDiemEligible: false,
};

/** A Tour with one self-paid cab leg at `fare`, its report submitted —
 * i.e. with the Manager at REPORT_UNDER_APPROVAL. */
async function tourWithReport(fare: number): Promise<{ id: string; legId: string }> {
  const id = String(ok(await post(ACT.traveller, "/requests", TOUR)).body.request._id);
  ok(await post(ACT.manager, `/requests/${id}/approve`));
  ok(await post(ACT.official, `/requests/${id}/start-arranging`));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  ok(await post(ACT.traveller, `/requests/${id}/report/start`));
  const leg = ok(
    await post(ACT.traveller, `/requests/${id}/report/legs`, {
      direction: "ONWARD", travelMode: "CAB", paidBy: "SELF", fare, currency: "INR",
      fromLocation: "Airport", toLocation: "Office", fromDate: "2026-11-02", toDate: "2026-11-02",
    }),
  ).body.leg;
  // The document upload is S3's business; the route only checks one is there.
  await col("cstepreportlegs").updateOne({ _id: new mongoose.Types.ObjectId(leg._id) }, { $set: { attachmentId: oid() } });
  ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
  return { id, legId: String(leg._id) };
}

/** A Local Travel Claim: one no-bill cab line, one food line, other expenses. */
async function submittedClaim(): Promise<any> {
  return ok(
    await post(ACT.traveller, "/requests", {
      formType: "LOCAL_TRAVEL_CLAIM",
      purpose: "QC local travel",
      departureDate: "2026-10-05",
      returnDate: "2026-10-09",
      travelLines: [{ date: "2026-10-06", from: "Office", to: "Client", mode: "CAB", fare: 500, noBill: true }],
      foodLines: [{ date: "2026-10-06", amount: 300 }],
      otherExpenses: 100,
    }),
  ).body.request;
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
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertOne({
    _id: TP, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
    email: `${U.traveller}@qc.local`, claimedBy: U.traveller,
    tourApproverId: U.manager, officialUserId: U.official, financeUserId: U.finance,
  } as any);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("Manager — report-leg fares during report approval", () => {
  let id = "";
  let legId = "";
  const reduce = (as: any, body: any) => patch(as, `/requests/${id}/report/legs/${legId}/reduce`, body);

  it("report submit stamps each leg's claimed fare", async () => {
    ({ id, legId } = await tourWithReport(1000));
    const leg = await col("cstepreportlegs").findOne({ _id: new mongoose.Types.ObjectId(legId) });
    expect(leg).toMatchObject({ fare: 1000, claimedFare: 1000 });
  });

  it("only the Manager (or Admin) may reduce — not the Official, the traveller or Finance", async () => {
    expect((await reduce(ACT.official, { fare: 500, reason: "x" })).status).toBe(403);
    expect((await reduce(ACT.traveller, { fare: 500, reason: "x" })).status).toBe(403);
    expect((await reduce(ACT.finance, { fare: 500, reason: "x" })).status).toBe(403);
  });

  it("refuses a raise above the claimed fare, and a reduction with no reason", async () => {
    const up = await reduce(ACT.manager, { fare: 1100, reason: "x" });
    expect(up.status).toBe(400);
    expect(up.body).toMatchObject({ claimedFare: 1000 });
    expect((await reduce(ACT.manager, { fare: 700 })).status).toBe(400);
    expect((await reduce(ACT.manager, { fare: 700, reason: "   " })).status).toBe(400);
    expect(await logs(id, "REDUCE_AMOUNT")).toHaveLength(0);
  });

  it("reduces with a reason — audited — and can come back up to, never past, the claimed fare", async () => {
    const r = ok(await reduce(ACT.manager, { fare: 700, reason: "Cab capped at ₹700" }));
    expect(r.body.leg).toMatchObject({ fare: 700, claimedFare: 1000 });
    const [entry] = await logs(id, "REDUCE_AMOUNT");
    expect(entry).toMatchObject({ stage: "APPROVER", actor: U.manager });
    expect(entry.comment).toContain("₹1,000 → ₹700");
    expect(entry.comment).toContain("Cab capped at ₹700");

    ok(await reduce(ACT.manager, { fare: 900, reason: "Toll receipt found" }));
    expect((await reduce(ACT.manager, { fare: 1001, reason: "x" })).status).toBe(400);
    expect((await col("cstepreportlegs").findOne({ _id: new mongoose.Types.ObjectId(legId) }))!.fare).toBe(900);
  });

  it("the settlement seeds from the reduced fare, which is now the Travel Desk's ceiling", async () => {
    ok(await post(ACT.manager, `/requests/${id}/report/approve`));
    // Not at the Manager's stage any more.
    expect((await reduce(ACT.manager, { fare: 100, reason: "late" })).status).toBe(409);

    const { lines } = ok(await post(ACT.official, `/requests/${id}/settlement/start`)).body;
    const cab = lines.find((l: any) => l.source === "REPORT_LEG");
    expect(cab).toMatchObject({ amountInr: 900, claimedAmountInr: 900 });
    expect((await patch(ACT.official, `/requests/${id}/settlement/lines/${cab._id}`, { amountInr: 1000, amountReason: "x" })).status).toBe(400);
  });
});

describe("Travel Desk / Admin — settlement lines", () => {
  let id = "";
  let line: any;
  const edit = (as: any, body: any) => patch(as, `/requests/${id}/settlement/lines/${line._id}`, body);
  const settlement = async () => ok(await get(ACT.official, `/requests/${id}/settlement`)).body.settlement;

  beforeAll(async () => {
    ({ id } = await tourWithReport(1000));
    ok(await post(ACT.manager, `/requests/${id}/report/approve`));
    const { lines } = ok(await post(ACT.official, `/requests/${id}/settlement/start`)).body;
    line = lines.find((l: any) => l.source === "REPORT_LEG");
  });

  it("seeds claimedAmountInr with the line's own amount", () => {
    expect(line).toMatchObject({ amountInr: 1000, claimedAmountInr: 1000 });
  });

  it("refuses an increase above the claimed figure, and any change without a reason", async () => {
    const up = await edit(ACT.official, { amountInr: 1200, amountReason: "x" });
    expect(up.status).toBe(400);
    expect(up.body).toMatchObject({ claimedAmountInr: 1000 });
    expect((await edit(ACT.official, { amountInr: 800 })).status).toBe(400);
    expect((await settlement()).amountClaimed).toBe(1000);
  });

  it("Finance and the Manager have no direct edit on the settlement", async () => {
    expect((await edit(ACT.finance, { amountInr: 800, amountReason: "x" })).status).toBe(403);
    expect((await edit(ACT.manager, { amountInr: 800, amountReason: "x" })).status).toBe(403);
  });

  it("a reduction with a reason recomputes the totals and logs REDUCE_AMOUNT (no VERIFY_LINE)", async () => {
    const before = await settlement();
    const r = ok(await edit(ACT.official, { amountInr: 800, amountReason: "Fare exceeds the policy cap" }));
    expect(r.body.line).toMatchObject({ amountInr: 800, claimedAmountInr: 1000 });
    expect(r.body.settlement.amountClaimed).toBe(before.amountClaimed - 200);
    expect(r.body.settlement.totalCostOfTour).toBe(before.totalCostOfTour - 200);

    const [entry] = await logs(id, "REDUCE_AMOUNT");
    expect(entry).toMatchObject({ stage: "OFFICIAL", actor: U.official });
    expect(entry.comment).toContain("₹1,000 → ₹800");
    expect(entry.comment).toContain("claimed ₹1,000");
    expect(entry.comment).toContain("Fare exceeds the policy cap");
    expect(await logs(id, "VERIFY_LINE")).toHaveLength(0);
  });

  it("can be corrected back up to the claimed figure, never past it; an Admin may reduce too", async () => {
    ok(await edit(ACT.official, { amountInr: 950, amountReason: "Partial — receipt for the toll found" }));
    expect((await edit(ACT.admin, { amountInr: 1000.01, amountReason: "x" })).status).toBe(400);
    ok(await edit(ACT.admin, { amountInr: 900, amountReason: "Admin review" }));
    expect(await logs(id, "REDUCE_AMOUNT")).toHaveLength(3);
  });

  it("verifying alone logs VERIFY_LINE and needs no reason", async () => {
    ok(await edit(ACT.official, { verified: true }));
    expect(await logs(id, "VERIFY_LINE")).toHaveLength(1);
    expect(await logs(id, "REDUCE_AMOUNT")).toHaveLength(3);
  });

  it("a line seeded before reduce-only takes its current amount as the ceiling, and keeps it", async () => {
    const s = await settlement();
    const legacyId = oid();
    await col("cstepsettlementlines").insertOne({
      _id: legacyId, workspaceId: WS, settlementId: new mongoose.Types.ObjectId(s._id), requestId: new mongoose.Types.ObjectId(id),
      source: "REPORT_LEG", sourceId: oid(), description: "Pre-change line", mode: "CAB", amountInr: 500,
      classification: "PERSONAL", classificationOverridden: false, verified: false, createdBy: U.official,
    } as any);
    const path = `/requests/${id}/settlement/lines/${legacyId}`;
    expect((await patch(ACT.official, path, { amountInr: 600, amountReason: "x" })).status).toBe(400);
    const r = ok(await patch(ACT.official, path, { amountInr: 400, amountReason: "Duplicate charge" }));
    expect(r.body.line).toMatchObject({ amountInr: 400, claimedAmountInr: 500 });
    expect((await patch(ACT.official, path, { amountInr: 501, amountReason: "x" })).status).toBe(400);
  });

  it("the reduced figure is what goes to Finance", async () => {
    const all = ok(await get(ACT.official, `/requests/${id}/settlement`)).body.lines;
    for (const l of all) if (!l.verified) ok(await patch(ACT.official, `/requests/${id}/settlement/lines/${l._id}`, { verified: true }));
    const f = ok(await post(ACT.official, `/requests/${id}/settlement/finalize`));
    expect(f.body.request.status).toBe("TRANSFERRED_TO_FINANCE");
    const asFinance = ok(await get(ACT.finance, `/requests/${id}`)).body;
    expect(asFinance.financeAmountClaimed).toBe(900 + 400);
    // Finance still has no edit — its way to a lower figure is the send-back.
    expect((await patch(ACT.finance, `/requests/${id}/settlement/lines/${line._id}`, { amountInr: 1, amountReason: "x" })).status).toBe(403);
    expect((await post(ACT.finance, `/requests/${id}/finance/return`, {})).status).toBe(400);
    ok(await post(ACT.finance, `/requests/${id}/finance/return`, { reason: "Reduce the cab line to ₹700" }));
    // Back with the Desk, who reduces it, still under the same ceiling.
    expect((await patch(ACT.official, `/requests/${id}/settlement/lines/${line._id}`, { amountInr: 1100, amountReason: "x" })).status).toBe(400);
    ok(await patch(ACT.official, `/requests/${id}/settlement/lines/${line._id}`, { amountInr: 700, amountReason: "Per Finance" }));
  });
});

describe("Manager — claim lines at approval (POST /amend)", () => {
  let claim: any;
  const amend = (as: any, field: string, newValue: any, reason = "Policy cap") =>
    post(as, `/requests/${claim._id}/amend`, { field, newValue, reason });
  const current = async () => ok(await get(ACT.manager, `/requests/${claim._id}`)).body.request;
  const withFare = (doc: any, fare: number) => doc.travelLines.map((l: any) => ({ ...l, fare }));

  beforeAll(async () => {
    claim = await submittedClaim();
    expect(claim.status).toBe("SUBMITTED");
  });

  it("only the Manager (or Admin) amends — not the Official or Finance", async () => {
    expect((await amend(ACT.official, "travelLines", withFare(claim, 400))).status).toBe(403);
    expect((await amend(ACT.finance, "travelLines", withFare(claim, 400))).status).toBe(403);
  });

  it("refuses any amount above what was submitted, and a reduction without a reason", async () => {
    const up = await amend(ACT.manager, "travelLines", withFare(claim, 600));
    expect(up.status).toBe(400);
    expect(up.body.error).toMatch(/can only be reduced/);
    expect((await amend(ACT.manager, "otherExpenses", 150)).status).toBe(400);
    expect((await amend(ACT.manager, "travelLines", withFare(claim, 400), "")).status).toBe(400);
    expect(await logs(claim._id, "REDUCE_AMOUNT")).toHaveLength(0);
  });

  it("reduces a line with a reason: totals recompute, REDUCE_AMOUNT + the amendment logged", async () => {
    const r = ok(await amend(ACT.manager, "travelLines", withFare(claim, 400), "Cab capped at ₹400"));
    expect(r.body.request.claimTotals).toMatchObject({ travel: 400, food: 300, other: 100, gross: 800 });
    const [entry] = await logs(claim._id, "REDUCE_AMOUNT");
    expect(entry).toMatchObject({ stage: "APPROVER", actor: U.manager });
    expect(entry.comment).toContain("₹500 → ₹400");
    expect(entry.comment).toContain("Cab capped at ₹400");
    expect(await col("cstepamendments").countDocuments({ requestId: new mongoose.Types.ObjectId(claim._id), field: "travelLines" })).toBe(1);
  });

  it("the ceiling stays the submitted figure: back up to ₹500 is fine, ₹501 is not", async () => {
    const doc = await current();
    ok(await amend(ACT.manager, "travelLines", withFare(doc, 500), "Receipt checks out"));
    expect((await amend(ACT.manager, "travelLines", withFare(doc, 501))).status).toBe(400);
  });

  it("no line can be added; dropping a line is a reduction to ₹0", async () => {
    const doc = await current();
    const added = [...doc.foodLines, { date: "2026-10-07", amount: 50 }];
    expect((await amend(ACT.manager, "foodLines", added)).status).toBe(400);
    const r = ok(await amend(ACT.manager, "foodLines", [], "Meal not reimbursable"));
    expect(r.body.request.claimTotals.food).toBe(0);
    const last = (await logs(claim._id, "REDUCE_AMOUNT")).pop()!;
    expect(last.comment).toContain("₹300 → ₹0, line dropped");
  });

  it("Other expenses reduce like a line", async () => {
    ok(await amend(ACT.manager, "otherExpenses", 50, "Only ₹50 evidenced"));
    expect((await current()).claimTotals.other).toBe(50);
  });

  it("approval seeds the settlement from the reduced figures, as their ceiling", async () => {
    ok(await post(ACT.manager, `/requests/${claim._id}/approve`));
    const { lines } = ok(await get(ACT.admin, `/requests/${claim._id}/settlement`)).body;
    const travel = lines.find((l: any) => l.description.startsWith("Cab"));
    expect(travel).toMatchObject({ amountInr: 500, claimedAmountInr: 500 });
    expect(lines.find((l: any) => l.description === "Other expenses")).toMatchObject({ amountInr: 50, claimedAmountInr: 50 });
    expect(lines.some((l: any) => l.description.startsWith("Food"))).toBe(false);
    // The Admin verifies a claim's lines — reduce-only there too; the
    // Manager has no settlement edit on a claim.
    expect((await patch(ACT.admin, `/requests/${claim._id}/settlement/lines/${travel._id}`, { amountInr: 600, amountReason: "x" })).status).toBe(400);
    expect((await patch(ACT.manager, `/requests/${claim._id}/settlement/lines/${travel._id}`, { amountInr: 300, amountReason: "x" })).status).toBe(403);
    const r = ok(await patch(ACT.admin, `/requests/${claim._id}/settlement/lines/${travel._id}`, { amountInr: 450, amountReason: "Admin check" }));
    expect(r.body.settlement.amountClaimed).toBe(450 + 50);
  });

  it("a returned and resubmitted claim takes its new figures as the ceiling", async () => {
    const c2 = await submittedClaim();
    ok(await post(ACT.manager, `/requests/${c2._id}/return`, { reason: "Add the second trip" }));
    const fixed = { ...c2, travelLines: c2.travelLines.map((l: any) => ({ ...l, fare: 700 })) };
    ok(await patch(ACT.traveller, `/requests/${c2._id}`, { travelLines: fixed.travelLines }));
    ok(await post(ACT.traveller, `/requests/${c2._id}/submit`));
    const doc = ok(await get(ACT.manager, `/requests/${c2._id}`)).body.request;
    ok(await post(ACT.manager, `/requests/${c2._id}/amend`, { field: "travelLines", newValue: doc.travelLines.map((l: any) => ({ ...l, fare: 650 })), reason: "Cap" }));
    // ₹700 (the resubmitted figure) is allowed back; ₹701 is not.
    ok(await post(ACT.manager, `/requests/${c2._id}/amend`, { field: "travelLines", newValue: doc.travelLines.map((l: any) => ({ ...l, fare: 700 })), reason: "Undo" }));
    expect((await post(ACT.manager, `/requests/${c2._id}/amend`, { field: "travelLines", newValue: doc.travelLines.map((l: any) => ({ ...l, fare: 701 })), reason: "x" })).status).toBe(400);
  });
});

describe("reductions are visible on the request", () => {
  it("the activity lists each REDUCE_AMOUNT with who, before → after and the reason", async () => {
    const { id, legId } = await tourWithReport(800);
    ok(await patch(ACT.manager, `/requests/${id}/report/legs/${legId}/reduce`, { fare: 600, reason: "Shared cab" }));
    const entries = ok(await get(ACT.traveller, `/requests/${id}/activity`)).body;
    const list = entries.entries || entries.activity || entries;
    const reduced = (list as any[]).find((e) => e.action === "REDUCE_AMOUNT");
    expect(reduced).toBeTruthy();
    expect(reduced.comment).toContain("₹800 → ₹600");
    expect(reduced.comment).toContain("Shared cab");
    expect(String(reduced.actor)).toBe(String(U.manager));
  });
});
