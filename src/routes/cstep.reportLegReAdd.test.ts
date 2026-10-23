// apps/backend/src/routes/cstep.reportLegReAdd.test.ts
//
// Travel Report — removing a seeded "Booked by CSTEP" leg and adding it back.
// DELETE /report/legs/:legId is an immediate, permanent delete, and report/
// start never re-seeds once the report is under way — so the frontend's
// add-back (pages/cstep/reportLegDelete.ts reAddPayload) rebuilds the leg
// through POST /report/legs. This pins the backend side of that contract:
// the seed's fields are exactly { travelMode: arrangedType, fare: amount,
// currency, paidBy: "CSTEP", remarks: details }, and a leg POSTed with those
// fields comes back the same (only its source differs, ADDED).
//
// Real: cstep router, models, in-memory Mongo REPLICA SET (approve runs in a
//   transaction) on a fresh database, cstep_qc_legreadd.
// Stubbed: mail, S3 + PDF helpers, auth (x-test-user), workspace resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_legreadd";
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

const DB = "cstep_qc_legreadd";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), approver: oid(), official: oid() };
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
const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({ _id: String(id), id: String(id), sub: String(id), roles, workspaceId: String(WS) });
const ACT = { traveller: who(U.traveller), approver: who(U.approver, ["APPROVER"]), official: who(U.official) };
const call = (m: "get" | "post" | "patch" | "delete", as: any, path: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  return m === "get" ? r : r.send(path === "/requests" ? { projectId: String(QC_PROJECT), ...body } : body || {});
};
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
/** The fields the add-back carries — what reAddPayload (frontend) sends. */
const SEED_FIELDS = ["direction", "travelMode", "fare", "currency", "paidBy", "remarks"] as const;
const pick = (o: any) => Object.fromEntries(SEED_FIELDS.map((k) => [k, o[k]]));

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
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${k}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertOne({
    _id: TP, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
    claimedBy: U.traveller, tourApproverId: U.approver, officialUserId: U.official,
  } as any);
}, 180_000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("a removed booked leg, added back", () => {
  let id = "";
  let flight: any;
  let seeded: any;

  it("report/start seeds the booked leg from its arrangement — the fields reAddPayload rebuilds", async () => {
    const r = ok(await call("post", ACT.traveller, "/requests", {
      type: "DOMESTIC", purpose: "QC re-add", departureDate: "2026-11-24", returnDate: "2026-11-26",
      stations: [{ from: "Bengaluru", to: "Chennai", durationOfStay: "3 days" }], modesRequested: ["AIR"],
      transportRequired: false, accommodationRequired: false, sponsored: false,
    }));
    id = String(r.body.request._id);
    ok(await call("post", ACT.approver, `/requests/${id}/approve`));
    [flight] = ok(await call("post", ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
    flight = ok(await call("patch", ACT.official, `/requests/${id}/arrangements/${flight._id}`, { details: "6E-511 BLR→MAA", amount: 9400, currency: "INR", status: "ARRANGED" })).body.line;
    ok(await call("post", ACT.official, `/requests/${id}/mark-arranged`));
    const legs = ok(await call("post", ACT.traveller, `/requests/${id}/report/start`)).body.legs;
    expect(legs).toHaveLength(1);
    seeded = legs[0];
    expect(pick(seeded)).toEqual({ direction: "ONWARD", travelMode: flight.arrangedType, fare: flight.amount, currency: flight.currency, paidBy: "CSTEP", remarks: flight.details });
    expect(seeded.source).toBe("SEEDED");
  });

  it("DELETE is immediate and permanent, and report/start doesn't bring it back while other legs exist", async () => {
    // A second, self-paid leg keeps the report non-empty.
    ok(await call("post", ACT.traveller, `/requests/${id}/report/legs`, { direction: "RETURN", travelMode: "CAB", fare: 650, paidBy: "SELF" }));
    ok(await call("delete", ACT.traveller, `/requests/${id}/report/legs/${seeded._id}`));
    expect(await col("cstepreportlegs").findOne({ _id: new mongoose.Types.ObjectId(seeded._id) })).toBeNull();
    ok(await call("post", ACT.traveller, `/requests/${id}/report/start`));
    const legs = ok(await call("get", ACT.traveller, `/requests/${id}/report`)).body.legs;
    expect(legs.map((l: any) => l.travelMode)).toEqual(["CAB"]);
  });

  it("POSTing the add-back fields rebuilds the same leg (source ADDED)", async () => {
    const body = { direction: "ONWARD", travelMode: flight.arrangedType, fare: flight.amount, currency: flight.currency, paidBy: "CSTEP", remarks: flight.details };
    const back = ok(await call("post", ACT.traveller, `/requests/${id}/report/legs`, body)).body.leg;
    expect(pick(back)).toEqual(pick(seeded));
    expect(back.source).toBe("ADDED");
    const legs = ok(await call("get", ACT.traveller, `/requests/${id}/report`)).body.legs;
    expect(legs.map((l: any) => l.travelMode).sort()).toEqual(["CAB", "FLIGHT"]);
  });
});
