// apps/backend/src/routes/cstep.claims.test.ts
//
// CSTEP claims module 1 — the Local Travel Claim driven end to end through
// the real CSTEP router: intake (staged receipts, no-bill lines, stored
// totals), submit → manager (Tour Approver slot) approve → CSTEP Admin
// verify → Finance pay, plus the return / reject / cancel paths, Finance's
// send-back to the Admin, and the net-of-advance math in all three
// directions (owed to the claimant, owed to CSTEP, nothing owed). Also: an
// approved claim is never pulled into arrangement or a report-based
// settlement, never lands on the Official's Processing board, gets its own
// claim reference (no TIN / CstepClaim), feeds the Travel Register as
// LOCAL, renders its own PDF (never the Tour Proposal's), and an unknown
// formType is refused instead of becoming a Tour Proposal.
//
// Real: cstep router, models, the claim PDF renderer (its S3 put is
//   captured), the register workbook, in-memory Mongo REPLICA SET (approve
//   runs in a transaction) on a fresh database, cstep_qc_claims.
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
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_claims";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
// Notifications ship dormant — and stay off here; this suite is about the flow.
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

const s3Puts = vi.hoisted(() => [] as Array<{ Key: string; Body: Buffer }>);
const presigned = vi.hoisted(() => [] as any[]);
let uploadSeq = 0;
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: any) {
      s3Puts.push(cmd.input);
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
vi.mock("../utils/s3Presign.js", () => ({
  presignGetObject: vi.fn(async (args: any) => {
    presigned.push(args);
    return "http://qc/presigned";
  }),
}));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));

const { default: cstepRouter } = await import("./cstep.js");

const DB = "cstep_qc_claims";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
// Project Master — every request needs a project picked from the master.
// One QC project, added to a create body that names none (QC_PROJECT seeded
// in beforeAll).
const QC_PROJECT = oid();
const withProject = (path: string, body: any) =>
  path === "/requests" && body && body.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body;
const U = { traveller: oid(), approver: oid(), official: oid(), finance: oid(), admin: oid(), other: oid() };
const TP = { main: oid(), other: oid() };

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
const stage = async (as: any, name = "receipt.pdf") =>
  String(
    ok(
      await request(app)
        .post("/api/cstep/attachments/staging")
        .set("x-test-user", JSON.stringify(as))
        .set("x-test-ws", String(WS))
        .field("documentType", "CAB_RECEIPT")
        .attach("file", Buffer.from("%PDF-1.4 qc receipt"), { filename: name, contentType: "application/pdf" }),
    ).body.attachment._id,
  );

