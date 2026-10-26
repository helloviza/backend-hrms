// apps/backend/src/routes/cstep.addBackSettlement.test.ts
//
// #7 — a "Booked by CSTEP" report leg removed and restored with "+ Add back"
// must still be ONE booking in settlement. The add-back used to re-create the
// leg as source ADDED, and buildSeedSettlementLines seeds a CSTEP-paid ADDED
// leg as its own OFFICIAL line — on top of the arrangement's line — so the
// fare landed in cost of tour twice (repro: ₹28,900 for ₹19,500, air/rail/bus
// ₹18,800 for ₹9,400). Now the add-back names its arrangement and comes back
// SEEDED, and seeding also pairs a legacy ADDED copy of a booking (same mode +
// fare + currency, its arrangement left with no SEEDED leg) with that
// arrangement instead of counting it again.
//
// Real: cstep router, models, in-memory Mongo REPLICA SET (approve runs in a
//   transaction) on a fresh database, cstep_qc_addback_settle.
// Stubbed: S3, mail, the presigner, the event/packet uploaders, auth
//   (x-test-user) and the workspace resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_addback_settle";
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
vi.mock("../utils/cstepEventRequestPdf.js", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })),
}));
vi.mock("../utils/cstepPacketPdf.js", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })),
}));

const { default: cstepRouter } = await import("./cstep.js");

const DB = "cstep_qc_addback_settle";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), manager: oid(), official: oid(), finance: oid() };
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
const who = (id: mongoose.Types.ObjectId) => ({ _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles: ["REQUESTER"], workspaceId: String(WS) });
const ACT = { traveller: who(U.traveller), manager: who(U.manager), official: who(U.official), finance: who(U.finance) };
const send = (m: "get" | "post" | "patch" | "delete", as: any, path: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  return m === "get" ? r : r.send(path === "/requests" ? { projectId: String(QC_PROJECT), ...body } : body || {});
};
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const uploadDoc = (id: string, legId: string) =>
  request(app)
    .post(`/api/cstep/requests/${id}/report/legs/${legId}/attachment`)
    .set("x-test-user", JSON.stringify(ACT.traveller))
    .attach("file", Buffer.from("%PDF-1.4 qc boarding pass"), { filename: "boarding-pass.pdf", contentType: "application/pdf" });

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
const FARE = 9400;
const CAB = 650;

