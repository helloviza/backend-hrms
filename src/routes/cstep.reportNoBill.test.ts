// apps/backend/src/routes/cstep.reportNoBill.test.ts
//
// Travel report "No bill available" (Requestor-a): a Tour's report leg can be
// ticked "No bill available" instead of carrying a document. report/submit
// passes a leg with either one and still blocks a leg with neither; the
// ticked legs — and only those — are the report's self-declaration (the
// claim Declaration form, #8: claimDeclarationItems + the real renderer),
// generated at report submission, listed in the detail payload, downloadable
// by the report's viewers, and appended to the travel packet.
//
// The renderer is the real one: uploadCstepClaimDeclarationPdf is wrapped to
// record the items it was handed, then runs the real generator. The packet
// route's uploader is stubbed; the packet ASSEMBLY is exercised for real at
// the end (vi.importActual) to prove the declaration pages land in it.
//
// Real: cstep router, models, in-memory Mongo REPLICA SET (approve runs in a
//   transaction) on a fresh database, cstep_qc_report_nobill.
// Stubbed: S3, mail, the presigner, the event/packet uploaders, auth
//   (x-test-user) and the workspace resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { PDFDocument as PdfLibDocument } from "pdf-lib";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_report_nobill";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

const s3Puts = vi.hoisted(() => [] as Array<{ Key: string; Body: Buffer }>);
const rendered = vi.hoisted(() => [] as Array<{ items: any[]; pdf: Buffer }>);
const packetCalls = vi.hoisted(() => [] as any[][]);
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
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })),
}));
vi.mock("../utils/cstepPacketPdf.js", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  uploadCstepPacketPdf: vi.fn(async (...args: any[]) => {
    packetCalls.push(args);
    return { key: "qc-packet" };
  }),
}));
vi.mock("../utils/cstepClaimPdf.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    uploadCstepClaimDeclarationPdf: vi.fn(async (request: any, claimant: any, items: any[], trail: any[]) => {
      const pdf = await real.generateCstepClaimDeclarationPdf(request, claimant, items, trail);
      rendered.push({ items, pdf });
      return real.uploadCstepClaimDeclarationPdf(request, claimant, items, trail);
    }),
  };
});

const { default: cstepRouter } = await import("./cstep.js");

const DB = "cstep_qc_report_nobill";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), manager: oid(), official: oid(), finance: oid(), stranger: oid() };
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
  manager: who(U.manager),
  official: who(U.official),
  finance: who(U.finance),
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
const uploadDoc = (id: string, legId: string) =>
  request(app)
    .post(`/api/cstep/requests/${id}/report/legs/${legId}/attachment`)
    .set("x-test-user", JSON.stringify(ACT.traveller))
    .attach("file", Buffer.from("%PDF-1.4 qc boarding pass"), { filename: "boarding-pass.pdf", contentType: "application/pdf" });
const declarationPuts = () => s3Puts.filter((p) => /\/declaration-\d+\.pdf$/.test(p.Key));
const reqDoc = (id: string) => col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) });
const lastItems = () => rendered[rendered.length - 1].items.map((d: any) => [d.kind, d.lineId, d.date || null, d.particulars, d.amount, d.currency]);

const TOUR = {
  type: "DOMESTIC",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
};