// References carry the IST month (utils/cstepSequence.ts), not server time.
const MMYY = (() => {
  const d = new Date(Date.now() + 330 * 60 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
})();

const PERIOD = { departureDate: "2026-10-05", returnDate: "2026-10-09" };
const claimBody = (over: any = {}) => ({
  formType: "LOCAL_TRAVEL_CLAIM",
  purpose: "Client meetings across the city",
  project: "PRJ-QC",
  ...PERIOD,
  travelLines: [],
  foodLines: [],
  ...over,
});

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
      email: `${U.traveller}@qc.local`, claimedBy: U.traveller,
      tourApproverId: U.approver, officialUserId: U.official, financeUserId: U.finance,
    },
    { _id: TP.other, workspaceId: WS, travelerId: "CSTEP-002", firstName: "Ravi", lastName: "K", isActive: true, email: `${U.other}@qc.local`, claimedBy: U.other, tourApproverId: U.approver },
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("form-type resolution — nothing silently becomes a Tour Proposal", () => {
  it("an unknown formType is refused, not coerced", async () => {
    const r = await post(ACT.traveller, "/requests", { ...claimBody(), formType: "MYSTERY_FORM" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Unknown form type");
    expect(await col("csteptravelrequests").countDocuments()).toBe(0);
  });

  it("EXPENSE_CLAIM is validated as an Expense Claim (its own rules — see cstep.expense.test.ts)", async () => {
    const r = await post(ACT.traveller, "/requests", { ...claimBody(), formType: "EXPENSE_CLAIM" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Add at least one expense line");
  });

  it("an omitted formType still defaults to TOUR_PROPOSAL (existing clients unchanged)", async () => {
    const r = ok(
      await post(ACT.traveller, "/requests", {
        type: "DOMESTIC", purpose: "QC tour", departureDate: "2026-11-02", returnDate: "2026-11-03",
        stations: [{ from: "Bengaluru", to: "Delhi" }], saveDraft: true,
        travelLines: [{ date: "2026-11-02", from: "x", to: "y", mode: "CAB", fare: 10, noBill: true }],
      }),
    );
    expect(r.body.request.formType).toBe("TOUR_PROPOSAL");
    // A stray claim field never lands on a Tour Proposal.
    expect(r.body.request.travelLines).toBeUndefined();
    expect(r.body.request.claimTotals).toBeUndefined();
  });
});

describe("Local Travel Claim — validation and intake", () => {
  it("a travel line needs a bill or an explicit no-bill", async () => {
    const r = await post(ACT.traveller, "/requests", claimBody({
      travelLines: [{ date: "2026-10-06", from: "Office", to: "Client", mode: "CAB", fare: 300 }],
    }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/attach the bill, or mark it as having no bill/);
  });

  it("every line must fall inside the claim period", async () => {
    const r = await post(ACT.traveller, "/requests", claimBody({
      foodLines: [{ date: "2026-10-20", amount: 100 }],
    }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/within the claim period/);
  });

  it("a claim with no lines and no other expenses is refused", async () => {
    const r = await post(ACT.traveller, "/requests", claimBody());
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at least one travel or food line/);
  });

  it("someone else's staged receipt cannot be attached", async () => {
    const theirs = await stage(ACT.other, "theirs.pdf");
    const r = await post(ACT.traveller, "/requests", claimBody({
      travelLines: [{ date: "2026-10-06", from: "Office", to: "Client", mode: "CAB", fare: 300, attachmentId: theirs }],
    }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not yours to attach/);
  });
});

describe("Local Travel Claim — end to end: submit → return → resubmit → approve → Admin verify → Finance return → re-verify → pay", () => {
  let id = "";
  let receipt = "";
  let ref = "";
  let lineIds: { cab: string; noBill: string; food: string } = { cab: "", noBill: "", food: "" };

  it("stages a receipt before the claim exists (no claim/request link yet)", async () => {
    receipt = await stage(ACT.traveller);
    const att = await col("cstepattachments").findOne({ _id: new mongoose.Types.ObjectId(receipt) });
    expect(att!.claimId).toBeUndefined();
    expect(att!.travelRequestId).toBeUndefined();
    expect(att!.documentType).toBe("CAB_RECEIPT");
  });

  it("saves a draft: Tour fields stripped, receipt linked, totals stored net of the advance", async () => {
    const r = ok(
      await post(ACT.traveller, "/requests", claimBody({
        saveDraft: true,
        type: "DOMESTIC", // Tour-only — must be dropped
        stations: [{ from: "A", to: "B" }], // Tour-only — must be dropped
        travelLines: [
          { date: "2026-10-05", from: "Office", to: "Client HQ", mode: "LOCAL_TAXI", fare: 450, remarks: "Morning meeting", attachmentId: receipt, noBill: true },
          { date: "2026-10-06", from: "Client HQ", to: "Metro station", mode: "METRO", fare: 120, noBill: true, remarks: "Token, no ticket" },
        ],
        foodLines: [{ date: "2026-10-06", amount: 300, remarks: "Working lunch" }],
        otherExpenses: 80,
        advanceTaken: 500,
      })),
    );
    const doc = r.body.request;
    id = String(doc._id);
    expect(doc.formType).toBe("LOCAL_TRAVEL_CLAIM");
    expect(doc.status).toBe("DRAFT");
    expect(doc.type).toBeUndefined();
    expect(doc.stations).toEqual([]); // schema default for every document; nothing from the payload
    // A line with a receipt is never also "no bill".
    expect(doc.travelLines[0].noBill).toBe(false);
    expect(doc.travelLines[1].noBill).toBe(true);
    expect(doc.claimTotals).toEqual({ travel: 570, food: 300, other: 80, gross: 950, advance: 500, net: 450, dueByCstep: 450, dueToCstep: 0 });
    lineIds = { cab: String(doc.travelLines[0]._id), noBill: String(doc.travelLines[1]._id), food: String(doc.foodLines[0]._id) };

    const att = await col("cstepattachments").findOne({ _id: new mongoose.Types.ObjectId(receipt) });
    expect(String(att!.travelRequestId)).toBe(id);
  });

  it("submits → the traveller's Tour Approver (the manager) sees it", async () => {
    ok(await post(ACT.traveller, `/requests/${id}/submit`));
    const q = ok(await get(ACT.approver, "/approvals")).body.requests;
    expect(q.map((r: any) => String(r._id))).toContain(id);
  });

  it("RETURN → the claimant edits a fare (totals re-stored) → RESUBMIT", async () => {
    ok(await post(ACT.approver, `/requests/${id}/return`, { reason: "Fix the taxi fare" }));
    const doc = (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!;
    expect(doc.status).toBe("RETURNED");

    const lines = doc.travelLines.map((l: any) => ({ ...l, _id: String(l._id), attachmentId: l.attachmentId ? String(l.attachmentId) : undefined }));
    lines[0].fare = 400;
    const r = ok(await patch(ACT.traveller, `/requests/${id}`, { travelLines: lines }));
    expect(r.body.request.claimTotals).toMatchObject({ travel: 520, gross: 900, net: 400, dueByCstep: 400, dueToCstep: 0 });
    // Line ids survive an edit — the settlement will point at them.
    expect(String(r.body.request.travelLines[0]._id)).toBe(lineIds.cab);

    ok(await post(ACT.traveller, `/requests/${id}/submit`));
    const trail = await col("cstepapprovals").find({ entityId: new mongoose.Types.ObjectId(id) }).sort({ at: 1 }).toArray();
    expect(trail.map((t: any) => t.action)).toEqual(["SUBMIT", "RETURN", "RESUBMIT"]);
  });

  it("only the mapped approver (or an Admin) can approve", async () => {
    const r = await post(ACT.official, `/requests/${id}/approve`);
    expect(r.status).toBe(403);
  });

  it("APPROVE → claim reference, NO TIN/CstepClaim, a VERIFYING settlement seeded from the claim lines", async () => {
    const r = ok(await post(ACT.approver, `/requests/${id}/approve`));
    ref = r.body.claimReference;
    expect(ref).toBe(`LTC0001/${MMYY}`);
    expect(r.body.request.status).toBe("APPROVED");
    expect(r.body.request.claimReference).toBe(ref);
    expect(r.body.claim).toBeNull();
    expect(await col("cstepclaims").countDocuments({ travelRequestId: new mongoose.Types.ObjectId(id) })).toBe(0);

    const settlement = (await col("cstepsettlements").findOne({ requestId: new mongoose.Types.ObjectId(id) }))!;
    expect(settlement.status).toBe("VERIFYING");
    expect(settlement.perDiem.amountInr).toBe(0);
    expect(settlement.perDiem.days).toBe(0);
    expect(settlement.amountClaimed).toBe(900);
    expect(settlement.totalCostOfTour).toBe(900);
    expect(settlement.advanceTaken).toBe(500);
    expect(settlement.amountDueByCstep).toBe(400);
    expect(settlement.amountDueToCstep).toBe(0);

    const lines = await col("cstepsettlementlines").find({ settlementId: settlement._id }).sort({ _id: 1 }).toArray();
    expect(lines).toHaveLength(4);
    expect(lines.every((l: any) => l.source === "CLAIM_LINE" && l.classification === "PERSONAL" && !l.verified)).toBe(true);
    expect(lines.map((l: any) => String(l.sourceId))).toEqual([lineIds.cab, lineIds.noBill, lineIds.food, id]);
    expect(lines.map((l: any) => l.amountInr)).toEqual([400, 120, 300, 80]);
    expect(lines.map((l: any) => l.mode)).toEqual(["CAB", "TRAIN", "OTHER", "OTHER"]);
    expect(String(lines[0].attachmentId)).toBe(receipt);
    expect(lines[1].description).toBe("Metro: Client HQ → Metro station (no bill)");
  });

  it("opening the approved claim never pulls it into arrangement or a report-based settlement", async () => {
    for (const as of [ACT.official, ACT.admin]) {
      const g = ok(await get(as, `/requests/${id}`)).body;
      expect(g.canArrange).toBe(false);
      expect(g.arrangements).toEqual([]);
    }
    const asAdmin = ok(await get(ACT.admin, `/requests/${id}`)).body;
    expect(asAdmin.canSettle).toBe(true);
    expect(asAdmin.canVerifyClaim).toBe(true);
    const asOfficial = ok(await get(ACT.official, `/requests/${id}`)).body;
    expect(asOfficial.canSettle).toBe(false);
    expect(asOfficial.canVerifyClaim).toBe(false);

    // What the two open-and-start effects would call — both refuse a claim.
    const arr = await post(ACT.official, `/requests/${id}/start-arranging`);
    expect(arr.status).toBe(409);
    const arrAdmin = await post(ACT.admin, `/requests/${id}/start-arranging`);
    expect(arrAdmin.status).toBe(409);
    const st = await post(ACT.admin, `/requests/${id}/settlement/start`);
    expect(st.status).toBe(409);

    const doc = (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!;
    expect(doc.status).toBe("APPROVED");
    expect(await col("cstepapprovals").countDocuments({ entityId: doc._id, action: { $in: ["START_ARRANGING", "START_VERIFICATION"] } })).toBe(0);
    expect(await col("cstepsettlements").countDocuments({ requestId: doc._id })).toBe(1);
    expect(await col("cstepsettlementlines").countDocuments({ requestId: doc._id })).toBe(4);
  });

  it("goes to the Admin's claim verification queue, never the Official's Processing board", async () => {
    const official = ok(await get(ACT.official, "/official-queue")).body;
    expect(official.requests.map((r: any) => String(r._id))).not.toContain(id);
    const adminProcessing = ok(await get(ACT.admin, "/official-queue")).body;
    expect(adminProcessing.requests.map((r: any) => String(r._id))).not.toContain(id);

    const verify = ok(await get(ACT.admin, "/claim-verification-queue")).body;
    expect(verify.requests.map((r: any) => String(r._id))).toContain(id);
    expect(verify.stageCounts.APPROVED).toBe(1);
    const nonAdmin = ok(await get(ACT.official, "/claim-verification-queue")).body;
    expect(nonAdmin.requests).toEqual([]);
  });

  it("every item with no bill lands in the Declaration (detail payload), the receipted ones do not", async () => {
    const g = ok(await get(ACT.traveller, `/requests/${id}`)).body;
    // #8: not only the travel line marked "no bill" — the food line with no
    // receipt and the Other expenses amount (nowhere to attach one) too.
    expect(g.claimDeclaration).toEqual([
      { lineId: lineIds.noBill, kind: "TRAVEL", date: "2026-10-06", particulars: "Metro: Client HQ → Metro station — Token, no ticket", amount: 120 },
      { lineId: lineIds.food, kind: "FOOD", date: "2026-10-06", particulars: "Food: Working lunch", amount: 300 },
      { lineId: "otherExpenses", kind: "OTHER", particulars: "Other expenses", amount: 80 },
    ]);
    expect(Object.keys(g.claimAttachments)).toEqual([receipt]);
  });

  it("the claim's settlement belongs to the Admin: the Official may not see or edit it", async () => {
    const view = await get(ACT.official, `/requests/${id}/settlement`);
    expect(view.status).toBe(403);
    const lines = ok(await get(ACT.admin, `/requests/${id}/settlement`)).body.lines;
    const edit = await patch(ACT.official, `/requests/${id}/settlement/lines/${lines[0]._id}`, { verified: true });
    expect(edit.status).toBe(403);
    const perdiem = await patch(ACT.admin, `/requests/${id}/settlement/perdiem`, { rate: 500 });
    expect(perdiem.status).toBe(409);
    const finalize = await post(ACT.admin, `/requests/${id}/settlement/finalize`, { force: true });
    expect(finalize.status).toBe(409);
  });

  it("Admin verify refuses while lines are unverified", async () => {
    const r = await post(ACT.admin, `/requests/${id}/claim/verify`);
    expect(r.status).toBe(409);
    expect(r.body.unverifiedCount).toBe(4);
  });

  it("Admin corrects the food line (300 → 250) and verifies every line — net re-derived", async () => {
    const lines = ok(await get(ACT.admin, `/requests/${id}/settlement`)).body.lines;
    let settlement: any;
    for (const l of lines) {
      const body: any = { verified: true };
      // Reduce-only: an amount change carries its reason.
      if (String(l.sourceId) === lineIds.food) Object.assign(body, { amountInr: 250, amountReason: "Bill shows ₹250" });
      settlement = ok(await patch(ACT.admin, `/requests/${id}/settlement/lines/${l._id}`, body)).body.settlement;
    }
    expect(settlement.amountClaimed).toBe(850);
    expect(settlement.amountDueByCstep).toBe(350);
    expect(settlement.amountDueToCstep).toBe(0);
  });

  it("only an Admin verifies; verify → TRANSFERRED_TO_FINANCE and the lines freeze", async () => {
    const notAdmin = await post(ACT.official, `/requests/${id}/claim/verify`);
    expect(notAdmin.status).toBe(403);

    const r = ok(await post(ACT.admin, `/requests/${id}/claim/verify`));
    expect(r.body.request.status).toBe("TRANSFERRED_TO_FINANCE");
    expect(r.body.settlement.status).toBe("VERIFYING"); // Finance finalizes it when it pays

    const lines = ok(await get(ACT.admin, `/requests/${id}/settlement`)).body.lines;
    const frozen = await patch(ACT.admin, `/requests/${id}/settlement/lines/${lines[0]._id}`, { amountInr: 1 });
    expect(frozen.status).toBe(409);

    const fin = ok(await get(ACT.finance, "/finance-queue")).body.requests;
    expect(fin.map((x: any) => String(x._id))).toContain(id);
    const g = ok(await get(ACT.finance, `/requests/${id}`)).body;
    expect(g.canFinance).toBe(true);
    expect(g.financeClaimDue).toEqual({ amountDueByCstep: 350, amountDueToCstep: 0, advanceTaken: 500 });
  });

  it("Finance sends it back to the Admin (not an Official), who re-verifies", async () => {
    ok(await post(ACT.finance, `/requests/${id}/finance/return`, { reason: "Check the metro line" }));
    let doc = (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!;
    expect(doc.status).toBe("APPROVED");
    const back = await col("cstepapprovals").findOne({ entityId: doc._id, action: "RETURN_TO_ADMIN" });
    expect(back!.comment).toBe("Check the metro line");

    ok(await post(ACT.admin, `/requests/${id}/claim/verify`));
    doc = (await col("csteptravelrequests").findOne({ _id: doc._id }))!;
    expect(doc.status).toBe("TRANSFERRED_TO_FINANCE");
  });

  it("the Admin's part ends at verify: no Finance card, and reimbursing is 403", async () => {
    expect(ok(await get(ACT.admin, `/requests/${id}`)).body.canFinance).toBe(false);
    const r = await post(ACT.admin, `/requests/${id}/finance/settle`, { reference: "UTR-ADMIN" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("Only the assigned finance user can record payments");
    const doc = (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!;
    expect(doc.status).toBe("TRANSFERRED_TO_FINANCE");
    expect((await col("cstepsettlements").findOne({ requestId: doc._id }))!.status).toBe("VERIFYING");
    expect(await col("cstepapprovals").countDocuments({ entityId: doc._id, action: "FINANCE_SETTLE" })).toBe(0);
  });

  it("Finance pays → REIMBURSED; the settlement is finalized with the net figure", async () => {
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { reference: "UTR-QC-1" }));
    const doc = (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!;
    expect(doc.status).toBe("REIMBURSED");
    const settlement = (await col("cstepsettlements").findOne({ requestId: doc._id }))!;
    expect(settlement.status).toBe("FINALIZED");
    expect(settlement.outcome).toBe("TO_FINANCE");
    const pay = await col("cstepapprovals").findOne({ entityId: doc._id, action: "FINANCE_SETTLE" });
    expect(pay!.comment).toBe("₹350 reimbursed to the claimant | Ref: UTR-QC-1");
    expect(await col("cstepclaims").countDocuments({})).toBe(0);
  });

  it("renders the Local Travel Claim PDF — never the Tour Proposal form", async () => {
    s3Puts.length = 0;
    presigned.length = 0;
    ok(await get(ACT.traveller, `/requests/${id}/pdf`));
    expect(s3Puts).toHaveLength(1);
    expect(s3Puts[0].Key).toMatch(/^cstep-claims\/.+\/local-travel-claim-\d+\.pdf$/);
    expect(Buffer.from(s3Puts[0].Body).subarray(0, 5).toString()).toBe("%PDF-");
    expect(presigned[0].filename).toBe(`Local-Travel-Claim-${ref}.pdf`);

    const packet = await get(ACT.traveller, `/requests/${id}/packet`);
    expect(packet.status).toBe(409);
  });

  it("feeds the Travel Register as LOCAL with its claim reference; Expense Claims stay out", async () => {
    // An Expense Claim can't be filed through the API yet — plant one to
    // prove the register's exclusion holds once module 2 exists.
    await col("csteptravelrequests").insertOne({
      workspaceId: WS, travelerProfileId: TP.main, formType: "EXPENSE_CLAIM", purpose: "QC expense claim",
      departureDate: "2026-10-07", returnDate: "2026-10-07", status: "SUBMITTED", createdBy: U.traveller,
      createdAt: new Date(), updatedAt: new Date(),
    } as any);

    const r = await request(app)
      .get("/api/cstep/reports/travel-register?period=custom&from=2026-10-01&to=2026-10-31")
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
    await wb.xlsx.load(r.body as any); // exceljs types want a non-generic Buffer
    const ws = wb.getWorksheet("Travel Register")!;
    const rows: any[][] = [];
    ws.eachRow((row) => rows.push((row.values as any[]).slice(1)));
    const claimRows = rows.filter((v) => v[1] === ref);
    // 4 claim-line rows + the TOTAL row.
    expect(claimRows).toHaveLength(5);
    expect(claimRows.every((v) => v[2] === "LOCAL")).toBe(true);
    expect(claimRows[0][0]).toBe("Oct"); // filed under the claim period's start
    expect(claimRows[0][5]).toBe("Office"); // From — the claim line's own route
    expect(claimRows[0][6]).toBe("Client HQ");
    expect(claimRows[1][12]).toBe("Metro: Client HQ → Metro station (no bill)");
    const total = claimRows[4];
    expect(total[11]).toBe("TOTAL");
    expect(total[12]).toBe("Total claimed");
    expect(total[13]).toBe(850);
    expect(rows.some((v) => v[4] === "QC expense claim")).toBe(false);
    expect(rows.some((v) => v[2] === "DOM" && v[1] === ref)).toBe(false);
  });
});

describe("Local Travel Claim — reject, cancel, and the advance in every direction", () => {
  const fileClaim = async (as: any, over: any) => {
    const r = ok(await post(as, "/requests", claimBody(over)));
    return String(r.body.request._id);
  };
  const verifyAll = async (cid: string) => {
    const lines = ok(await get(ACT.admin, `/requests/${cid}/settlement`)).body.lines;
    for (const l of lines) ok(await patch(ACT.admin, `/requests/${cid}/settlement/lines/${l._id}`, { verified: true }));
  };

  it("REJECT is terminal — no reference, no settlement", async () => {
    const cid = await fileClaim(ACT.traveller, { otherExpenses: 150 });
    ok(await post(ACT.approver, `/requests/${cid}/reject`, { reason: "Not official work" }));
    const doc = (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(cid) }))!;
    expect(doc.status).toBe("REJECTED");
    expect(doc.claimReference).toBeUndefined();
    expect(await col("cstepsettlements").countDocuments({ requestId: doc._id })).toBe(0);
    const again = await post(ACT.approver, `/requests/${cid}/approve`);
    expect(again.status).toBe(409);
  });

  it("CANCEL from draft, and from APPROVED with a reason", async () => {
    const draft = await fileClaim(ACT.traveller, { otherExpenses: 50, saveDraft: true });
    ok(await post(ACT.traveller, `/requests/${draft}/cancel`));
    expect((await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(draft) }))!.status).toBe("CANCELLED");

    const approved = await fileClaim(ACT.traveller, { otherExpenses: 60 });
    ok(await post(ACT.approver, `/requests/${approved}/approve`));
    const noReason = await post(ACT.traveller, `/requests/${approved}/cancel`);
    expect(noReason.status).toBe(400);
    ok(await post(ACT.traveller, `/requests/${approved}/cancel`, { reason: "Filed twice" }));
    expect((await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(approved) }))!.status).toBe("CANCELLED");
  });

  it("a second claim takes the next LTC serial", async () => {
    const refs = (await col("csteptravelrequests").find({ formType: "LOCAL_TRAVEL_CLAIM", claimReference: { $exists: true } }).toArray()).map((d: any) => d.claimReference);
    expect(refs).toEqual(expect.arrayContaining([`LTC0001/${MMYY}`, `LTC0002/${MMYY}`]));
  });

  it("advance > total → amount due TO CSTEP; Finance records the repayment → SETTLED", async () => {
    const cid = await fileClaim(ACT.traveller, { foodLines: [{ date: "2026-10-07", amount: 200 }], advanceTaken: 500 });
    const doc = ok(await get(ACT.traveller, `/requests/${cid}`)).body.request;
    expect(doc.claimTotals).toEqual({ travel: 0, food: 200, other: 0, gross: 200, advance: 500, net: -300, dueByCstep: 0, dueToCstep: 300 });

    ok(await post(ACT.approver, `/requests/${cid}/approve`));
    await verifyAll(cid);
    const v = ok(await post(ACT.admin, `/requests/${cid}/claim/verify`)).body;
    expect(v.request.status).toBe("TRANSFERRED_TO_FINANCE");
    expect(v.settlement.amountDueToCstep).toBe(300);
    expect(v.settlement.amountDueByCstep).toBe(0);

    ok(await post(ACT.finance, `/requests/${cid}/finance/settle`, { reference: "RCPT-9" }));
    const after = (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(cid) }))!;
    expect(after.status).toBe("SETTLED");
    const pay = await col("cstepapprovals").findOne({ entityId: after._id, action: "FINANCE_SETTLE" });
    expect(pay!.comment).toBe("₹300 received back from the claimant | Ref: RCPT-9");
  });

  it("advance == total → nothing to move: Admin verify closes it SETTLED, Finance never sees it", async () => {
    const cid = await fileClaim(ACT.traveller, { otherExpenses: 400, advanceTaken: 400 });
    ok(await post(ACT.approver, `/requests/${cid}/approve`));
    await verifyAll(cid);
    const v = ok(await post(ACT.admin, `/requests/${cid}/claim/verify`)).body;
    expect(v.request.status).toBe("SETTLED");
    expect(v.settlement.status).toBe("FINALIZED");
    expect(v.settlement.outcome).toBe("CLOSE");
    const fin = ok(await get(ACT.finance, "/finance-queue")).body.requests;
    expect(fin.map((x: any) => String(x._id))).not.toContain(cid);
  });
});

describe("Tour Proposal is unchanged by the claims foundation", () => {
  it("a Tour approve still issues the TIN and opens a CstepClaim", async () => {
    const r = ok(
      await post(ACT.traveller, "/requests", {
        type: "DOMESTIC", purpose: "QC tour 2", departureDate: "2026-11-10", returnDate: "2026-11-11",
        stations: [{ from: "Bengaluru", to: "Pune" }],
      }),
    );
    const tid = String(r.body.request._id);
    const a = ok(await post(ACT.approver, `/requests/${tid}/approve`)).body;
    expect(a.claimReference).toBe(`0001/${MMYY}`);
    expect(a.claim.travelRequestId).toBe(tid);
    expect(ok(await get(ACT.official, "/official-queue")).body.requests.map((x: any) => String(x._id))).toContain(tid);
    ok(await post(ACT.official, `/requests/${tid}/start-arranging`));
  });
});
