// apps/backend/src/routes/cstep.claimDeclaration.test.ts
//
// The claim Declaration form (#8): a claim submitted with items that have no
// bill gets a standalone self-declaration PDF listing exactly those items
// (utils/cstepClaimPdf.ts claimDeclarationItems + the declaration renderer);
// a fully-invoiced claim gets none; the form is regenerated when the
// invoice-less set (or the reference / submission) changes and reused when it
// hasn't; the claimant and the claim's viewers can download it, nobody else.
//
// The renderer is the real one: uploadCstepClaimDeclarationPdf is wrapped to
// record the items it was handed, then runs the real generator (the PDF must
// come out as a PDF). S3 and the presigner are stubbed and recorded.
//
// Real: cstep router, models, in-memory Mongo REPLICA SET (approve runs in a
//   transaction) on a fresh database, cstep_qc_declaration.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_declaration";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

const s3Puts = vi.hoisted(() => [] as Array<{ Key: string; Body: Buffer }>);
const presigned = vi.hoisted(() => [] as any[]);
const rendered = vi.hoisted(() => [] as Array<{ items: any[]; pdf: Buffer }>);
const failNext = vi.hoisted(() => ({ on: false }));
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
vi.mock("../utils/cstepClaimPdf.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    uploadCstepClaimDeclarationPdf: vi.fn(async (request: any, claimant: any, items: any[], trail: any[]) => {
      if (failNext.on) {
        failNext.on = false;
        throw new Error("qc: render failed");
      }
      const pdf = await real.generateCstepClaimDeclarationPdf(request, claimant, items, trail);
      rendered.push({ items, pdf });
      return real.uploadCstepClaimDeclarationPdf(request, claimant, items, trail);
    }),
  };
});

const { default: cstepRouter } = await import("./cstep.js");
const { CLAIM_DECLARATION_TEXT } = await import("../utils/cstepClaimPdf.js");

const DB = "cstep_qc_declaration";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), approver: oid(), official: oid(), finance: oid(), admin: oid(), stranger: oid() };
const TP = oid();

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
const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({ _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS) });
const ACT = {
  traveller: who(U.traveller),
  approver: who(U.approver, ["APPROVER"]),
  official: who(U.official),
  finance: who(U.finance),
  admin: who(U.admin, ["ADMIN"]),
  stranger: who(U.stranger),
};
const send = (m: "get" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  return m === "get" ? r : r.send(path === "/requests" ? { projectId: String(QC_PROJECT), ...body } : body || {});
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body?: any) => send("post", as, path, body);
const patch = (as: any, path: string, body?: any) => send("patch", as, path, body);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const stage = async () =>
  String(
    ok(
      await request(app)
        .post("/api/cstep/attachments/staging")
        .set("x-test-user", JSON.stringify(ACT.traveller))
        .field("documentType", "CAB_RECEIPT")
        .attach("file", Buffer.from("%PDF-1.4 qc receipt"), { filename: "receipt.pdf", contentType: "application/pdf" }),
    ).body.attachment._id,
  );
const declarationPuts = () => s3Puts.filter((p) => /\/declaration-\d+\.pdf$/.test(p.Key));
const reqDoc = (id: string) => col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) });
/** What the renderer was last handed, as comparable rows. */
const lastItems = () => rendered[rendered.length - 1].items.map((d: any) => [d.kind, d.date || null, d.particulars, d.amount]);

const claim = (over: any) => ({
  formType: "LOCAL_TRAVEL_CLAIM",
  purpose: "QC client meetings",
  departureDate: "2026-10-05",
  returnDate: "2026-10-09",
  travelLines: [],
  foodLines: [],
  ...over,
});