/** A Tour approved, arranged and with its report started (REPORT_PENDING). */
async function tourAtReportPending(purpose: string): Promise<string> {
  const id = String(ok(await post(ACT.traveller, "/requests", { ...TOUR, purpose })).body.request._id);
  ok(await post(ACT.manager, `/requests/${id}/approve`));
  ok(await post(ACT.official, `/requests/${id}/start-arranging`));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  ok(await post(ACT.traveller, `/requests/${id}/report/start`));
  return id;
}
const addLeg = async (id: string, body: any) => String(ok(await post(ACT.traveller, `/requests/${id}/report/legs`, body)).body.leg._id);

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
    email: `${U.traveller}@qc.local`, claimedBy: U.traveller, tourApproverId: U.manager, officialUserId: U.official, financeUserId: U.finance,
  } as any);
}, 180_000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("a travel report with a leg that has no bill", () => {
  let id = "";
  let flight = ""; // gets its boarding pass
  let cab = ""; // ticked "No bill available"
  let hotel = ""; // neither, until it's ticked

  it("submit is blocked while any leg has neither a document nor the tick", async () => {
    id = await tourAtReportPending("QC no-bill report");
    flight = await addLeg(id, { direction: "ONWARD", travelMode: "FLIGHT", fromLocation: "Bengaluru", toLocation: "Delhi", fromDate: "2026-11-02", fare: 6400, paidBy: "SELF" });
    cab = await addLeg(id, { direction: "ONWARD", travelMode: "CAB", fromLocation: "Delhi airport", toLocation: "Hotel", fromDate: "2026-11-02", fare: 850, paidBy: "SELF", remarks: "Street taxi, no receipt" });
    hotel = await addLeg(id, { direction: "RETURN", travelMode: "HOTEL", fromLocation: "Delhi", fromDate: "2026-11-03", fare: 120, currency: "USD", paidBy: "SELF" });
    ok(await uploadDoc(id, flight));

    const r = await post(ACT.traveller, `/requests/${id}/report/submit`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/No bill available/);
    expect(r.body.missingLegs).toEqual([
      { direction: "ONWARD", travelMode: "CAB" },
      { direction: "RETURN", travelMode: "HOTEL" },
    ]);
    expect((await reqDoc(id))!.status).toBe("REPORT_PENDING");
  });

  it("the tick is a boolean, and never sits on a leg that has a document", async () => {
    expect((await patch(ACT.traveller, `/requests/${id}/report/legs/${cab}`, { noBill: "yes" })).status).toBe(400);
    const clash = await patch(ACT.traveller, `/requests/${id}/report/legs/${flight}`, { noBill: true });
    expect(clash.status).toBe(409);
    expect((await col("cstepreportlegs").findOne({ _id: new mongoose.Types.ObjectId(flight) }))!.noBill).toBe(false);
    // Only the traveller edits their report.
    expect((await patch(ACT.stranger, `/requests/${id}/report/legs/${cab}`, { noBill: true })).status).toBe(403);
  });

  it("ticking one leg still leaves the other blocking", async () => {
    const r = ok(await patch(ACT.traveller, `/requests/${id}/report/legs/${cab}`, { noBill: true }));
    expect(r.body.leg.noBill).toBe(true);
    const s = await post(ACT.traveller, `/requests/${id}/report/submit`);
    expect(s.status).toBe(400);
    expect(s.body.missingLegs).toEqual([{ direction: "RETURN", travelMode: "HOTEL" }]);
  });

  it("while the report is in progress the detail lists what will be declared, but there's no form yet", async () => {
    ok(await patch(ACT.traveller, `/requests/${id}/report/legs/${hotel}`, { noBill: true }));
    const g = ok(await get(ACT.traveller, `/requests/${id}`)).body;
    expect(g.claimDeclaration.map((d: any) => d.lineId)).toEqual([cab, hotel]);
    expect(g.hasDeclarationForm).toBe(false);
    expect((await get(ACT.traveller, `/requests/${id}/declaration-pdf`)).status).toBe(409);
    expect(declarationPuts()).toHaveLength(0);
  });

  it("submit passes once every leg has one or the other, and renders the Declaration for the ticked legs only", async () => {
    const r = ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    expect(r.body.request.status).toBe("REPORT_UNDER_APPROVAL");

    expect(declarationPuts()).toHaveLength(1);
    expect(declarationPuts()[0].Key).toMatch(new RegExp(`^cstep-claims/${WS}/${id}/declaration-\\d+\\.pdf$`));
    // The flight has its boarding pass — it is not declared.
    expect(lastItems()).toEqual([
      ["REPORT_LEG", cab, "2026-11-02", "Onward Cab: Delhi airport → Hotel — Street taxi, no receipt", 850, "INR"],
      ["REPORT_LEG", hotel, "2026-11-03", "Return Hotel: Delhi", 120, "USD"],
    ]);
    const pdf = rendered[rendered.length - 1].pdf;
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await PdfLibDocument.load(pdf)).getPageCount()).toBeGreaterThanOrEqual(1);
    expect((await reqDoc(id))!.declarationS3Key).toBe(declarationPuts()[0].Key);
  });

  it("the detail payload offers the form, and the report's viewers can open it; a stranger can't", async () => {
    const g = ok(await get(ACT.manager, `/requests/${id}`)).body;
    expect(g.hasDeclarationForm).toBe(true);
    expect(g.claimDeclaration.map((d: any) => [d.kind, d.amount, d.currency])).toEqual([["REPORT_LEG", 850, "INR"], ["REPORT_LEG", 120, "USD"]]);
    const before = declarationPuts().length;
    for (const as of [ACT.traveller, ACT.manager, ACT.official, ACT.finance]) {
      expect(ok(await get(as, `/requests/${id}/declaration-pdf?mode=download`)).body.url).toBe("http://qc/presigned");
    }
    expect(declarationPuts()).toHaveLength(before); // cached, not re-rendered
    expect((await get(ACT.stranger, `/requests/${id}/declaration-pdf`)).status).toBe(403);
  });

  it("the travel packet is handed the same declaration", async () => {
    ok(await get(ACT.manager, `/requests/${id}/packet`));
    const declared = packetCalls[packetCalls.length - 1][5];
    expect(declared.map((d: any) => d.lineId)).toEqual([cab, hotel]);
  });

  it("a returned report: a document replaces the tick, and the resubmit re-renders without that leg", async () => {
    ok(await post(ACT.manager, `/requests/${id}/report/return`, { reason: "Find the hotel folio" }));
    ok(await uploadDoc(id, hotel));
    expect((await col("cstepreportlegs").findOne({ _id: new mongoose.Types.ObjectId(hotel) }))!.noBill).toBe(false);
    const oldKey = (await reqDoc(id))!.declarationS3Key;
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    expect(lastItems().map((r: any[]) => r[1])).toEqual([cab]);
    expect((await reqDoc(id))!.declarationS3Key).not.toBe(oldKey);
  });
});

