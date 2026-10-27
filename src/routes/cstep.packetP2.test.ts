// apps/backend/src/routes/cstep.packetP2.test.ts
//
// P2 — the whole travel packet, for every login that can open the case, on
// every status from a filed report through REIMBURSED / SETTLED; and the
// packet is rebuilt only when an input to it changed (the packetStale flag),
// never on a plain view. Before P2 the rebuild compared packetGeneratedAt
// with updatedAt, and saving the new key bumped updatedAt — every view
// re-rendered and wrote a new S3 object.
//
// Real: cstep router, models, the packet ASSEMBLY (utils/cstepPacketPdf.ts),
//   in-memory Mongo REPLICA SET on a fresh database, cstep_qc_packet_p2.
// Stubbed: the S3 client (every PutObject is recorded — a cstep-packets/
//   put is one render, one stored object), mail, the presigner, the
//   attachment store, auth (x-test-user) and the workspace resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { PDFDocument as PdfLibDocument } from "pdf-lib";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_packet_p2";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;
// The N-views test alone makes ~150 requests; the full cstep run is slow.
vi.setConfig({ testTimeout: 60_000 });

const puts = vi.hoisted(() => [] as Array<{ Key: string; Body: any }>);
const onePagePdf = vi.hoisted(() => ({ bytes: Buffer.from("") }));
let uploadSeq = 0;
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: any) {
      if (cmd?.kind === "put") puts.push(cmd.input);
      return {};
    }
  },
  PutObjectCommand: class {
    kind = "put";
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
  getObjectBuffer: vi.fn(async () => onePagePdf.bytes),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async (a: any) => `http://qc/presigned/${a.key}`) }));

const { default: cstepRouter } = await import("./cstep.js");

const DB = "cstep_qc_packet_p2";
const oid = () => new mongoose.Types.ObjectId();
const id$ = (s: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), manager: oid(), official: oid(), finance: oid(), admin: oid(), desk: oid(), stranger: oid() };
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
  admin: who(U.admin, ["ADMIN"]),
  desk: who(U.desk), // granted the workspace Travel Desk role below — not an Admin, not this traveller's Official
  stranger: who(U.stranger),
};
const VIEWERS = ["traveller", "manager", "official", "finance", "admin", "desk"] as const;
const send = (m: "get" | "post" | "patch" | "delete", as: any, path: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  return m === "get" || m === "delete" ? r : r.send(path === "/requests" ? { projectId: String(QC_PROJECT), ...body } : body || {});
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body?: any) => send("post", as, path, body);
const patch = (as: any, path: string, body?: any) => send("patch", as, path, body);
const del = (as: any, path: string) => send("delete", as, path);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const file = (as: any, path: string, name: string) =>
  request(app)
    .post(`/api/cstep${path}`)
    .set("x-test-user", JSON.stringify(as))
    .attach("file", Buffer.from(`%PDF-1.4 ${name}`), { filename: name, contentType: "application/pdf" });

/** The packet renders (= stored S3 objects) written for one request. */
const renders = (id: string) => puts.filter((p) => p.Key.startsWith(`cstep-packets/${WS}/${id}/`));
const viewPacket = async (as: any, id: string, mode: "view" | "download" = "view") => ok(await get(as, `/requests/${id}/packet?mode=${mode}`)).body;
const requestDoc = async (id: string) => (await col("csteptravelrequests").findOne({ _id: id$(id) }))!;

const TOUR = {
  type: "DOMESTIC",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
  perDiemEligible: false,
};

/** A Tour with one self-paid cab leg (bill attached), through report → Manager
 * approval → settlement started. `fare` 0 means nothing is owed. */
async function tourToSettlement(purpose: string, fare: number): Promise<string> {
  const id = String(ok(await post(ACT.traveller, "/requests", { ...TOUR, purpose })).body.request._id);
  ok(await post(ACT.manager, `/requests/${id}/approve`));
  ok(await post(ACT.official, `/requests/${id}/start-arranging`));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  ok(await post(ACT.traveller, `/requests/${id}/report/start`));
  if (fare > 0) {
    const leg = ok(
      await post(ACT.traveller, `/requests/${id}/report/legs`, {
        direction: "ONWARD", travelMode: "CAB", paidBy: "SELF", fare, currency: "INR",
        fromLocation: "Airport", toLocation: "Office", fromDate: "2026-11-02", toDate: "2026-11-02",
      }),
    ).body.leg;
    ok(await file(ACT.traveller, `/requests/${id}/report/legs/${leg._id}/attachment`, "cab-bill.pdf"));
  }
  ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
  ok(await post(ACT.manager, `/requests/${id}/report/approve`));
  ok(await post(ACT.official, `/requests/${id}/settlement/start`));
  return id;
}

let replSet: MongoMemoryReplSet;
const R = { reimbursed: "", settled: "" };

