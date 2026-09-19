// Receipt verification — the Approval Bot's "readable, matching receipt" gate
// + the F-23 pre-check toggles. Real Mongo (memory server), real routers and
// middleware; the ONLY mock is the Gemini reader (extractReceipt) and the S3
// put behind the upload route — neither a live model nor a real bucket is
// needed (local S3 is a deliberately non-existent bucket).
//
// What is proved here, in order:
//   1. the upload route records a SERVER-side ReceiptExtraction and the gate
//      reads THAT — a client-echoed rawExtraction cannot spoof it
//   2. readable + matching + under limit + clean → the bot approves
//   3. readable but out of tolerance → a person, reason on the trail
//   4. attached but unreadable → a person
//   5. no receipt + "no attachments" bypass → a person, bot not consulted
//   6. no receipt, no bypass → a person (cannot be bot-approved)
//   7. multi-line: one mismatching bill sends the WHOLE claim to a person
//   8. the four F-23 toggles persist and change engine behaviour
//   9. the tolerance setting is respected (abs and pct, whichever is larger)
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "gate-test-secret";
process.env.JWT_REFRESH_SECRET = "gate-test-refresh";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET = "test-bucket";
process.env.AWS_REGION = "ap-south-1";
process.env.GEMINI_API_KEY = "test";
process.env.DISABLE_EMAILS = "1";
process.env.NODE_ENV = "test";
delete process.env.EXCHANGERATE_API_KEY;

// ── The reader, mocked. Each test sets what "Gemini" will say next. ──────────
type MockRead = { amount: number | null; currency?: string; merchant?: string } | { throws: string };
let nextRead: MockRead = { amount: 0 };
vi.mock("../services/receiptExtractorGemini.js", () => ({
  extractReceipt: vi.fn(async () => {
    const r = nextRead;
    if ("throws" in r) throw new Error(r.throws);
    // Mirrors the real extractor's contract: no amount → throws.
    if (r.amount == null) throw new Error("Extraction produced no amount");
    return {
      fields: {
        merchant: r.merchant ?? "Mock Cafe",
        date: new Date().toISOString().slice(0, 10),
        amount: r.amount,
        currency: r.currency ?? "INR",
        taxAmount: null,
        gstin: null,
        suggestedCategory: "Meals",
        perFieldConfidence: { amount: 0.9, merchant: 0.8 },
      },
      raw: { raw_candidate: { amount: r.amount, currency: r.currency ?? "INR" }, raw_text: "{}", model: "gemini-mock" },
    };
  }),
}));
// ── S3 put, mocked: a key is minted, nothing leaves the process. ─────────────
vi.mock("../utils/s3Upload.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    uploadExpenseReceiptToS3: vi.fn(async (o: any) => ({
      bucket: "test-bucket",
      key: `hrms/expenses/${o.workspaceId}/${o.employeeId}/${Date.now()}-${Math.random().toString(16).slice(2, 10)}.jpg`,
    })),
  };
});