describe("a report where every leg has a bill", () => {
  it("submits with no Declaration form (404 on request)", async () => {
    const id = await tourAtReportPending("QC fully billed report");
    const leg = await addLeg(id, { direction: "ONWARD", travelMode: "TRAIN", fromLocation: "Pune", toLocation: "Mumbai", fare: 600, paidBy: "SELF" });
    ok(await uploadDoc(id, leg));
    const before = declarationPuts().length;
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    expect(declarationPuts()).toHaveLength(before);
    const g = ok(await get(ACT.traveller, `/requests/${id}`)).body;
    expect(g.claimDeclaration).toEqual([]);
    expect(g.hasDeclarationForm).toBe(false);
    const pdf = await get(ACT.traveller, `/requests/${id}/declaration-pdf`);
    expect(pdf.status).toBe(404);
    expect(pdf.body.error).toMatch(/Every leg of this travel report has a bill/);
  });

  it("a leg stored before the tick existed (no noBill field) still blocks submit", async () => {
    const id = await tourAtReportPending("QC legacy leg");
    const leg = await addLeg(id, { direction: "ONWARD", travelMode: "BUS", fare: 300, paidBy: "SELF" });
    await col("cstepreportlegs").updateOne({ _id: new mongoose.Types.ObjectId(leg) }, { $unset: { noBill: 1 } });
    const r = await post(ACT.traveller, `/requests/${id}/report/submit`);
    expect(r.status).toBe(400);
    expect(r.body.missingLegs).toEqual([{ direction: "ONWARD", travelMode: "BUS" }]);
  });
});