beforeAll(async () => {
  const one = await PdfLibDocument.create();
  one.addPage([200, 200]);
  onePagePdf.bytes = Buffer.from(await one.save());

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
  ok(await post(ACT.admin, "/travel-desk", { userId: String(U.desk) }));

  // Paid out by Finance → REIMBURSED.
  R.reimbursed = await tourToSettlement("QC packet — reimbursed", 1200);
  ok(await post(ACT.official, `/requests/${R.reimbursed}/settlement/finalize`, { force: true }));
  ok(await post(ACT.finance, `/requests/${R.reimbursed}/finance/settle`, { reference: "UTR-QC-1" }));
  // Nothing owed → SETTLED at finalize.
  R.settled = await tourToSettlement("QC packet — settled", 0);
  ok(await post(ACT.official, `/requests/${R.settled}/settlement/finalize`, { force: true }));
}, 240_000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("the whole packet on every login, through REIMBURSED and SETTLED", () => {
  it("the fixtures landed on the terminal statuses", async () => {
    expect((await requestDoc(R.reimbursed)).status).toBe("REIMBURSED");
    expect((await requestDoc(R.settled)).status).toBe("SETTLED");
  });

  for (const which of ["reimbursed", "settled"] as const) {
    it(`a ${which} case: every login that opens it can view and download its packet`, async () => {
      const id = R[which];
      for (const k of VIEWERS) {
        ok(await get(ACT[k], `/requests/${id}`));
        const view = await viewPacket(ACT[k], id, "view");
        const download = await viewPacket(ACT[k], id, "download");
        expect(view.url, k).toMatch(new RegExp(`^http://qc/presigned/cstep-packets/${WS}/${id}/packet-`));
        expect(download.url, k).toBe(view.url);
      }
    });

    it(`a ${which} case: a login that can't open the case can't fetch its packet`, async () => {
      const id = R[which];
      expect((await get(ACT.stranger, `/requests/${id}`)).status).toBe(403);
      expect((await get(ACT.stranger, `/requests/${id}/packet?mode=view`)).status).toBe(403);
      expect((await get(ACT.stranger, `/requests/${id}/packet?mode=download`)).status).toBe(403);
    });
  }

  it("the packet served on a settled case is the real assembled PDF — itinerary, the bill, the approval form", async () => {
    const [stored] = renders(R.reimbursed);
    const pdf = await PdfLibDocument.load(stored.Body);
    // itinerary (1) + the cab leg's caption page + its one-page bill + the Tour Proposal form (≥1)
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(4);
  });
});

describe("a plain view never rebuilds the packet", () => {
  it("opening a settled case N times — every login, both modes, every other read — is one render, one S3 object", async () => {
    const id = R.settled;
    // The run above already opened it 12 times over 6 logins.
    expect(renders(id)).toHaveLength(1);
    const before = await requestDoc(id);
    expect(before.packetStale).toBe(false);
    for (let n = 0; n < 5; n++) {
      for (const k of VIEWERS) {
        ok(await get(ACT[k], `/requests/${id}`));
        ok(await get(ACT[k], `/requests/${id}/report`));
        ok(await get(ACT[k], `/requests/${id}/activity`));
        ok(await get(ACT[k], `/requests/${id}/pdf`));
        await viewPacket(ACT[k], id, n % 2 ? "download" : "view");
      }
    }
    ok(await get(ACT.official, `/requests/${id}/settlement`));
    expect(renders(id)).toHaveLength(1);
    const after = await requestDoc(id);
    expect(after.packetS3Key).toBe(before.packetS3Key);
    expect(after.packetGeneratedAt).toEqual(before.packetGeneratedAt);
    // GET /pdf re-caches the approval form on every view (its own updatedAt
    // comparison — not the packet's), so updatedAt moves; its cache paths
    // are packet-neutral and leave the packet fresh.
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.packetStale).toBe(false);
  });

  it("a packet cached before P2 (no flag) rebuilds once, then is served from the cache", async () => {
    const id = R.reimbursed;
    await col("csteptravelrequests").updateOne({ _id: id$(id) }, { $unset: { packetStale: 1 } });
    const n = renders(id).length;
    await viewPacket(ACT.finance, id);
    await viewPacket(ACT.traveller, id);
    await viewPacket(ACT.admin, id, "download");
    expect(renders(id).length - n).toBe(1);
  });
});