let replSet: MongoMemoryReplSet;
beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  if ((await mongoose.connection.db!.listCollections().toArray()).length) throw new Error(`Step 0: ${DB} is not empty`);
  await mongoose.connection.syncIndexes();
  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, firstName: k, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertOne({
    _id: TP, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
    claimedBy: U.traveller, tourApproverId: U.approver, officialUserId: U.official, financeUserId: U.finance,
  } as any);
}, 180_000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("a claim submitted with items that have no bill", () => {
  let id = "";
  let foodNoBillId = "";
  let receipts: string[] = [];

  it("gets a Declaration form at submission, listing exactly those items", async () => {
    receipts = [await stage(), await stage()];
    const r = ok(await post(ACT.traveller, "/requests", claim({
      travelLines: [
        { date: "2026-10-05", from: "Office", to: "Client HQ", mode: "LOCAL_TAXI", fare: 450, attachmentId: receipts[0] },
        { date: "2026-10-06", from: "Client HQ", to: "Metro station", mode: "METRO", fare: 120, noBill: true, remarks: "Token, no ticket" },
      ],
      foodLines: [
        { date: "2026-10-06", amount: 300, remarks: "Working lunch" },
        { date: "2026-10-07", amount: 220, remarks: "Dinner", attachmentId: receipts[1] },
      ],
      otherExpenses: 80,
    })));
    id = String(r.body.request._id);
    expect(r.body.request.status).toBe("SUBMITTED");
    foodNoBillId = String(r.body.request.foodLines[0]._id);

    expect(declarationPuts()).toHaveLength(1);
    expect(declarationPuts()[0].Key).toMatch(new RegExp(`^cstep-claims/${WS}/${id}/declaration-\\d+\\.pdf$`));
    expect(lastItems()).toEqual([
      ["TRAVEL", "2026-10-06", "Metro: Client HQ → Metro station — Token, no ticket", 120],
      ["FOOD", "2026-10-06", "Food: Working lunch", 300],
      ["OTHER", null, "Other expenses", 80],
    ]);
    expect(rendered[rendered.length - 1].pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const d = await reqDoc(id);
    expect(d!.declarationS3Key).toBe(declarationPuts()[0].Key);
    expect(d!.declarationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the detail payload lists the same items and offers the form", async () => {
    const g = ok(await get(ACT.traveller, `/requests/${id}`)).body;
    expect(g.hasDeclarationForm).toBe(true);
    expect(g.claimDeclaration.map((x: any) => [x.kind, x.amount])).toEqual([["TRAVEL", 120], ["FOOD", 300], ["OTHER", 80]]);
  });

  it("the claimant and the claim's viewers can download it (cached — not re-rendered); a stranger can't", async () => {
    const before = declarationPuts().length;
    presigned.length = 0;
    for (const as of [ACT.traveller, ACT.approver, ACT.official, ACT.finance, ACT.admin]) {
      const r = ok(await get(as, `/requests/${id}/declaration-pdf?mode=download`));
      expect(r.body.url).toBe("http://qc/presigned");
    }
    expect(declarationPuts()).toHaveLength(before);
    expect(presigned[0]).toMatchObject({ key: (await reqDoc(id))!.declarationS3Key, filename: `Declaration-${id}.pdf`, forceDownload: true });
    expect((await get(ACT.stranger, `/requests/${id}/declaration-pdf`)).status).toBe(403);
  });

  it("regenerates when the invoice-less set changes: return, attach the lunch receipt, drop Other expenses, resubmit", async () => {
    const oldKey = (await reqDoc(id))!.declarationS3Key;
    ok(await post(ACT.approver, `/requests/${id}/return`, { reason: "Attach the lunch bill" }));
    const lunchReceipt = await stage();
    const cur = (await reqDoc(id))!;
    ok(await patch(ACT.traveller, `/requests/${id}`, {
      travelLines: cur.travelLines.map((l: any) => ({ ...l, _id: String(l._id), attachmentId: l.attachmentId ? String(l.attachmentId) : undefined })),
      foodLines: cur.foodLines.map((l: any) => ({ ...l, _id: String(l._id), attachmentId: String(l._id) === foodNoBillId ? lunchReceipt : l.attachmentId ? String(l.attachmentId) : undefined })),
      otherExpenses: 0,
    }));
    ok(await post(ACT.traveller, `/requests/${id}/submit`));
    expect(lastItems()).toEqual([["TRAVEL", "2026-10-06", "Metro: Client HQ → Metro station — Token, no ticket", 120]]);
    const d = await reqDoc(id);
    expect(d!.declarationS3Key).not.toBe(oldKey);
  });

  it("regenerates once the reference is issued (it prints on the form), then is reused", async () => {
    ok(await post(ACT.approver, `/requests/${id}/approve`));
    const ref = (await reqDoc(id))!.claimReference;
    expect(ref).toMatch(/^LTC\d{4}\/\d{4}$/);
    const before = declarationPuts().length;
    presigned.length = 0;
    ok(await get(ACT.traveller, `/requests/${id}/declaration-pdf`));
    expect(declarationPuts()).toHaveLength(before + 1);
    expect(presigned[0].filename).toBe(`Declaration-${ref}.pdf`);
    ok(await get(ACT.traveller, `/requests/${id}/declaration-pdf`));
    expect(declarationPuts()).toHaveLength(before + 1);
  });
});

describe("claims with nothing to declare, and the edges", () => {
  it("a fully-invoiced claim gets no form: none at submission, none on request (404)", async () => {
    const before = declarationPuts().length;
    const r = ok(await post(ACT.traveller, "/requests", claim({
      purpose: "QC fully invoiced",
      travelLines: [{ date: "2026-10-05", from: "Office", to: "Airport", mode: "CAB", fare: 900, attachmentId: await stage() }],
      foodLines: [{ date: "2026-10-05", amount: 150, remarks: "Tea", attachmentId: await stage() }],
    })));
    const id = String(r.body.request._id);
    expect(declarationPuts()).toHaveLength(before);
    const g = ok(await get(ACT.traveller, `/requests/${id}`)).body;
    expect(g.hasDeclarationForm).toBe(false);
    expect(g.claimDeclaration).toEqual([]);
    const pdf = await get(ACT.traveller, `/requests/${id}/declaration-pdf`);
    expect(pdf.status).toBe(404);
    expect(pdf.body.error).toMatch(/no Declaration form is needed/);
    expect((await reqDoc(id))!.declarationS3Key).toBeUndefined();
  });

  it("a draft isn't generated until it's submitted (409); a Tour has no Declaration form (409)", async () => {
    const before = declarationPuts().length;
    const r = ok(await post(ACT.traveller, "/requests", claim({ purpose: "QC draft", saveDraft: true, otherExpenses: 60 })));
    const id = String(r.body.request._id);
    expect(declarationPuts()).toHaveLength(before);
    expect(ok(await get(ACT.traveller, `/requests/${id}`)).body.hasDeclarationForm).toBe(false);
    expect((await get(ACT.traveller, `/requests/${id}/declaration-pdf`)).status).toBe(409);
    ok(await post(ACT.traveller, `/requests/${id}/submit`));
    expect(declarationPuts()).toHaveLength(before + 1);
    expect(lastItems()).toEqual([["OTHER", null, "Other expenses", 60]]);

    const tour = ok(await post(ACT.traveller, "/requests", {
      type: "DOMESTIC", purpose: "QC tour", departureDate: "2026-11-02", returnDate: "2026-11-04",
      stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }], modesRequested: ["AIR"],
      transportRequired: false, accommodationRequired: false, sponsored: false,
    }));
    expect((await get(ACT.traveller, `/requests/${tour.body.request._id}/declaration-pdf`)).status).toBe(409);
  });

  it("a render failure never fails the submit; the form is generated on first download instead", async () => {
    failNext.on = true;
    const before = declarationPuts().length;
    const r = await post(ACT.traveller, "/requests", claim({ purpose: "QC render failure", otherExpenses: 40 }));
    expect(r.status).toBe(201);
    const id = String(r.body.request._id);
    expect(declarationPuts()).toHaveLength(before);
    expect((await reqDoc(id))!.declarationS3Key).toBeUndefined();
    ok(await get(ACT.traveller, `/requests/${id}/declaration-pdf`));
    expect(declarationPuts()).toHaveLength(before + 1);
  });

  it("the statement is one constant, shared by the form and the claim PDF section", () => {
    expect(CLAIM_DECLARATION_TEXT).toMatch(/^I hereby declare that the expenses listed above were genuinely incurred by me for official purposes/);
  });
});
