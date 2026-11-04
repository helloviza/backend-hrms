// apps/backend/src/routes/cstep.reportLegPrefill.test.ts
//
// Module B: a seeded travel-report leg's From / To / date come from the
// request. Before this, a FLIGHT / TRAIN / BUS leg started with an empty route.
// It is filled only where the leg lines up with the request's stations
// (domestic) or countries (international). HOTEL / CAB legs stay blank, and a
// leg the traveller already edited, or one seeded before this change, is
// never rewritten.
//
// Part 1 is seedLegRoutes on its own (pure). Part 2 runs it through the real
// routes: report/start and "+ Add back".
//
// Real: cstep router, models, in-memory Mongo REPLICA SET on a fresh
//   database, cstep_qc_legprefill.
// Stubbed: mail, S3 + PDF helpers, auth (x-test-user), workspace resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_legprefill";
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

const { default: cstepRouter, seedLegRoutes } = await import("./cstep.js");

const route = (l: any) => ({ fromLocation: l.fromLocation, toLocation: l.toLocation, fromDate: l.fromDate, toDate: l.toDate });
const leg = (direction: "ONWARD" | "RETURN", travelMode: string) => ({ direction, travelMode });

// ── Part 1: seedLegRoutes ────────────────────────────────────────────────
describe("seedLegRoutes: mapping legs onto the request", () => {
  const single = { type: "DOMESTIC", stations: [{ from: "Bengaluru", to: "Delhi" }], departureDate: "2026-12-01", returnDate: "2026-12-04" };

  it("single station, onward + return: From/To and dates; the return is the reverse", () => {
    expect(seedLegRoutes([leg("ONWARD", "FLIGHT"), leg("RETURN", "FLIGHT")], single)).toEqual([
      { fromLocation: "Bengaluru", toLocation: "Delhi", fromDate: "2026-12-01" },
      { fromLocation: "Delhi", toLocation: "Bengaluru", fromDate: "2026-12-04" },
    ]);
  });

  it("onward only: just the onward leg", () => {
    expect(seedLegRoutes([leg("ONWARD", "TRAIN")], single)).toEqual([{ fromLocation: "Bengaluru", toLocation: "Delhi", fromDate: "2026-12-01" }]);
  });

  it("hotel / cab / visa / other stay blank and don't shift the mapping", () => {
    const out = seedLegRoutes([leg("ONWARD", "HOTEL"), leg("ONWARD", "FLIGHT"), leg("ONWARD", "CAB"), leg("RETURN", "FLIGHT"), leg("ONWARD", "VISA")], single);
    expect(out[0]).toEqual({});
    expect(out[2]).toEqual({});
    expect(out[4]).toEqual({});
    expect(out[1]).toEqual({ fromLocation: "Bengaluru", toLocation: "Delhi", fromDate: "2026-12-01" });
    expect(out[3]).toEqual({ fromLocation: "Delhi", toLocation: "Bengaluru", fromDate: "2026-12-04" });
  });

  it("multi-station domestic: the legs map to the stations in order, and the return goes home", () => {
    const multi = {
      type: "DOMESTIC",
      stations: [{ from: "Bengaluru", to: "Delhi" }, { from: "Delhi", to: "Jaipur" }, { from: "Jaipur", to: "Mumbai" }],
      departureDate: "2026-12-01",
      returnDate: "2026-12-09",
    };
    // A flight, a train, a bus, then the return flight: the seeded directions.
    const rows = [leg("ONWARD", "FLIGHT"), leg("ONWARD", "TRAIN"), leg("ONWARD", "BUS"), leg("RETURN", "FLIGHT")];
    expect(seedLegRoutes(rows, multi)).toEqual([
      { fromLocation: "Bengaluru", toLocation: "Delhi", fromDate: "2026-12-01" },
      { fromLocation: "Delhi", toLocation: "Jaipur", fromDate: undefined },
      { fromLocation: "Jaipur", toLocation: "Mumbai", fromDate: undefined },
      { fromLocation: "Mumbai", toLocation: "Bengaluru", fromDate: "2026-12-09" },
    ]);
  });

  it("a station list that already ends back home carries its own return", () => {
    const loop = { type: "DOMESTIC", stations: [{ from: "Bengaluru", to: "Delhi" }, { from: "Delhi", to: "Bengaluru" }], departureDate: "2026-12-01", returnDate: "2026-12-04" };
    expect(seedLegRoutes([leg("ONWARD", "FLIGHT"), leg("RETURN", "FLIGHT")], loop)).toEqual([
      { fromLocation: "Bengaluru", toLocation: "Delhi", fromDate: "2026-12-01" },
      { fromLocation: "Delhi", toLocation: "Bengaluru", fromDate: "2026-12-04" },
    ]);
  });

  it("legs that don't line up stay blank; a lone return still takes the return", () => {
    // Two onward flights (a connection) against one station: the onward legs
    // can't be placed, but the single return can.
    const out = seedLegRoutes([leg("ONWARD", "FLIGHT"), leg("ONWARD", "TRAIN"), leg("RETURN", "FLIGHT")], { ...single, stations: [{ from: "Bengaluru", to: "Delhi" }] });
    // 3 directional legs and 2 hops: no one-to-one.
    expect(out[0]).toEqual({});
    expect(out[1]).toEqual({});
    expect(out[2]).toEqual({ fromLocation: "Delhi", toLocation: "Bengaluru", fromDate: "2026-12-04" });
  });

  it("international: best-effort from the country names, origin left blank", () => {
    const intl = {
      type: "INTERNATIONAL",
      countries: [{ country: "Germany", fromDate: "2026-12-02", toDate: "2026-12-06" }, { country: "France", fromDate: "2026-12-06", toDate: "2026-12-09" }],
      departureDate: "2026-12-01",
      returnDate: "2026-12-10",
    };
    expect(seedLegRoutes([leg("ONWARD", "FLIGHT"), leg("ONWARD", "TRAIN"), leg("RETURN", "FLIGHT")], intl)).toEqual([
      { fromLocation: undefined, toLocation: "Germany", fromDate: "2026-12-02" },
      { fromLocation: "Germany", toLocation: "France", fromDate: "2026-12-06" },
      { fromLocation: "France", toLocation: undefined, fromDate: "2026-12-10" },
    ]);
    // A country row with no dates falls back to departureDate for the first hop.
    expect(seedLegRoutes([leg("ONWARD", "FLIGHT")], { type: "INTERNATIONAL", countries: [{ country: "Japan" }], departureDate: "2026-12-01" })).toEqual([
      { fromLocation: undefined, toLocation: "Japan", fromDate: "2026-12-01" },
    ]);
  });

  it("no request, or no stations / countries: everything blank", () => {
    expect(seedLegRoutes([leg("ONWARD", "FLIGHT")], null)).toEqual([{}]);
    expect(seedLegRoutes([leg("ONWARD", "FLIGHT")], { type: "DOMESTIC", stations: [], departureDate: "2026-12-01" })).toEqual([{}]);
    expect(seedLegRoutes([leg("ONWARD", "FLIGHT")], { type: "DOMESTIC", stations: [{ from: "  ", to: "" }] })).toEqual([{}]);
  });
});