describe("each input change rebuilds the packet exactly once", () => {
  let id = "";
  let flight = "";
  let flightLeg = "";
  let line = "";

  /** Views the packet three times; returns how many renders that caused. */
  const rebuildsOnNextViews = async () => {
    const n = renders(id).length;
    await viewPacket(ACT.official, id);
    await viewPacket(ACT.traveller, id, "download");
    await viewPacket(ACT.finance, id);
    return renders(id).length - n;
  };

  it("set-up: an arranged flight with the report started — first view renders once", async () => {
    id = String(ok(await post(ACT.traveller, "/requests", { ...TOUR, purpose: "QC packet — triggers" })).body.request._id);
    ok(await post(ACT.manager, `/requests/${id}/approve`));
    const [seeded] = ok(await post(ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
    flight = String(seeded._id);
    ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight}`, { details: "6E-511 BLR-DEL", amount: 9400, currency: "INR", status: "ARRANGED" }));
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
    const legs: any[] = ok(await post(ACT.traveller, `/requests/${id}/report/start`)).body.legs;
    flightLeg = String(legs.find((l) => String(l.arrangementId) === flight)._id);
    expect(await rebuildsOnNextViews()).toBe(1);
    expect(await rebuildsOnNextViews()).toBe(0);
  });

  it("Desk attaches a booking document → once; removes it → once", async () => {
    const att = ok(await file(ACT.official, `/requests/${id}/arrangements/${flight}/attachment`, "eticket.pdf")).body.attachment;
    expect(await rebuildsOnNextViews()).toBe(1);
    ok(await del(ACT.official, `/requests/${id}/arrangements/${flight}/attachment/${att._id}`));
    expect(await rebuildsOnNextViews()).toBe(1);
  });

  it("leg added → once; its bill attached → once; another leg added and removed → once each", async () => {
    const kept = ok(
      await post(ACT.traveller, `/requests/${id}/report/legs`, {
        direction: "ONWARD", travelMode: "CAB", paidBy: "SELF", fare: 900, currency: "INR",
        fromLocation: "Airport", toLocation: "Office", fromDate: "2026-11-02", toDate: "2026-11-02",
      }),
    ).body.leg;
    expect(await rebuildsOnNextViews()).toBe(1);
    ok(await file(ACT.traveller, `/requests/${id}/report/legs/${kept._id}/attachment`, "cab-bill.pdf"));
    expect(await rebuildsOnNextViews()).toBe(1);
    const leg = ok(
      await post(ACT.traveller, `/requests/${id}/report/legs`, {
        direction: "RETURN", travelMode: "CAB", paidBy: "SELF", fare: 600, currency: "INR",
        fromLocation: "Office", toLocation: "Airport", fromDate: "2026-11-04", toDate: "2026-11-04",
      }),
    ).body.leg;
    expect(await rebuildsOnNextViews()).toBe(1);
    ok(await del(ACT.traveller, `/requests/${id}/report/legs/${leg._id}`));
    expect(await rebuildsOnNextViews()).toBe(1);
  });

  it("boarding pass added → once; removed → once", async () => {
    const pass = ok(await file(ACT.traveller, `/requests/${id}/report/legs/${flightLeg}/travel-proof`, "bp-1.pdf")).body.attachment;
    expect(await rebuildsOnNextViews()).toBe(1);
    ok(await del(ACT.traveller, `/requests/${id}/report/legs/${flightLeg}/travel-proof/${pass._id}`));
    expect(await rebuildsOnNextViews()).toBe(1);
    ok(await file(ACT.traveller, `/requests/${id}/report/legs/${flightLeg}/travel-proof`, "bp-2.pdf"));
    expect(await rebuildsOnNextViews()).toBe(1);
  });

  it("report submitted / approved and settlement opened — each once (the packet prints the status and the settlement)", async () => {
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    expect(await rebuildsOnNextViews()).toBe(1);
    ok(await post(ACT.manager, `/requests/${id}/report/approve`));
    expect(await rebuildsOnNextViews()).toBe(1);
    const lines: any[] = ok(await post(ACT.official, `/requests/${id}/settlement/start`)).body.lines;
    line = String(lines[0]._id);
    expect(await rebuildsOnNextViews()).toBe(1);
  });

  it("settlement line changed → once", async () => {
    ok(await patch(ACT.official, `/requests/${id}/settlement/lines/${line}`, { verified: true }));
    expect(await rebuildsOnNextViews()).toBe(1);
  });

  it("finalize → once; Finance pays it (REIMBURSED) → once; and after that, views are free", async () => {
    ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true }));
    expect(await rebuildsOnNextViews()).toBe(1);
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { reference: "UTR-QC-2" }));
    expect((await requestDoc(id)).status).toBe("REIMBURSED");
    expect(await rebuildsOnNextViews()).toBe(1);
    for (let n = 0; n < 4; n++) expect(await rebuildsOnNextViews()).toBe(0);
  });

  it("a render that fails leaves the packet stale, so the next view retries", async () => {
    await col("csteptravelrequests").updateOne({ _id: id$(id) }, { $set: { packetStale: true } });
    const s3 = await import("@aws-sdk/client-s3");
    const send = vi.spyOn((s3 as any).S3Client.prototype, "send").mockRejectedValueOnce(new Error("S3 down"));
    expect((await get(ACT.official, `/requests/${id}/packet`)).status).toBe(500);
    send.mockRestore();
    expect((await requestDoc(id)).packetStale).toBe(true);
    expect(await rebuildsOnNextViews()).toBe(1);
  });
});