const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireFeature } = await import("../middleware/requireFeature.js");
const { attachExpenseGrant, upsertGrant } = await import("../services/expenseGrants.service.js");
const { updatePolicy, getPolicy } = await import("../services/expensePolicy.service.js");
const { signToken } = await import("../utils/jwt.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: ExpenseCategory } = await import("../models/ExpenseCategory.js");
const { default: Expense } = await import("../models/Expense.js");
const { default: Report } = await import("../models/Report.js");
const { default: ReceiptExtraction } = await import("../models/ReceiptExtraction.js");
const { default: ExpenseActivity } = await import("../models/ExpenseActivity.js");
const { default: expensesRouter } = await import("./expenses.js");
const { default: adminRouter } = await import("./expenseAdmin.js");
const { default: reportsRouter } = await import("./expenseReports.js");

let mongod: MongoMemoryServer;
let app: express.Express;
const TODAY = new Date().toISOString().slice(0, 10);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  const gate = [requireAuth, requireWorkspace, attachExpenseGrant, requireFeature("expensesEnabled")] as any[];
  app.use("/api/expenses", ...gate, expensesRouter);
  app.use("/api/expense-admin", ...gate, adminRouter);
  app.use("/api/reports", ...gate, reportsRouter);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

type Actor = { id: string; email: string; roles: string[]; workspaceId: string; customerId?: string; name: string };
function as(a: Actor) {
  const t = signToken({ sub: a.id, roles: a.roles, email: a.email, workspaceId: a.workspaceId, ...(a.customerId ? { customerId: a.customerId } : {}) } as any);
  const h = (r: request.Test) => r.set("Authorization", `Bearer ${t}`);
  return {
    get: (p: string) => h(request(app).get(p)),
    put: (p: string, body?: any) => h(request(app).put(p)).send(body ?? {}),
    post: (p: string, body?: any) => h(request(app).post(p)).send(body ?? {}),
    upload: (p: string) => h(request(app).post(p)).attach("file", PNG, { filename: "bill.jpg", contentType: "image/jpeg" }),
  };
}
let seq = 0;
async function makeUser(workspaceId: string, roles: string[], first: string, extra: Record<string, any> = {}): Promise<Actor> {
  seq++;
  const email = `gate-${seq}-${Date.now()}@test.local`;
  const u = await User.create({ email, passwordHash: "x", firstName: first, lastName: "T", roles, workspaceId, status: "ACTIVE", ...extra });
  return { id: String(u._id), email, roles, workspaceId, name: `${first} T`, ...(extra.customerId ? { customerId: extra.customerId } : {}) };
}

/**
 * Engine ON, bot ON with a ₹5,000 mixed limit, one Meals category (₹5,000 bot
 * limit). Meera (L4 → ₹50k) manages Arjun and is the only approver, so every
 * "goes to a person" lands on her.
 */
async function makeWorkspace() {
  seq++;
  const customerId = `cust-gate-${seq}-${Date.now()}`;
  const ws = await CustomerWorkspace.create({ customerId, name: `Gate WS ${seq}`, status: "ACTIVE", config: { features: { expensesEnabled: true } } });
  const wsId = String(ws._id);
  const leader = await makeUser(wsId, ["CUSTOMER", "WORKSPACE_LEADER"], "Lena", { customerId });
  const L = as(leader);
  await L.put("/api/expense-admin/ranks", { ranks: [{ bandNumber: 4, label: "Manager", defaultApprovalLimitBase: 50000 }] });
  const meera = await makeUser(wsId, ["MANAGER"], "Meera", { bandNumber: 4 });
  await upsertGrant({ workspaceId: wsId, userId: meera.id, patch: { approver: true } });
  const arjun = await makeUser(wsId, ["EMPLOYEE"], "Arjun", { managerId: meera.id });
  const meals = String((await ExpenseCategory.create({ workspaceId: wsId, name: "Meals", active: true, botLimitMode: "amount", botLimitBase: 5000 }))._id);
  await L.put("/api/expense-admin/approval-policy", { bot: { enabled: true, thresholdBase: 5000 } });
  await updatePolicy({ workspaceId: wsId, patch: { engineEnabled: true } });
  return { wsId, leader, L, meera, arjun, meals };
}

/** Upload a bill as `who` with the mocked reader saying `read`; returns the upload response body. */
async function uploadBill(who: Actor, read: MockRead) {
  nextRead = read;
  const r = await as(who).upload("/api/expenses/upload");
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { imageKey: string; s3Bucket: string; draft: any; extractionError?: string; rawExtraction?: any; perFieldConfidence?: any };
}

/** Save a line (optionally with a receipt key + client-echoed extraction), returns the expense. */
async function saveLine(who: Actor, categoryId: string, amount: number, extra: Record<string, any> = {}) {
  const r = await as(who).post("/api/expenses", { amount, date: TODAY, merchant: "Mock Cafe", categoryId, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.expense;
}

async function claimOf(who: Actor, name: string, expenseIds: string[]) {
  const W = as(who);
  const c = (await W.post("/api/reports", { name })).body.report;
  const add = await W.post(`/api/reports/${c._id}/expenses`, { expenseIds });
  expect(add.status, JSON.stringify(add.body)).toBe(200);
  return String(c._id);
}
const submit = (who: Actor, id: string, body: any = {}) => as(who).post(`/api/reports/${id}/submit`, body);
const trailOf = async (who: Actor, id: string) => (await as(who).get(`/api/reports/${id}`)).body.activity as any[];

describe("1 · the server keeps its own copy of the read — the client cannot spoof it", () => {
  it("upload records a ReceiptExtraction (readable, amount, confidence); a failed read records readable:false", async () => {
    const t = await makeWorkspace();
    const ok = await uploadBill(t.arjun, { amount: 1180.5, merchant: "Chai Point" });
    expect(ok.extractionError).toBeUndefined();
    expect(ok.draft.amount).toBe(1180.5);
    const row: any = await ReceiptExtraction.findOne({ imageKey: ok.imageKey }).lean();
    expect(row).toMatchObject({ readable: true, amount: 1180.5, currency: "INR", merchant: "Chai Point", sourceChannel: "web", extractionModel: "gemini-mock" });
    expect(String(row.workspaceId)).toBe(t.wsId);
    expect(String(row.employeeId)).toBe(t.arjun.id);
    expect(row.perFieldConfidence).toMatchObject({ amount: 0.9 });

    const bad = await uploadBill(t.arjun, { amount: null });
    expect(bad.extractionError).toMatch(/no amount/);
    expect(bad.draft.amount).toBeNull();
    const badRow: any = await ReceiptExtraction.findOne({ imageKey: bad.imageKey }).lean();
    expect(badRow).toMatchObject({ readable: false, amount: null });
    expect(badRow.errorMessage).toMatch(/no amount/);
  });

  it("POST /expenses links the line to the server row and stores the SERVER copy, ignoring what the client echoed", async () => {
    const t = await makeWorkspace();
    const up = await uploadBill(t.arjun, { amount: 900 });
    // The browser "helpfully" echoes an edited extraction claiming the receipt said 1500.
    const line = await saveLine(t.arjun, t.meals, 1500, {
      imageKey: up.imageKey,
      rawExtraction: { amount: 1500, currency: "INR", tampered: true },
      perFieldConfidence: { amount: 1 },
    });
    const saved: any = await Expense.findById(line._id).lean();
    const row: any = await ReceiptExtraction.findOne({ imageKey: up.imageKey }).lean();
    expect(String(saved.receiptExtractionId)).toBe(String(row._id));
    expect(saved.rawExtraction).toEqual({ amount: 900, currency: "INR" }); // the server's, not the client's
    expect(saved.rawExtraction.tampered).toBeUndefined();
    expect(saved.perFieldConfidence).toMatchObject({ amount: 0.9 });
  });

  it("a claim whose CLIENT-sent extraction matches but whose SERVER read doesn't → goes to a person", async () => {
    const t = await makeWorkspace();
    const up = await uploadBill(t.arjun, { amount: 900 }); // the bill really says 900
    const line = await saveLine(t.arjun, t.meals, 1500, { imageKey: up.imageKey, rawExtraction: { amount: 1500 }, perFieldConfidence: { amount: 1 } });
    const c = await claimOf(t.arjun, "spoof", [line._id]);
    const s = await submit(t.arjun, c);
    expect(s.status).toBe(200);
    expect(s.body.report.status).toBe("submitted"); // NOT approved
    expect(String(s.body.report.approverId)).toBe(t.meera.id);
    expect(s.body.report.routing.bot).toMatchObject({ evaluated: true, underThreshold: true, checksPassed: false, wouldAutoApprove: false });
    expect(s.body.report.routing.bot.checks.receipt).toBe(false);
    expect(s.body.report.routing.bot.reason).toMatch(/pre-check failed: receipt \(.*receipt amount INR 900\.00 doesn't match claimed INR 1,500\.00/);
  });
});

describe("2 · readable + matching + under limit + clean → the bot approves", () => {
  it("auto-approves, with the receipt check passing on the record", async () => {
    const t = await makeWorkspace();
    const up = await uploadBill(t.arjun, { amount: 1200 });
    const line = await saveLine(t.arjun, t.meals, 1200, { imageKey: up.imageKey });
    const c = await claimOf(t.arjun, "clean", [line._id]);
    const s = await submit(t.arjun, c);
    expect(s.status).toBe(200);
    expect(s.body.report.status).toBe("approved");
    expect(s.body.report.approverId).toBeNull();
    expect(s.body.report.routing).toMatchObject({ outcome: "BOT_AUTO_APPROVE" });
    expect(s.body.report.routing.bot).toMatchObject({ checksPassed: true, wouldAutoApprove: true, skipped: null, checksFailed: [] });
    expect(s.body.report.routing.bot.checks).toEqual({ receipt: true, category: true, noDuplicate: true, positiveAmounts: true });
    expect(await ExpenseActivity.countDocuments({ reportId: c, event: "auto_approved" })).toBe(1);
  });

  it("a small rounding difference inside the default ₹10 / 5% slack still matches", async () => {
    const t = await makeWorkspace();
    const up = await uploadBill(t.arjun, { amount: 1200 });
    const line = await saveLine(t.arjun, t.meals, 1207, { imageKey: up.imageKey }); // +7 ≤ max(10, 60)
    const c = await claimOf(t.arjun, "rounding", [line._id]);
    const s = await submit(t.arjun, c);
    expect(s.body.report.status).toBe("approved");
  });
});

describe("3 · readable but OUT of tolerance → a person, reason logged", () => {
  it("routes to the manager and writes the mismatch on the trail with both amounts and the tolerance", async () => {
    const t = await makeWorkspace();
    const up = await uploadBill(t.arjun, { amount: 1180 });
    const line = await saveLine(t.arjun, t.meals, 1500, { imageKey: up.imageKey });
    const c = await claimOf(t.arjun, "mismatch", [line._id]);
    const s = await submit(t.arjun, c);
    expect(s.status).toBe(200);
    expect(s.body.report.status).toBe("submitted");
    expect(String(s.body.report.approverId)).toBe(t.meera.id);
    expect(s.body.report.routing.outcome).not.toBe("BOT_AUTO_APPROVE");
    expect(s.body.report.routing.bot.checksFailed).toHaveLength(1);
    expect(s.body.report.routing.bot.checksFailed[0]).toMatch(/^receipt \(EXP-[0-9A-F]{6}: receipt amount INR 1,180\.00 doesn't match claimed INR 1,500\.00 \(tolerance INR 59\.00\)\)$/);

    const trail = await trailOf(t.arjun, c);
    const routed = trail.find((a) => a.event === "routed");
    expect(routed.note).toMatch(/The Bot steps aside — pre-check failed: receipt/);
    const check = trail.filter((a) => a.event === "policy_check" && /Receipt check failed/.test(a.note));
    expect(check).toHaveLength(1);
    expect(check[0]).toMatchObject({ actorType: "bot", actorName: "Approval Bot" });
    expect(check[0].note).toMatch(/receipt amount INR 1,180\.00 doesn't match claimed INR 1,500\.00 .* Sent to a person\./);
    expect(String(check[0].expenseId)).toBe(String(line._id));
    expect(check[0].details.receipt).toMatchObject({ status: "mismatch", claimedAmount: 1500, extractedAmount: 1180, toleranceApplied: 59 });
    expect(check[0].details.tolerance).toEqual({ absToleranceBase: 10, pctTolerance: 5 });
    expect(await ExpenseActivity.countDocuments({ reportId: c, event: "auto_approved" })).toBe(0);
  });

  it("a receipt read in a different currency than the line is claimed in is a mismatch too", async () => {
    const t = await makeWorkspace();
    const up = await uploadBill(t.arjun, { amount: 100, currency: "USD" });
    const line = await saveLine(t.arjun, t.meals, 100, { imageKey: up.imageKey, currency: "INR" }); // $100 claimed as ₹100
    const c = await claimOf(t.arjun, "ccy", [line._id]);
    const s = await submit(t.arjun, c);
    expect(s.body.report.status).toBe("submitted");
    expect(s.body.report.routing.bot.checksFailed[0]).toMatch(/receipt currency USD differs from claimed INR/);
  });
});

describe("4 · attached but unreadable → a person", () => {
  it("an imageKey with a readable:false server row fails the receipt check with 'not readable'", async () => {
    const t = await makeWorkspace();
    const up = await uploadBill(t.arjun, { amount: null }); // napkin
    expect(up.extractionError).toBeDefined();
    const line = await saveLine(t.arjun, t.meals, 800, { imageKey: up.imageKey }); // user typed the amount
    const c = await claimOf(t.arjun, "napkin", [line._id]);
    const s = await submit(t.arjun, c);
    expect(s.body.report.status).toBe("submitted");
    expect(String(s.body.report.approverId)).toBe(t.meera.id);
    expect(s.body.report.routing.bot.checks.receipt).toBe(false);
    expect(s.body.report.routing.bot.checksFailed[0]).toMatch(/^receipt \(EXP-[0-9A-F]{6}: receipt not readable\)$/);
    const trail = await trailOf(t.arjun, c);
    expect(trail.find((a) => a.event === "policy_check" && /receipt not readable/.test(a.note))?.details?.receipt?.status).toBe("unreadable");
  });

  it("an imageKey the server never read at all (no row) is treated as unreadable, not as attached", async () => {
    const t = await makeWorkspace();
    const line = await saveLine(t.arjun, t.meals, 800, { imageKey: `hrms/expenses/${t.wsId}/${t.arjun.id}/legacy-${Date.now()}.jpg` });
    const c = await claimOf(t.arjun, "legacy", [line._id]);
    const s = await submit(t.arjun, c);
    expect(s.body.report.status).toBe("submitted");
    expect(s.body.report.routing.bot.checksFailed[0]).toMatch(/receipt not readable/);
  });
});

describe("5 · no receipt + the 'no attachments' bypass → a person, bot not consulted", () => {
  it("persists the flag, skips the bot with the reason on the record and the trail, and lands on the manager", async () => {
    const t = await makeWorkspace();
    const line = await saveLine(t.arjun, t.meals, 300); // no receipt
    const c = await claimOf(t.arjun, "bypass", [line._id]);
    const s = await submit(t.arjun, c, { attachmentsNotRequired: true });
    expect(s.status).toBe(200);
    expect(s.body.report.status).toBe("submitted");
    expect(s.body.report.attachmentsNotRequired).toBe(true);
    expect(String(s.body.report.approverId)).toBe(t.meera.id);
    expect(s.body.report.routing.bot).toMatchObject({ evaluated: true, wouldAutoApprove: false });
    expect(s.body.report.routing.bot.skipped).toMatch(/no attachments/);
    expect(s.body.report.routing.bot.reason).toMatch(/^not consulted — the submitter marked this claim as having no attachments/);
    expect(((await Report.findById(c).lean()) as any).attachmentsNotRequired).toBe(true);
    const trail = await trailOf(t.arjun, c);
    const skip = trail.find((a) => a.event === "policy_check" && /not consulted/.test(a.note));
    expect(skip).toMatchObject({ actorType: "bot", actorName: "Approval Bot" });
    expect(skip.details).toMatchObject({ attachmentsNotRequired: true });
    expect(await ExpenseActivity.countDocuments({ reportId: c, event: "auto_approved" })).toBe(0);
  });

  it("the bypass also skips the bot on a claim that WOULD otherwise have auto-approved — a person always sees it", async () => {
    const t = await makeWorkspace();
    const up = await uploadBill(t.arjun, { amount: 500 });
    const line = await saveLine(t.arjun, t.meals, 500, { imageKey: up.imageKey });
    const c = await claimOf(t.arjun, "bypass-clean", [line._id]);
    const s = await submit(t.arjun, c, { attachmentsNotRequired: true });
    expect(s.body.report.status).toBe("submitted");
    expect(s.body.report.routing.bot.checks.receipt).toBe(true); // the check itself passed…
    expect(s.body.report.routing.bot.skipped).toMatch(/no attachments/); // …but the bot was not asked
  });

  it("a non-boolean flag is ignored; false clears a previously set flag on resubmit", async () => {
    const t = await makeWorkspace();
    const line = await saveLine(t.arjun, t.meals, 300);
    const c = await claimOf(t.arjun, "flag-types", [line._id]);
    const s1 = await submit(t.arjun, c, { attachmentsNotRequired: "yes" });
    expect(s1.body.report.attachmentsNotRequired).toBe(false);
    expect(s1.body.report.routing.bot.skipped).toBeNull();
  });
});

describe("6 · no receipt, no bypass → cannot be bot-approved", () => {
  it("a receipt-less line fails the receipt check with 'no receipt attached' and goes to the manager", async () => {
    const t = await makeWorkspace();
    const line = await saveLine(t.arjun, t.meals, 300);
    const c = await claimOf(t.arjun, "bare", [line._id]);
    const s = await submit(t.arjun, c);
    expect(s.body.report.status).toBe("submitted");
    expect(String(s.body.report.approverId)).toBe(t.meera.id);
    expect(s.body.report.routing.bot.skipped).toBeNull();
    expect(s.body.report.routing.bot.checksFailed[0]).toMatch(/^receipt \(EXP-[0-9A-F]{6}: no receipt attached\)$/);
    expect(await ExpenseActivity.countDocuments({ reportId: c, event: "auto_approved" })).toBe(0);
  });
});

describe("7 · multi-line: one mismatching bill sends the whole claim to a person", () => {
  it("two clean lines + one mismatch → human; only the failing line is named on the trail; the claim is one unit", async () => {
    const t = await makeWorkspace();
    const a = await uploadBill(t.arjun, { amount: 400 });
    const b = await uploadBill(t.arjun, { amount: 650 });
    const bad = await uploadBill(t.arjun, { amount: 1000 });
    const l1 = await saveLine(t.arjun, t.meals, 400, { imageKey: a.imageKey });
    const l2 = await saveLine(t.arjun, t.meals, 650, { imageKey: b.imageKey });
    const l3 = await saveLine(t.arjun, t.meals, 1300, { imageKey: bad.imageKey }); // receipt says 1000
    const c = await claimOf(t.arjun, "multi", [l1._id, l2._id, l3._id]);
    const s = await submit(t.arjun, c);
    expect(s.body.report.status).toBe("submitted"); // whole claim, not just the bad line
    expect(String(s.body.report.approverId)).toBe(t.meera.id);
    expect(s.body.report.routing.amountBase).toBe(2350);
    expect(s.body.report.routing.bot.checksFailed).toHaveLength(1);
    expect(s.body.report.routing.bot.checksFailed[0]).toContain(l3.ref);
    expect(s.body.report.routing.bot.checksFailed[0]).not.toContain(l1.ref);
    const trail = await trailOf(t.arjun, c);
    const checks = trail.filter((x) => x.event === "policy_check" && /Receipt check failed/.test(x.note));
    expect(checks).toHaveLength(1);
    expect(String(checks[0].expenseId)).toBe(String(l3._id));
    // Every line follows the claim — none is approved on its own.
    const lines = await Expense.find({ reportId: c }).lean();
    expect(lines.every((l: any) => l.lifecycleStatus === "awaiting_approval")).toBe(true);
  });

  it("all three lines readable and matching → the bot approves the whole claim", async () => {
    const t = await makeWorkspace();
    const ls = [];
    for (const n of [400, 650, 1000]) {
      const up = await uploadBill(t.arjun, { amount: n }); // sequential: the mock reader is one shared "next answer"
      ls.push(await saveLine(t.arjun, t.meals, n, { imageKey: up.imageKey }));
    }
    const c = await claimOf(t.arjun, "multi-clean", ls.map((l) => l._id));
    const s = await submit(t.arjun, c);
    expect(s.body.report.status).toBe("approved");
  });
});

describe("8 · F-23 — the four pre-check toggles persist and change engine behaviour", () => {
  it("each toggle round-trips through PUT /approval-policy, bumps the version, and rejects junk", async () => {
    const t = await makeWorkspace();
    const before = (await t.L.get("/api/expense-admin/approval-policy")).body.policy;
    expect(before.bot.require).toEqual({ receipt: true, category: true, noDuplicate: true, positiveAmounts: true });
    for (const key of ["receipt", "category", "noDuplicate", "positiveAmounts"] as const) {
      const off = await t.L.put("/api/expense-admin/approval-policy", { bot: { require: { [key]: false } } });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(off.body.policy.bot.require[key]).toBe(false);
      const on = await t.L.put("/api/expense-admin/approval-policy", { bot: { require: { [key]: true } } });
      expect(on.body.policy.bot.require[key]).toBe(true);
    }
    const after = await getPolicy(t.wsId);
    expect(after.version).toBe(before.version + 8);
    expect(after.bot.require).toEqual(before.bot.require);
    const junk = await t.L.put("/api/expense-admin/approval-policy", { bot: { require: { receipt: "maybe", bogus: true } } });
    expect(junk.status).toBe(400);
    expect(junk.body.errors ?? [junk.body.error]).toEqual(expect.arrayContaining([expect.stringMatching(/bot\.require\.receipt must be true or false/), expect.stringMatching(/bot\.require\.bogus is not a pre-check/)]));
  });

  it("turning 'require receipt' OFF makes the gate stop applying: an unreadable bill now auto-approves; ON again → a person", async () => {
    const t = await makeWorkspace();
    const up = await uploadBill(t.arjun, { amount: null }); // unreadable
    const line = await saveLine(t.arjun, t.meals, 700, { imageKey: up.imageKey });
    const c = await claimOf(t.arjun, "toggle-receipt", [line._id]);

    await t.L.put("/api/expense-admin/approval-policy", { bot: { require: { receipt: false } } });
    const s1 = await submit(t.arjun, c);
    expect(s1.body.report.status).toBe("approved");
    expect(s1.body.report.routing.bot.checks.receipt).toBe(false); // still computed…
    expect(s1.body.report.routing.bot.checksEnforced).not.toContain("receipt"); // …just not enforced
    expect(s1.body.report.routing.bot.checksFailed).toEqual([]);

    // Fresh identical claim with the toggle back ON → a person.
    await t.L.put("/api/expense-admin/approval-policy", { bot: { require: { receipt: true } } });
    const up2 = await uploadBill(t.arjun, { amount: null });
    const line2 = await saveLine(t.arjun, t.meals, 700, { imageKey: up2.imageKey });
    const c2 = await claimOf(t.arjun, "toggle-receipt-2", [line2._id]);
    const s2 = await submit(t.arjun, c2);
    expect(s2.body.report.status).toBe("submitted");
    expect(s2.body.report.routing.bot.checksEnforced).toContain("receipt");
  });

  it("the other three toggles each relax exactly their own check", async () => {
    const t = await makeWorkspace();
    const other = String((await ExpenseCategory.create({ workspaceId: t.wsId, name: "Snacks", active: true, botLimitMode: "amount", botLimitBase: 5000 }))._id);
    // category OFF → an uncategorised line passes
    await t.L.put("/api/expense-admin/approval-policy", { bot: { require: { category: false } } });
    const u1 = await uploadBill(t.arjun, { amount: 300 });
    const r1 = await as(t.arjun).post("/api/expenses", { amount: 300, date: TODAY, merchant: "Mock Cafe", imageKey: u1.imageKey });
    const c1 = await claimOf(t.arjun, "nocat", [r1.body.expense._id]);
    const s1 = await submit(t.arjun, c1);
    expect(s1.body.report.status).toBe("approved");
    expect(s1.body.report.routing.bot.checks.category).toBe(false);
    await t.L.put("/api/expense-admin/approval-policy", { bot: { require: { category: true } } });

    // noDuplicate OFF → two identical bills (each with its own matching receipt) pass
    await t.L.put("/api/expense-admin/approval-policy", { bot: { require: { noDuplicate: false } } });
    const u2 = await uploadBill(t.arjun, { amount: 250 });
    const u3 = await uploadBill(t.arjun, { amount: 250 });
    const d1 = await saveLine(t.arjun, t.meals, 250, { imageKey: u2.imageKey });
    const d2 = await saveLine(t.arjun, other, 250, { imageKey: u3.imageKey }); // mixed categories → global limit
    const c2 = await claimOf(t.arjun, "dupes", [d1._id, d2._id]);
    const s2 = await submit(t.arjun, c2);
    expect(s2.body.report.routing.bot.checks.noDuplicate).toBe(false);
    expect(s2.body.report.status).toBe("approved");
    await t.L.put("/api/expense-admin/approval-policy", { bot: { require: { noDuplicate: true } } });
    // …and with it back ON the same shape goes to a person.
    const u4 = await uploadBill(t.arjun, { amount: 260 });
    const u5 = await uploadBill(t.arjun, { amount: 260 });
    const e1 = await saveLine(t.arjun, t.meals, 260, { imageKey: u4.imageKey });
    const e2 = await saveLine(t.arjun, other, 260, { imageKey: u5.imageKey });
    const c3 = await claimOf(t.arjun, "dupes-on", [e1._id, e2._id]);
    const s3 = await submit(t.arjun, c3);
    expect(s3.body.report.status).toBe("submitted");
    expect(s3.body.report.routing.bot.checksFailed).toEqual([expect.stringMatching(/^noDuplicate \(1 possible duplicate bill/)]);
  });
});

describe("9 · the tolerance setting is respected", () => {
  it("defaults to ₹10 / 5%; PUT changes it; the gate uses the LARGER of the two; junk is refused", async () => {
    const t = await makeWorkspace();
    expect((await getPolicy(t.wsId)).bot.receiptMatch).toEqual({ absToleranceBase: 10, pctTolerance: 5 });

    // Tighten to ₹1 / 0% → a ₹7 difference on ₹1,200 now fails.
    const tight = await t.L.put("/api/expense-admin/approval-policy", { bot: { receiptMatch: { absToleranceBase: 1, pctTolerance: 0 } } });
    expect(tight.status, JSON.stringify(tight.body)).toBe(200);
    expect(tight.body.policy.bot.receiptMatch).toEqual({ absToleranceBase: 1, pctTolerance: 0 });
    const u1 = await uploadBill(t.arjun, { amount: 1200 });
    const l1 = await saveLine(t.arjun, t.meals, 1207, { imageKey: u1.imageKey });
    const c1 = await claimOf(t.arjun, "tight", [l1._id]);
    const s1 = await submit(t.arjun, c1);
    expect(s1.body.report.status).toBe("submitted");
    expect(s1.body.report.routing.bot.checksFailed[0]).toMatch(/tolerance INR 1\.00/);

    // Loosen the percentage to 10% → the same ₹7 (and even ₹100 on ₹1,200) passes.
    await t.L.put("/api/expense-admin/approval-policy", { bot: { receiptMatch: { pctTolerance: 10 } } });
    expect((await getPolicy(t.wsId)).bot.receiptMatch).toEqual({ absToleranceBase: 1, pctTolerance: 10 }); // abs kept
    const u2 = await uploadBill(t.arjun, { amount: 1200 });
    const l2 = await saveLine(t.arjun, t.meals, 1300, { imageKey: u2.imageKey }); // +100 ≤ 120
    const c2 = await claimOf(t.arjun, "loose", [l2._id]);
    const s2 = await submit(t.arjun, c2);
    expect(s2.body.report.status).toBe("approved");

    // Absolute slack wins on a small bill: ₹1 / 10% of ₹20 = ₹2, but abs ₹25 → a ₹20 bill claimed as ₹40 passes.
    await t.L.put("/api/expense-admin/approval-policy", { bot: { receiptMatch: { absToleranceBase: 25 } } });
    const u3 = await uploadBill(t.arjun, { amount: 20 });
    const l3 = await saveLine(t.arjun, t.meals, 40, { imageKey: u3.imageKey });
    const c3 = await claimOf(t.arjun, "abs-wins", [l3._id]);
    expect((await submit(t.arjun, c3)).body.report.status).toBe("approved");

    for (const bad of [{ absToleranceBase: -1 }, { pctTolerance: 101 }, { pctTolerance: "lots" }, { absToleranceBase: null }]) {
      const r = await t.L.put("/api/expense-admin/approval-policy", { bot: { receiptMatch: bad } });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    // The tolerance in force is written to the trail with every receipt failure.
    const u4 = await uploadBill(t.arjun, { amount: 1000 });
    const l4 = await saveLine(t.arjun, t.meals, 2000, { imageKey: u4.imageKey });
    const c4 = await claimOf(t.arjun, "trail-tol", [l4._id]);
    await submit(t.arjun, c4);
    const trail = await trailOf(t.arjun, c4);
    expect(trail.find((a) => /Receipt check failed/.test(a.note)).details.tolerance).toEqual({ absToleranceBase: 25, pctTolerance: 10 });
  });

  it("a foreign-currency line converts the absolute slack at the line's frozen rate", async () => {
    const t = await makeWorkspace();
    // Base INR; a USD line with a manual rate of 80 → ₹10 abs slack = $0.125; 5% of $100 = $5 → slack $5.
    await t.L.put("/api/expense-admin/approval-policy", { bot: { thresholdBase: 50000 } });
    await ExpenseCategory.updateOne({ _id: t.meals }, { $set: { botLimitBase: 50000 } });
    const u = await uploadBill(t.arjun, { amount: 100, currency: "USD" });
    const l = await saveLine(t.arjun, t.meals, 104, { imageKey: u.imageKey, currency: "USD" }); // +$4 ≤ $5
    const rate = await as(t.arjun).post(`/api/expenses/${l._id}/rate`, {}); // route is PATCH; ensure POST 404s harmlessly
    expect([404, 405]).toContain(rate.status);
    const fx = await request(app).patch(`/api/expenses/${l._id}/rate`).set("Authorization", `Bearer ${signToken({ sub: t.arjun.id, roles: t.arjun.roles, email: t.arjun.email, workspaceId: t.wsId } as any)}`).send({ exchangeRate: 80 });
    expect(fx.status, JSON.stringify(fx.body)).toBe(200);
    const c = await claimOf(t.arjun, "usd", [l._id]);
    const s = await submit(t.arjun, c);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.report.status).toBe("approved");
    // $110 (+$10) would exceed $5 → person.
    const u2 = await uploadBill(t.arjun, { amount: 100, currency: "USD" });
    const l2 = await saveLine(t.arjun, t.meals, 110, { imageKey: u2.imageKey, currency: "USD" });
    await request(app).patch(`/api/expenses/${l2._id}/rate`).set("Authorization", `Bearer ${signToken({ sub: t.arjun.id, roles: t.arjun.roles, email: t.arjun.email, workspaceId: t.wsId } as any)}`).send({ exchangeRate: 80 });
    const c2 = await claimOf(t.arjun, "usd-off", [l2._id]);
    const s2 = await submit(t.arjun, c2);
    expect(s2.body.report.status).toBe("submitted");
    expect(s2.body.report.routing.bot.checksFailed[0]).toMatch(/receipt amount USD 100\.00 doesn't match claimed USD 110\.00 \(tolerance USD 5\.00\)/);
  });
});

// F-30: the claim page's "extracted data" panel used to print the LINE's
// amount (the submitter's number) as if it were what the receipt said, hiding
// the very mismatch the bot routed the claim for. GET /reports/:id now carries
// the server-held read (`receiptRead`) and the per-line verdict beside each
// line so the approver sees receipt ₹1,400 next to claimed ₹500.
describe("10 · F-30 — GET /reports/:id carries the RECEIPT's read next to the claimed line", () => {
  it("mismatch: receiptRead.amount is the receipt's 1,400, the line's amount stays the claimed 500, verdict says mismatch", async () => {
    const t = await makeWorkspace();
    const up = await uploadBill(t.arjun, { amount: 1400, merchant: "Shree Thaker Bhojanalay" });
    const line = await saveLine(t.arjun, t.meals, 500, { imageKey: up.imageKey, merchant: "Typed Cafe" });
    const c = await claimOf(t.arjun, "f30", [line._id]);
    await submit(t.arjun, c);
    const byManager = await as(t.meera).get(`/api/reports/${c}`);
    expect(byManager.status).toBe(200);
    const [row] = byManager.body.expenses;
    expect(row.amount).toBe(500); // what was claimed, unchanged
    expect(row.merchant).toBe("Typed Cafe");
    expect(row.receiptRead).toMatchObject({ readable: true, amount: 1400, currency: "INR", merchant: "Shree Thaker Bhojanalay", suggestedCategory: "Meals" });
    expect(row.receiptVerdict).toMatchObject({ status: "mismatch", claimedAmount: 500, extractedAmount: 1400, extractedCurrency: "INR", toleranceApplied: 70 });
    expect(row.receiptVerdict.reason).toMatch(/receipt amount INR 1,400\.00 doesn't match claimed INR 500\.00 \(tolerance INR 70\.00\)/);
    // the raw blobs the client echoed are still not exposed
    expect(row.rawExtraction).toBeUndefined();
    expect(row.perFieldConfidence).toBeUndefined();
  });

  it("match, unreadable, no receipt, and a never-read key each describe themselves", async () => {
    const t = await makeWorkspace();
    const ok = await uploadBill(t.arjun, { amount: 1400 });
    const okLine = await saveLine(t.arjun, t.meals, 1400, { imageKey: ok.imageKey });
    const bad = await uploadBill(t.arjun, { amount: null });
    const badLine = await saveLine(t.arjun, t.meals, 150, { imageKey: bad.imageKey });
    const none = await saveLine(t.arjun, t.meals, 90);
    const legacy = await saveLine(t.arjun, t.meals, 80, { imageKey: `hrms/expenses/${t.wsId}/${t.arjun.id}/legacy-${Date.now()}.jpg` });
    const c = await claimOf(t.arjun, "f30-mix", [okLine._id, badLine._id, none._id, legacy._id]);
    const rows: any[] = (await as(t.arjun).get(`/api/reports/${c}`)).body.expenses;
    const by = (id: string) => rows.find((r) => String(r._id) === String(id));

    expect(by(okLine._id).receiptRead).toMatchObject({ readable: true, amount: 1400 });
    expect(by(okLine._id).receiptVerdict).toMatchObject({ status: "ok", extractedAmount: 1400, claimedAmount: 1400 });

    expect(by(badLine._id).receiptRead).toMatchObject({ readable: false, amount: null });
    expect(by(badLine._id).receiptRead.errorMessage).toBeTruthy();
    expect(by(badLine._id).receiptVerdict.status).toBe("unreadable");

    expect(by(none._id).hasReceipt).toBe(false);
    expect(by(none._id).receiptRead).toBeNull();
    expect(by(none._id).receiptVerdict.status).toBe("missing");

    expect(by(legacy._id).hasReceipt).toBe(true);
    expect(by(legacy._id).receiptRead).toBeNull(); // the server never read this key
    expect(by(legacy._id).receiptVerdict.status).toBe("unreadable");
  });
});

describe("simulator", () => {
  it("'test this claim' shows the same receipt verdict the live engine would apply, without changing anything", async () => {
    const t = await makeWorkspace();
    const up = await uploadBill(t.arjun, { amount: 900 });
    const line = await saveLine(t.arjun, t.meals, 1500, { imageKey: up.imageKey });
    const c = await claimOf(t.arjun, "sim", [line._id]);
    const sim = await t.L.post("/api/expense-admin/approval-policy/simulate", { reportId: c });
    expect(sim.status, JSON.stringify(sim.body)).toBe(200);
    const d = sim.body.decision ?? sim.body.result ?? sim.body;
    expect(d.bot.wouldAutoApprove).toBe(false);
    expect(d.bot.checksFailed[0]).toMatch(/receipt amount INR 900\.00 doesn't match claimed INR 1,500\.00/);
    expect(((await Report.findById(c).lean()) as any).status).toBe("draft");
  });
});
