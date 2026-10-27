// apps/backend/src/routes/cstep.expenseCategories.test.ts
//
// Finance a+b Stage 1:
//   A0 — every settlement line gets a real category (and its own date) when
//        it is created, from its SOURCE: a Tour's arranged service / report
//        leg travel mode; a Local Travel Claim's travel mode, food, other
//        expenses; an Expense Claim line's head (picked on the form; none →
//        EXPENSE_LINE) and its tax. The backfill
//        (scripts/backfill-cstep-settlement-categories.ts) recovers the same
//        categories for older lines by tracing the source — with every
//        description scrambled to prove it never reads one — dry run first,
//        --expect-db gated.
//   B  — GET /finance-expenses: one row per traveller-paid item (+ per diem)
//        from when the case has a settlement, scoped to the Finance user's
//        travellers (Admin: all; anyone else 403), with amounts claimed / now
//        and the status; filters; CSV with a UTF-8 BOM.
//
// Real: cstep router, models, the backfill's planner/apply and its CLI (run as
//   a child process against this same throwaway database), in-memory Mongo
//   REPLICA SET on a fresh database, cstep_qc_expense_categories.
// Stubbed: mail, S3 + PDF helpers, auth (x-test-user), the workspace resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_expense_categories";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async () => ({ key: "qc" })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({})) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({})) }));

vi.setConfig({ testTimeout: 90_000 });

const { default: cstepRouter } = await import("./cstep.js");
const { planSettlementCategoryBackfill, applySettlementCategoryBackfill } = await import("../scripts/backfill-cstep-settlement-categories.js");

const DB = "cstep_qc_expense_categories";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const id$ = (id: string) => new mongoose.Types.ObjectId(id);