/** A Tour with one ₹9,400 booked flight, its report started, plus a billed self-paid cab leg. */
async function bookedTour(purpose: string) {
  const id = String(ok(await send("post", ACT.traveller, "/requests", { ...TOUR, purpose })).body.request._id);
  ok(await send("post", ACT.manager, `/requests/${id}/approve`));
  const [flight] = ok(await send("post", ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
  ok(await send("patch", ACT.official, `/requests/${id}/arrangements/${flight._id}`, { details: "6E-511 BLR-DEL", amount: FARE, currency: "INR", status: "ARRANGED" }));
  ok(await send("post", ACT.official, `/requests/${id}/mark-arranged`));
  const [seeded] = ok(await send("post", ACT.traveller, `/requests/${id}/report/start`)).body.legs;
  const cab = String(ok(await send("post", ACT.traveller, `/requests/${id}/report/legs`, { direction: "RETURN", travelMode: "CAB", fare: CAB, paidBy: "SELF" })).body.leg._id);
  ok(await uploadDoc(id, cab));
  return { id, flightId: String(flight._id), seeded };
}
/** "+ Add back" exactly as the frontend's reAddPayload sends it. */
const addBackBody = (flightId: string) => ({ arrangementId: flightId, direction: "ONWARD", travelMode: "FLIGHT", fare: FARE, currency: "INR", paidBy: "CSTEP", remarks: "6E-511 BLR-DEL" });
/** What the add-back sent before #7 — no arrangementId (what in-flight prod rows were made with). */
const legacyAddBackBody = () => ({ direction: "ONWARD", travelMode: "FLIGHT", fare: FARE, currency: "INR", paidBy: "CSTEP", remarks: "6E-511 BLR-DEL" });
const removeLeg = async (id: string, legId: string) => ok(await send("delete", ACT.traveller, `/requests/${id}/report/legs/${legId}`));

async function submitAndSettle(id: string) {
  ok(await send("post", ACT.traveller, `/requests/${id}/report/submit`));
  ok(await send("post", ACT.manager, `/requests/${id}/report/approve`));
  ok(await send("post", ACT.official, `/requests/${id}/settlement/start`));
  return ok(await send("get", ACT.official, `/requests/${id}/settlement`)).body as { settlement: any; lines: any[] };
}

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

let control: { settlement: any; lines: any[] };

describe("control — the booked leg is never removed", () => {
  it("counts the booking once", async () => {
    const { id, flightId, seeded } = await bookedTour("QC control");
    ok(await uploadDoc(id, String(seeded._id)));
    control = await submitAndSettle(id);
    const s = control.settlement;
    expect(control.lines.filter((l) => l.mode === "FLIGHT")).toHaveLength(1);
    expect(control.lines.find((l) => l.mode === "FLIGHT")).toMatchObject({ source: "ARRANGEMENT", sourceId: flightId, classification: "OFFICIAL", amountInr: FARE });
    expect(s.buckets.airRailBus).toBe(FARE);
    expect(s.totalCostOfTour).toBe(FARE + CAB + s.buckets.perDiem);
    expect(s.amountClaimed).toBe(CAB + s.buckets.perDiem);
  });
});

describe("remove a booked leg → + Add back → settle", () => {
  it("the add-back comes back as the same booking (SEEDED), and a second add-back is refused", async () => {
    const { id, flightId, seeded } = await bookedTour("QC add-back");
    await removeLeg(id, String(seeded._id));
    const back = ok(await send("post", ACT.traveller, `/requests/${id}/report/legs`, addBackBody(flightId))).body.leg;
    expect(back).toMatchObject({ source: "SEEDED", paidBy: "CSTEP", travelMode: "FLIGHT", fare: FARE, currency: "INR", remarks: "6E-511 BLR-DEL" });
    const again = await send("post", ACT.traveller, `/requests/${id}/report/legs`, addBackBody(flightId));
    expect(again.status).toBe(409);
    expect(await col("cstepreportlegs").countDocuments({ requestId: new mongoose.Types.ObjectId(id), travelMode: "FLIGHT" })).toBe(1);

    ok(await uploadDoc(id, String(back._id)));
    const { settlement: s, lines } = await submitAndSettle(id);
    expect(lines.filter((l) => l.mode === "FLIGHT")).toHaveLength(1);
    const flightLine = lines.find((l) => l.mode === "FLIGHT");
    expect(flightLine).toMatchObject({ source: "ARRANGEMENT", sourceId: flightId, amountInr: FARE });
    expect(flightLine.attachmentId).toBeTruthy(); // the restored leg's boarding pass reaches the booked line
    expect(s.buckets.airRailBus).toBe(FARE); // not 18,800
    expect(s.totalCostOfTour).toBe(control.settlement.totalCostOfTour); // the control's figure, not + 9,400
    expect(s.amountClaimed).toBe(control.settlement.amountClaimed);
    expect(s.amountDueByCstep).toBe(control.settlement.amountDueByCstep);
  });

  it("a restored leg ticked No bill keeps Requestor-a's declared line", async () => {
    const { id, flightId, seeded } = await bookedTour("QC add-back no-bill");
    await removeLeg(id, String(seeded._id));
    const back = ok(await send("post", ACT.traveller, `/requests/${id}/report/legs`, addBackBody(flightId))).body.leg;
    ok(await send("patch", ACT.traveller, `/requests/${id}/report/legs/${back._id}`, { noBill: true }));
    const { settlement: s, lines } = await submitAndSettle(id);
    expect(lines.filter((l) => l.mode === "FLIGHT")).toHaveLength(1);
    expect(lines.find((l) => l.mode === "FLIGHT")).toMatchObject({ source: "ARRANGEMENT", noBill: true });
    expect(s.totalCostOfTour).toBe(control.settlement.totalCostOfTour);
  });

  it("an add-back for a service that isn't booked on this request is refused", async () => {
    const { id, seeded } = await bookedTour("QC add-back unknown");
    await removeLeg(id, String(seeded._id));
    expect((await send("post", ACT.traveller, `/requests/${id}/report/legs`, addBackBody(String(oid())))).status).toBe(404);
    expect((await send("post", ACT.traveller, `/requests/${id}/report/legs`, addBackBody("nope"))).status).toBe(400);
  });
});

describe("a leg restored as ADDED before #7 (legacy add-back / in-flight prod rows)", () => {
  it("pairs with its arrangement — counted once, document carried", async () => {
    const { id, flightId, seeded } = await bookedTour("QC legacy add-back");
    await removeLeg(id, String(seeded._id));
    const back = ok(await send("post", ACT.traveller, `/requests/${id}/report/legs`, legacyAddBackBody())).body.leg;
    expect(back.source).toBe("ADDED");
    ok(await uploadDoc(id, String(back._id)));
    const { settlement: s, lines } = await submitAndSettle(id);
    expect(lines.filter((l) => l.mode === "FLIGHT")).toHaveLength(1);
    const flightLine = lines.find((l) => l.mode === "FLIGHT");
    expect(flightLine).toMatchObject({ source: "ARRANGEMENT", sourceId: flightId, amountInr: FARE });
    expect(flightLine.attachmentId).toBeTruthy();
    expect(s.buckets.airRailBus).toBe(FARE);
    expect(s.totalCostOfTour).toBe(control.settlement.totalCostOfTour);
    expect(s.amountClaimed).toBe(control.settlement.amountClaimed);
  });
});

describe("a genuinely traveller-added CSTEP-paid leg (never booked)", () => {
  it("still seeds its own OFFICIAL line, once, alongside the booking", async () => {
    const { id, flightId, seeded } = await bookedTour("QC traveller-added");
    ok(await uploadDoc(id, String(seeded._id)));
    const train = String(ok(await send("post", ACT.traveller, `/requests/${id}/report/legs`, { direction: "RETURN", travelMode: "TRAIN", fare: 1200, currency: "INR", paidBy: "CSTEP", fromLocation: "Delhi", toLocation: "Agra" })).body.leg._id);
    ok(await uploadDoc(id, train));
    const { settlement: s, lines } = await submitAndSettle(id);
    expect(lines.filter((l) => l.mode === "FLIGHT")).toHaveLength(1);
    expect(lines.find((l) => l.mode === "FLIGHT")).toMatchObject({ source: "ARRANGEMENT", sourceId: flightId });
    expect(lines.filter((l) => l.mode === "TRAIN")).toEqual([expect.objectContaining({ source: "REPORT_LEG", sourceId: train, classification: "OFFICIAL", amountInr: 1200 })]);
    expect(s.buckets.airRailBus).toBe(FARE + 1200);
    expect(s.totalCostOfTour).toBe(control.settlement.totalCostOfTour + 1200);
    expect(s.amountClaimed).toBe(control.settlement.amountClaimed); // CSTEP-paid — never the traveller's claim
  });
});