describe("settlement lines carry the tick", () => {
  it("a ticked booked leg's ARRANGEMENT line, and a ticked self-paid leg's line, read as declared; a billed one doesn't", async () => {
    const id = String(ok(await post(ACT.traveller, "/requests", { ...TOUR, purpose: "QC booked no-bill" })).body.request._id);
    ok(await post(ACT.manager, `/requests/${id}/approve`));
    const [flight] = ok(await post(ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
    ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { details: "6E-511 BLR-DEL", amount: 9400, currency: "INR", status: "ARRANGED" }));
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
    const [booked] = ok(await post(ACT.traveller, `/requests/${id}/report/start`)).body.legs;
    expect(booked).toMatchObject({ source: "SEEDED", paidBy: "CSTEP" });
    const cab = await addLeg(id, { direction: "RETURN", travelMode: "CAB", fare: 700, paidBy: "SELF" });
    const train = await addLeg(id, { direction: "RETURN", travelMode: "TRAIN", fare: 500, paidBy: "SELF" });
    ok(await patch(ACT.traveller, `/requests/${id}/report/legs/${booked._id}`, { noBill: true }));
    ok(await patch(ACT.traveller, `/requests/${id}/report/legs/${cab}`, { noBill: true }));
    ok(await uploadDoc(id, train));
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    ok(await post(ACT.manager, `/requests/${id}/report/approve`));
    ok(await post(ACT.official, `/requests/${id}/settlement/start`));

    const lines = ok(await get(ACT.official, `/requests/${id}/settlement`)).body.lines;
    const by = (source: string, sourceId: string) => lines.find((l: any) => l.source === source && String(l.sourceId) === sourceId);
    expect(by("ARRANGEMENT", String(flight._id))).toMatchObject({ noBill: true });
    expect(by("ARRANGEMENT", String(flight._id)).attachmentId).toBeUndefined();
    expect(by("REPORT_LEG", cab)).toMatchObject({ noBill: true });
    expect(by("REPORT_LEG", train)).toMatchObject({ noBill: false });
    expect(by("REPORT_LEG", train).attachmentId).toBeTruthy();
  });
});

describe("the packet assembly (real)", () => {
  it("appends the Declaration pages after the supporting documents", async () => {
    const real: any = await vi.importActual("../utils/cstepPacketPdf.js");
    const request: any = { _id: oid(), workspaceId: WS, formType: "TOUR_PROPOSAL", status: "REPORT_SUBMITTED", purpose: "QC packet", departureDate: "2026-11-02", returnDate: "2026-11-04", stations: [] };
    const legs = [
      { leg: { _id: oid(), direction: "ONWARD", travelMode: "CAB", fromLocation: "A", toLocation: "B", fare: 850, currency: "INR", paidBy: "SELF", noBill: true }, attachment: null },
    ];
    const declaration = [{ lineId: String(legs[0].leg._id), kind: "REPORT_LEG", date: "2026-11-02", particulars: "Onward Cab: A → B", amount: 850, currency: "INR" }];
    const traveller = { name: "Asha Rao" };
    const without = await PdfLibDocument.load(await real.generateCstepPacketPdf(request, traveller, [], legs));
    const withDecl = await PdfLibDocument.load(await real.generateCstepPacketPdf(request, traveller, [], legs, undefined, declaration));
    const { generateCstepClaimDeclarationPdf } = await import("../utils/cstepClaimPdf.js");
    const declPages = (await PdfLibDocument.load(await generateCstepClaimDeclarationPdf(request, traveller as any, declaration as any, []))).getPageCount();
    expect(declPages).toBeGreaterThanOrEqual(1);
    expect(withDecl.getPageCount()).toBe(without.getPageCount() + declPages);
  }, 30_000); // three real PDF renders — slow when the whole suite runs in parallel
});