const WS = oid();
const QC_PROJECT = oid();
const VENDOR = oid();
const U = { traveller: oid(), other: oid(), manager: oid(), official: oid(), finance: oid(), finance2: oid(), desk: oid(), admin: oid() };
const TP = { main: oid(), other: oid() };

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

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = {
  traveller: who(U.traveller),
  other: who(U.other),
  manager: who(U.manager, ["APPROVER"]),
  official: who(U.official),
  finance: who(U.finance),
  finance2: who(U.finance2),
  desk: who(U.desk),
  admin: who(U.admin, ["ADMIN"]),
};
const send = (m: "get" | "post" | "patch", as: any, p: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${p}`).set("x-test-user", JSON.stringify(as));
  if (m === "get") return r;
  return r.send(p === "/requests" && body?.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body || {});
};
const get = (as: any, p: string) => send("get", as, p);
const post = (as: any, p: string, body?: any) => send("post", as, p, body);
const patch = (as: any, p: string, body?: any) => send("patch", as, p, body);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const linesOf = (id: string) => col("cstepsettlementlines").find({ requestId: id$(id) }).sort({ _id: 1 }).toArray();
const stage = async (as: any, name = "invoice.pdf") =>
  String(
    ok(
      await request(app)
        .post("/api/cstep/attachments/staging")
        .set("x-test-user", JSON.stringify(as))
        .field("documentType", "TAX_INVOICE")
        .attach("file", Buffer.from("%PDF-1.4 qc tax invoice"), { filename: name, contentType: "application/pdf" }),
    ).body.attachment._id,
  );

const TOUR = {
  type: "DOMESTIC", purpose: "QC categories tour", departureDate: "2026-11-02", returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }], modesRequested: ["AIR"],
  transportRequired: false, accommodationRequired: false, sponsored: false,
};
type Leg = { mode: string; fare: number; from: string; to: string; date: string };

/** A Tour with a ₹6,400 CSTEP-paid flight and self-paid legs, its report
 * approved and its settlement opened (per diem at ₹1,000) — REPORT_SUBMITTED. */
async function tourSettling(as: any, purpose: string, legs: Leg[]): Promise<string> {
  const id = String(ok(await post(as, "/requests", { ...TOUR, purpose })).body.request._id);
  ok(await post(ACT.manager, `/requests/${id}/approve`));
  const [flight] = ok(await post(ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
  ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { vendorId: String(VENDOR), amount: 6400, currency: "INR", status: "ARRANGED" }));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  ok(await post(as, `/requests/${id}/report/start`));
  for (const l of legs) {
    ok(await post(as, `/requests/${id}/report/legs`, {
      direction: "ONWARD", travelMode: l.mode, paidBy: "SELF", fare: l.fare, currency: "INR",
      fromLocation: l.from, toLocation: l.to, fromDate: l.date, toDate: l.date,
    }));
  }
  // A bill on every leg the traveller files one for; a booked (linked) flight takes its boarding pass instead (P1).
  await col("cstepreportlegs").updateMany({ requestId: id$(id), attachmentId: { $exists: false } }, { $set: { attachmentId: oid(), boardingPassAttachmentIds: [oid()] } });
  ok(await post(as, `/requests/${id}/report/submit`));
  ok(await post(ACT.manager, `/requests/${id}/report/approve`));
  ok(await post(ACT.official, `/requests/${id}/settlement/start`));
  ok(await patch(ACT.official, `/requests/${id}/settlement/perdiem`, { rate: 1000, rateReason: "QC rate" }));
  return id;
}
const finalize = async (id: string) => {
  const r = ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true }));
  expect(r.body.request.status).toBe("TRANSFERRED_TO_FINANCE");
};
const personal = async (id: string) => (await linesOf(id)).filter((l: any) => l.classification === "PERSONAL");

let replSet: MongoMemoryReplSet;
let uri = "";

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  uri = replSet.getUri(DB);
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);
  await mongoose.connection.syncIndexes();

  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("cstepvendors").insertOne({ _id: VENDOR, workspaceId: WS, vendorCode: "CSTEPVEN0001", name: "Skyline Travels", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("csteptraveldeskgrants").insertOne({ workspaceId: WS, userId: U.desk, grantedBy: U.admin, grantedAt: new Date() } as any);
  const profile = (_id: mongoose.Types.ObjectId, code: string, first: string, extra: any) => ({
    _id, workspaceId: WS, travelerId: code, firstName: first, lastName: "QC", isActive: true,
    tourApproverId: U.manager, officialUserId: U.official, ...extra,
  });
  await col("travellerprofiles").insertMany([
    profile(TP.main, "CSTEP-001", "Asha", { claimedBy: U.traveller, financeUserId: U.finance }),
    profile(TP.other, "CSTEP-002", "Ravi", { claimedBy: U.other, financeUserId: U.finance2 }),
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

/* ── A0 — categories at creation ─────────────────────────────────────── */

const ids: { tour?: string; local?: string; expense?: string } = {};
let byLine: Map<string, { category: string; itemDate?: string }> = new Map();

describe("A0 — a category on every line, from its source, when it is created", () => {
  it("Tour: the CSTEP-paid flight and each self-paid leg by travel mode, with the leg's own date", async () => {
    ids.tour = await tourSettling(ACT.traveller, "QC tour categories", [
      { mode: "CAB", fare: 500, from: "Airport", to: "Office", date: "2026-11-02" },
      { mode: "HOTEL", fare: 4200, from: "Hotel", to: "Hotel", date: "2026-11-03" },
      { mode: "TRAIN", fare: 900, from: "Delhi", to: "Agra", date: "2026-11-04" },
    ]);
    const lines = await linesOf(ids.tour);
    const got = lines.map((l: any) => [l.classification, l.mode, l.category, l.itemDate ?? null]);
    expect(got).toEqual([
      ["OFFICIAL", "FLIGHT", "FLIGHT", null],
      ["PERSONAL", "CAB", "CAB", "2026-11-02"],
      ["PERSONAL", "HOTEL", "HOTEL", "2026-11-03"],
      ["PERSONAL", "TRAIN", "TRAIN", "2026-11-04"],
    ]);
  });

  it("Local Travel Claim: travel modes (taxi → Cab, metro → Train, own vehicle its own), food, other expenses", async () => {
    ids.local = String(
      ok(
        await post(ACT.traveller, "/requests", {
          formType: "LOCAL_TRAVEL_CLAIM", purpose: "QC local categories", departureDate: "2026-10-05", returnDate: "2026-10-09",
          travelLines: [
            { date: "2026-10-05", from: "Office", to: "Client A", mode: "CAB", fare: 300, noBill: true },
            { date: "2026-10-06", from: "Client A", to: "Office", mode: "LOCAL_TAXI", fare: 250, noBill: true },
            { date: "2026-10-06", from: "Office", to: "Client B", mode: "METRO", fare: 60, noBill: true },
            { date: "2026-10-07", from: "Client B", to: "Office", mode: "BUS", fare: 40, noBill: true },
            { date: "2026-10-08", from: "Home", to: "Site", mode: "OWN_VEHICLE", fare: 420, noBill: true },
          ],
          foodLines: [{ date: "2026-10-07", amount: 350 }],
          otherExpenses: 120,
        }),
      ).body.request._id,
    );
    ok(await post(ACT.manager, `/requests/${ids.local}/approve`));
    const got = (await linesOf(ids.local)).map((l: any) => [l.category, l.itemDate ?? null, l.amountInr]);
    expect(got).toEqual([
      ["CAB", "2026-10-05", 300],
      ["CAB", "2026-10-06", 250],
      ["TRAIN", "2026-10-06", 60],
      ["BUS", "2026-10-07", 40],
      ["OWN_VEHICLE", "2026-10-08", 420],
      ["FOOD", "2026-10-07", 350],
      ["OTHER", null, 120],
    ]);
  });

  it("Expense Claim: the head picked on each line (none → EXPENSE_LINE), and the tax as TAX; an unknown head is refused", async () => {
    const invoice = await stage(ACT.traveller);
    const body = (category: any) => ({
      formType: "EXPENSE_CLAIM", purpose: "QC expense categories", departureDate: "2026-10-12", returnDate: "2026-10-16",
      expenseLines: [
        { date: "2026-10-12", description: "Guest house, two nights", amount: 3000, category: "HOTEL" },
        { date: "2026-10-13", description: "Printer cartridges", amount: 1500, category },
        { date: "2026-10-14", description: "Courier", amount: 200 },
      ],
      invoiceAttachmentIds: [invoice],
      taxAmount: 540,
    });
    const bad = await post(ACT.traveller, "/requests", body("PETTY_CASH"));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Expense line 2: pick an expense head from the list");
    const created = ok(await post(ACT.traveller, "/requests", body("STATIONERY"))).body.request;
    ids.expense = String(created._id);
    expect(created.expenseLines.map((l: any) => l.category ?? null)).toEqual(["HOTEL", "STATIONERY", null]);
    ok(await post(ACT.manager, `/requests/${ids.expense}/approve`));
    const got = (await linesOf(ids.expense)).map((l: any) => [l.category, l.itemDate ?? null, l.amountInr]);
    expect(got).toEqual([
      ["HOTEL", "2026-10-12", 3000],
      ["STATIONERY", "2026-10-13", 1500],
      ["EXPENSE_LINE", "2026-10-14", 200],
      ["TAX", null, 540],
    ]);
    // What every line got at creation — the backfill must reproduce exactly this.
    for (const id of [ids.tour!, ids.local!, ids.expense!]) {
      for (const l of await linesOf(id)) byLine.set(String(l._id), { category: l.category, itemDate: l.itemDate });
    }
    expect(byLine.size).toBe(15);
  });
});

/* ── A0 — the backfill ────────────────────────────────────────────────── */

describe("A0 — backfill: recovers the categories by tracing sources, never descriptions", () => {
  const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/backfill-cstep-settlement-categories.ts");
  const runCli = (args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      env: { ...process.env, MONGO_URI: uri },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  let dryRunOutput = "";

  it("turns the lines back into legacy ones: no category, no date, every description scrambled", async () => {
    const r = await col("cstepsettlementlines").updateMany(
      { requestId: { $in: [ids.tour, ids.local, ids.expense].map((i) => id$(i!)) } },
      { $unset: { category: 1, itemDate: 1 }, $set: { description: "zz scrambled zz" } },
    );
    expect(r.modifiedCount).toBe(15);
  });

  it("the planner recovers every category and date exactly as creation set them", async () => {
    const plan = await planSettlementCategoryBackfill(mongoose.connection.db!, WS);
    expect(plan.unresolved).toEqual([]);
    expect(plan.changes).toHaveLength(15);
    for (const c of plan.changes) {
      const want = byLine.get(c.lineId)!;
      expect([c.lineId, c.category, c.itemDate ?? null]).toEqual([c.lineId, want.category, want.itemDate ?? null]);
    }
    expect([...new Set(plan.changes.map((c) => c.via))].sort()).toEqual([
      "arrangement", "claim expense line", "claim food line", "claim other expenses", "claim tax", "claim travel line", "report leg",
    ]);
  });

  it("CLI: refuses the wrong --expect-db; the dry run prints the plan and writes nothing", async () => {
    let refused = "";
    try {
      runCli(["--expect-db=plumbox_dev"]);
    } catch (e: any) {
      refused = String(e.stderr || e.message);
    }
    expect(refused).toContain(`connected database is "${DB}", --expect-db is "plumbox_dev"`);

    dryRunOutput = runCli([`--expect-db=${DB}`, `--workspaceId=${WS}`]);
    console.log(`\n── backfill dry run ──\n${dryRunOutput}`);
    expect(dryRunOutput).toContain("lines to set=15 (with a date 12) unresolved=0");
    expect(dryRunOutput).toContain("DRY RUN — nothing written.");
    expect(await col("cstepsettlementlines").countDocuments({ category: { $exists: true } })).toBe(0);
  });

  it("CLI: --apply needs the dry run's plan id", async () => {
    let refused = "";
    try {
      runCli([`--expect-db=${DB}`, `--workspaceId=${WS}`, "--apply", "--confirm=000000000000"]);
    } catch (e: any) {
      refused = String(e.stderr || e.message);
    }
    expect(refused).toContain("--confirm does not match plan id");
    expect(await col("cstepsettlementlines").countDocuments({ category: { $exists: true } })).toBe(0);
  });

  it("a source that is gone falls back to the line's own mode; a claim line that points nowhere is UNRESOLVED, never written", async () => {
    const legLine = (await linesOf(ids.tour!)).find((l: any) => l.source === "REPORT_LEG" && l.mode === "TRAIN")!;
    const leg = await col("cstepreportlegs").findOne({ _id: legLine.sourceId });
    await col("cstepreportlegs").deleteOne({ _id: legLine.sourceId });
    const stray = oid();
    await col("cstepsettlementlines").insertOne({
      ...(await linesOf(ids.local!))[0], _id: stray, sourceId: oid(),
    } as any);
    try {
      const plan = await planSettlementCategoryBackfill(mongoose.connection.db!, WS);
      expect(plan.changes.find((c) => c.lineId === String(legLine._id))).toMatchObject({ category: "TRAIN", via: "report leg gone — the line's own mode" });
      expect(plan.unresolved).toEqual([expect.stringMatching(new RegExp(`^${stray}: source .* is not a line of claim ${ids.local}$`))]);
      expect(plan.changes.find((c) => c.lineId === String(stray))).toBeUndefined();
    } finally {
      await col("cstepreportlegs").insertOne(leg as any);
      await col("cstepsettlementlines").deleteOne({ _id: stray });
    }
  });

  it("apply sets exactly the plan; a second plan finds nothing left", async () => {
    const plan = await planSettlementCategoryBackfill(mongoose.connection.db!, WS);
    expect(await applySettlementCategoryBackfill(mongoose.connection.db!, plan.changes)).toBe(15);
    for (const id of [ids.tour!, ids.local!, ids.expense!]) {
      for (const l of await linesOf(id)) {
        const want = byLine.get(String(l._id))!;
        expect([l.category, l.itemDate ?? null]).toEqual([want.category, want.itemDate ?? null]);
      }
    }
    expect((await planSettlementCategoryBackfill(mongoose.connection.db!, WS)).changes).toHaveLength(0);
  });
});

/* ── B — the Traveller-paid expenses view ─────────────────────────────── */

describe("B — GET /finance-expenses", () => {
  const cases: Record<string, string> = {};
  const rows = async (as: any, q = "") => ok(await get(as, `/finance-expenses${q}`)).body;
  // One case's items, by date then description (the route sorts newest first across cases).
  const ofCase = (items: any[], id: string) =>
    items.filter((i) => i.requestId === id).sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));

  it("sets up cases at every stage", async () => {
    // settling: one line Desk-verified, one not
    cases.settling = await tourSettling(ACT.traveller, "QC view settling", [
      { mode: "CAB", fare: 700, from: "Airport", to: "Office", date: "2026-11-02" },
      { mode: "HOTEL", fare: 3000, from: "Hotel", to: "Hotel", date: "2026-11-03" },
    ]);
    const [cab] = await personal(cases.settling);
    ok(await patch(ACT.official, `/requests/${cases.settling}/settlement/lines/${cab._id}`, { verified: true }));
    // with Finance: one line reduced, one disallowed
    cases.withFinance = await tourSettling(ACT.traveller, "QC view with finance", [
      { mode: "CAB", fare: 1200, from: "Office", to: "Client", date: "2026-11-02" },
      { mode: "CAB", fare: 800, from: "Client", to: "Mall", date: "2026-11-03" },
    ]);
    await finalize(cases.withFinance);
    const [a, b] = await personal(cases.withFinance);
    ok(await patch(ACT.finance, `/requests/${cases.withFinance}/finance/lines/${a._id}`, { amountInr: 900, amountReason: "Receipt ₹900" }));
    ok(await post(ACT.finance, `/requests/${cases.withFinance}/finance/lines/${b._id}/reject`, { reason: "Personal detour" }));
    // reimbursed
    cases.reimbursed = await tourSettling(ACT.traveller, "QC view reimbursed", [{ mode: "BUS", fare: 450, from: "A", to: "B", date: "2026-11-02" }]);
    await finalize(cases.reimbursed);
    ok(await post(ACT.finance, `/requests/${cases.reimbursed}/finance/settle`, { reference: "UTR-77" }));
    // everything rejected → SETTLED ₹0
    cases.rejected = await tourSettling(ACT.traveller, "QC view rejected", [{ mode: "CAB", fare: 610, from: "A", to: "B", date: "2026-11-02" }]);
    await finalize(cases.rejected);
    ok(await post(ACT.finance, `/requests/${cases.rejected}/finance/reject-all`, { reason: "No pre-approval" }));
    // another Finance user's traveller
    cases.otherFinance = await tourSettling(ACT.other, "QC view other finance", [{ mode: "CAB", fare: 333, from: "A", to: "B", date: "2026-11-02" }]);
    // report approved but the Desk has not opened the settlement → no items yet
    const id = String(ok(await post(ACT.traveller, "/requests", { ...TOUR, purpose: "QC view no settlement" })).body.request._id);
    ok(await post(ACT.manager, `/requests/${id}/approve`));
    ok(await post(ACT.official, `/requests/${id}/start-arranging`));
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
    ok(await post(ACT.traveller, `/requests/${id}/report/start`));
    ok(await post(ACT.traveller, `/requests/${id}/report/legs`, { direction: "ONWARD", travelMode: "CAB", paidBy: "SELF", fare: 99, currency: "INR", fromLocation: "A", toLocation: "B", fromDate: "2026-11-02", toDate: "2026-11-02" }));
    await col("cstepreportlegs").updateMany({ requestId: id$(id) }, { $set: { attachmentId: oid(), boardingPassAttachmentIds: [oid()] } });
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    ok(await post(ACT.manager, `/requests/${id}/report/approve`));
    cases.noSettlement = id;
  });

  it("Finance sees only their travellers' traveller-paid items — no company-paid lines, nothing before a settlement", async () => {
    const { items } = await rows(ACT.finance);
    expect(items.some((i: any) => i.requestId === cases.otherFinance)).toBe(false);
    expect(items.some((i: any) => i.requestId === cases.noSettlement)).toBe(false);
    expect(items.some((i: any) => i.category === "FLIGHT")).toBe(false); // the CSTEP-paid flights
    const mine2 = (await rows(ACT.finance2)).items;
    expect([...new Set(mine2.map((i: any) => i.requestId))]).toEqual([cases.otherFinance]);
    const all = (await rows(ACT.admin)).items;
    expect(all.some((i: any) => i.requestId === cases.otherFinance)).toBe(true);
    expect(all.length).toBe(items.length + mine2.length);
  });

  it("nobody else: Desk, Official, Manager, traveller → 403", async () => {
    for (const as of [ACT.desk, ACT.official, ACT.manager, ACT.traveller]) {
      const r = await get(as, "/finance-expenses");
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("Traveller-paid expenses are open to CSTEP Admin and Finance users");
    }
  });

  it("settling: Desk-verified / in verification per line; the per diem (gross → net) is in verification", async () => {
    const { items } = await rows(ACT.finance);
    const it = ofCase(items, cases.settling);
    expect(it.map((i: any) => [i.category, i.date, i.description, i.amountClaimedInr, i.amountNowInr, i.status])).toEqual([
      ["CAB", "2026-11-02", "Airport → Office", 700, 700, "DESK_VERIFIED"],
      ["PER_DIEM", "2026-11-02", "Per diem — 3 days × ₹1,000", 3000, 3000, "IN_VERIFICATION"],
      ["HOTEL", "2026-11-03", "Hotel → Hotel", 3000, 3000, "IN_VERIFICATION"],
    ]);
    expect(it[0]).toMatchObject({ traveller: "Asha QC", formType: "TOUR_PROPOSAL", reference: expect.stringMatching(/\d{4}\/\d{4}/) });
  });

  it("with Finance: the reduced line shows claimed vs now, the disallowed one ₹0 with the reason", async () => {
    const it = ofCase((await rows(ACT.finance)).items, cases.withFinance);
    expect(it.map((i: any) => [i.description, i.amountClaimedInr, i.amountNowInr, i.status, i.reason ?? null])).toEqual([
      ["Office → Client", 1200, 900, "WITH_FINANCE", null],
      ["Per diem — 3 days × ₹1,000", 3000, 3000, "WITH_FINANCE", null],
      ["Client → Mall", 800, 0, "DISALLOWED", "Personal detour"],
    ]);
  });

  it("reimbursed: with the payment date and reference; everything rejected: disallowed, per diem too", async () => {
    const items = (await rows(ACT.finance)).items;
    const paid = ofCase(items, cases.reimbursed);
    expect(paid.map((i: any) => i.status)).toEqual(["REIMBURSED", "REIMBURSED"]);
    expect(paid[0]).toMatchObject({ paymentRef: "UTR-77", paidOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    const rej = ofCase(items, cases.rejected);
    expect(rej.map((i: any) => [i.category, i.amountNowInr, i.status, i.reason])).toEqual([
      ["CAB", 0, "DISALLOWED", "No pre-approval"],
      ["PER_DIEM", 0, "DISALLOWED", "Disallowed by Finance — No pre-approval"],
    ]);
  });

  it("claims: the approved Local Travel and Expense claims, with their categories", async () => {
    const items = (await rows(ACT.finance)).items;
    expect(ofCase(items, ids.local!).map((i: any) => i.category).sort()).toEqual(["BUS", "CAB", "CAB", "FOOD", "OTHER", "OWN_VEHICLE", "TRAIN"]);
    expect(ofCase(items, ids.expense!).map((i: any) => [i.category, i.amountNowInr, i.status])).toEqual(
      expect.arrayContaining([["HOTEL", 3000, "IN_VERIFICATION"], ["STATIONERY", 1500, "IN_VERIFICATION"], ["TAX", 540, "IN_VERIFICATION"]]),
    );
    // A claim has no per diem.
    expect(ofCase(items, ids.local!).some((i: any) => i.category === "PER_DIEM")).toBe(false);
  });

  it("filters: status, traveller, date range; the traveller list comes from everything in scope", async () => {
    const r = await rows(ACT.finance, "?status=REIMBURSED");
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i: any) => i.status === "REIMBURSED")).toBe(true);
    const admin = await rows(ACT.admin, `?traveller=${TP.other}`);
    expect([...new Set(admin.items.map((i: any) => i.traveller))]).toEqual(["Ravi QC"]);
    expect(admin.travellers.map((t: any) => t.name)).toEqual(["Asha QC", "Ravi QC"]);
    const oct = await rows(ACT.finance, "?from=2026-10-01&to=2026-10-31");
    expect(oct.items.length).toBeGreaterThan(0);
    expect(oct.items.every((i: any) => i.date >= "2026-10-01" && i.date <= "2026-10-31")).toBe(true);
    expect((await get(ACT.finance, "/finance-expenses?status=PAID")).status).toBe(400);
    expect((await get(ACT.finance, "/finance-expenses?from=2026-13-45")).status).toBe(400);
  });

  it("CSV: UTF-8 with a BOM, the same filtered rows, — and → intact", async () => {
    const r = await get(ACT.finance, "/finance-expenses?format=csv&status=DISALLOWED").buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="cstep-traveller-paid-expenses-\d{4}-\d{2}-\d{2}\.csv"$/);
    const buf: Buffer = r.body;
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buf.subarray(3).toString("utf8");
    const [header, ...data] = text.trim().split("\n");
    expect(header).toBe("Reference,Traveller,Event,Date,Category,Description,Amount claimed (INR),Amount now (INR),Status,Paid on,Payment ref,Reason");
    expect(data.length).toBe((await rows(ACT.finance, "?status=DISALLOWED")).items.length);
    expect(text).toContain("Client → Mall");
    expect(text).toContain("Disallowed by Finance — No pre-approval");
    expect(text).not.toMatch(/â€|Ã/);
  });
});