// ── Part 2: through the routes ───────────────────────────────────────────
const DB = "cstep_qc_legprefill";
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

/** Create → approve → arrange the given extra services (each with an
 * amount, so it's booked) → mark arranged. The request's own requested
 * modes are booked too. Returns the request id. */
async function arrangedRequest(body: any, extra: Array<{ arrangedType: string; amount: number; details?: string }>): Promise<string> {
  const r = ok(await call("post", ACT.traveller, "/requests", { transportRequired: false, accommodationRequired: false, sponsored: false, ...body }));
  const id = String(r.body.request._id);
  ok(await call("post", ACT.approver, `/requests/${id}/approve`));
  const lines = ok(await call("post", ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
  for (const l of lines) {
    ok(await call("patch", ACT.official, `/requests/${id}/arrangements/${l._id}`, { amount: 5000, currency: "INR", status: "ARRANGED" }));
  }
  for (const e of extra) {
    ok(await call("post", ACT.official, `/requests/${id}/arrangements`, { currency: "INR", ...e }));
  }
  ok(await call("post", ACT.official, `/requests/${id}/mark-arranged`));
  return id;
}

describe("report/start and + Add back fill the route from the request", () => {
  let id = "";
  let legs: any[] = [];
  const byMode = (m: string, d?: string) => legs.filter((l) => l.travelMode === m && (!d || l.direction === d));

  it("single onward + return domestic: both flights get From/To + dates; hotel and cab stay blank", async () => {
    id = await arrangedRequest(
      {
        type: "DOMESTIC", purpose: "QC prefill", departureDate: "2026-12-01", returnDate: "2026-12-04",
        stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }], modesRequested: ["AIR"],
      },
      [
        { arrangedType: "HOTEL", amount: 8000 },
        { arrangedType: "FLIGHT", amount: 7600, details: "6E-512 DEL→BLR" },
        { arrangedType: "CAB", amount: 900 },
      ],
    );
    legs = ok(await call("post", ACT.traveller, `/requests/${id}/report/start`)).body.legs;
    expect(legs).toHaveLength(4);
    expect(route(byMode("FLIGHT", "ONWARD")[0])).toEqual({ fromLocation: "Bengaluru", toLocation: "Delhi", fromDate: "2026-12-01", toDate: undefined });
    expect(route(byMode("FLIGHT", "RETURN")[0])).toEqual({ fromLocation: "Delhi", toLocation: "Bengaluru", fromDate: "2026-12-04", toDate: undefined });
    for (const l of [...byMode("HOTEL"), ...byMode("CAB")]) {
      expect(route(l)).toEqual({ fromLocation: undefined, toLocation: undefined, fromDate: undefined, toDate: undefined });
    }
  });

  it("a traveller's edit is kept: a second report/start doesn't re-seed over it", async () => {
    const onward = byMode("FLIGHT", "ONWARD")[0];
    ok(await call("patch", ACT.traveller, `/requests/${id}/report/legs/${onward._id}`, { fromLocation: "Mysuru", fromDate: "2026-11-30" }));
    ok(await call("post", ACT.traveller, `/requests/${id}/report/start`));
    legs = ok(await call("get", ACT.traveller, `/requests/${id}/report`)).body.legs;
    expect(legs).toHaveLength(4);
    expect(route(byMode("FLIGHT", "ONWARD")[0])).toEqual({ fromLocation: "Mysuru", toLocation: "Delhi", fromDate: "2026-11-30", toDate: undefined });
  });

  it("+ Add back restores the removed return flight with its route", async () => {
    const ret = byMode("FLIGHT", "RETURN")[0];
    ok(await call("delete", ACT.traveller, `/requests/${id}/report/legs/${ret._id}`));
    const back = ok(await call("post", ACT.traveller, `/requests/${id}/report/legs`, { direction: "RETURN", arrangementId: ret.arrangementId })).body.leg;
    expect(back.source).toBe("SEEDED");
    expect(route(back)).toEqual({ fromLocation: "Delhi", toLocation: "Bengaluru", fromDate: "2026-12-04", toDate: undefined });
  });

  it("+ Add back in the other direction leaves the route blank for the traveller", async () => {
    legs = ok(await call("get", ACT.traveller, `/requests/${id}/report`)).body.legs;
    const ret = byMode("FLIGHT", "RETURN")[0];
    ok(await call("delete", ACT.traveller, `/requests/${id}/report/legs/${ret._id}`));
    const back = ok(await call("post", ACT.traveller, `/requests/${id}/report/legs`, { direction: "ONWARD", arrangementId: ret.arrangementId })).body.leg;
    expect(route(back)).toEqual({ fromLocation: undefined, toLocation: undefined, fromDate: undefined, toDate: undefined });
  });

  it("multi-station domestic: the legs land on the stations in order", async () => {
    const mid = await arrangedRequest(
      {
        type: "DOMESTIC", purpose: "QC prefill multi", departureDate: "2026-12-01", returnDate: "2026-12-09",
        stations: [{ from: "Bengaluru", to: "Delhi" }, { from: "Delhi", to: "Jaipur" }], modesRequested: ["AIR"],
      },
      [
        { arrangedType: "TRAIN", amount: 1200 },
        { arrangedType: "FLIGHT", amount: 6900 },
      ],
    );
    const ml = ok(await call("post", ACT.traveller, `/requests/${mid}/report/start`)).body.legs;
    expect(ml.map((l: any) => [l.direction, l.travelMode, l.fromLocation, l.toLocation, l.fromDate])).toEqual([
      ["ONWARD", "FLIGHT", "Bengaluru", "Delhi", "2026-12-01"],
      ["ONWARD", "TRAIN", "Delhi", "Jaipur", undefined],
      ["RETURN", "FLIGHT", "Jaipur", "Bengaluru", "2026-12-09"],
    ]);
  });

  it("international: filled from the country names", async () => {
    const iid = await arrangedRequest(
      {
        type: "INTERNATIONAL", purpose: "QC prefill intl", justification: "QC conference", departureDate: "2026-12-02", returnDate: "2026-12-08",
        countries: [{ country: "Germany", fromDate: "2026-12-02", toDate: "2026-12-08" }], modesRequested: ["AIR"],
      },
      [{ arrangedType: "FLIGHT", amount: 41000 }],
    );
    const il = ok(await call("post", ACT.traveller, `/requests/${iid}/report/start`)).body.legs;
    expect(il.map((l: any) => [l.direction, l.fromLocation, l.toLocation, l.fromDate])).toEqual([
      ["ONWARD", undefined, "Germany", "2026-12-02"],
      ["RETURN", "Germany", undefined, "2026-12-08"],
    ]);
  });

  it("legacy legs (seeded before this change, blank route) are left as they are", async () => {
    const lid = await arrangedRequest(
      {
        type: "DOMESTIC", purpose: "QC prefill legacy", departureDate: "2026-12-01", returnDate: "2026-12-04",
        stations: [{ from: "Bengaluru", to: "Chennai" }], modesRequested: ["AIR"],
      },
      [],
    );
    // Move it to REPORT_PENDING with an old-style seeded leg, written raw, as
    // the previous build left it.
    const [arr] = await col("csteparrangements").find({ requestId: new mongoose.Types.ObjectId(lid) }).toArray();
    await col("csteptravelrequests").updateOne({ _id: new mongoose.Types.ObjectId(lid) }, { $set: { status: "REPORT_PENDING" } });
    const legacyId = oid();
    await col("cstepreportlegs").insertOne({
      _id: legacyId, workspaceId: WS, requestId: new mongoose.Types.ObjectId(lid), direction: "ONWARD", travelMode: "FLIGHT",
      fare: 5000, currency: "INR", paidBy: "CSTEP", source: "SEEDED", arrangementId: arr._id, createdBy: U.traveller,
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    const ll = ok(await call("post", ACT.traveller, `/requests/${lid}/report/start`)).body.legs;
    expect(ll).toHaveLength(1);
    expect(String(ll[0]._id)).toBe(String(legacyId));
    expect(route(ll[0])).toEqual({ fromLocation: undefined, toLocation: undefined, fromDate: undefined, toDate: undefined });
    const raw = await col("cstepreportlegs").findOne({ _id: legacyId });
    expect(raw).not.toHaveProperty("fromLocation");
    expect(raw).not.toHaveProperty("fromDate");
  });
});
