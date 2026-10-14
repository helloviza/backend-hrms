// apps/backend/src/routes/vouchers.queue.test.ts
//
// The voucher page's list (GET /queue) and stat cards (GET /counts):
//   - list rows are lean: no extractedJson / rawModelResponse / errorDetails
//   - workspace scoping: a caller sees only their own workspace; a SUPERADMIN
//     sees every workspace (the explicit `{}` scope)
//   - Needs review: the list filter, the per-card flag and the count agree
//   - Not rendered is its own filter and is not part of Needs review
//   - search over the card summary, paging
//
// Real: vouchers router, VoucherExtraction model, in-memory Mongo. Stubbed:
// auth / workspace / permission guards (identity from headers), S3.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    const id = String(req.headers["x-test-ws"] || "");
    if (id) {
      req.workspaceId = id;
      req.workspaceObjectId = new mongoose.Types.ObjectId(id);
      req.workspace = { _id: req.workspaceObjectId, customerId: null };
    }
    next();
  },
  requireResolvedWorkspace: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireFeature.js", () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
  requireAnyFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/s3Upload.js", () => ({ uploadBufferToS3: async () => ({ bucket: "b", key: "k", url: "u" }), deleteObject: async () => {} }));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: async () => "signed://x" }));
vi.mock("../config/aws.js", () => ({ s3: { send: async () => ({}) } }));

const { default: vouchersRouter } = await import("./vouchers.js");
const { default: VoucherExtraction } = await import("../models/VoucherExtraction.js");

const app = express();
app.use(express.json());
app.use("/api/vouchers", vouchersRouter);

let mongod: MongoMemoryServer;
const col = () => mongoose.connection.db!.collection("voucherextractions");
const oid = () => new mongoose.Types.ObjectId();

const WS_A = oid();
const WS_B = oid();
const USER = oid();
const opsA = { _id: String(USER), roles: ["ADMIN"] };
const superadmin = { _id: String(USER), roles: ["SUPERADMIN"] };
const asA = (r: request.Test) => r.set("x-test-user", JSON.stringify(opsA)).set("x-test-ws", String(WS_A));
const asSuper = (r: request.Test) => r.set("x-test-user", JSON.stringify(superadmin));

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const rendered = { bucket: "b", key: "rendered.pdf", url: "u" };

/** Raw documents, inserted as prod stores them (fields absent, not null). */
function hotel(over: Record<string, any> = {}) {
  return {
    workspaceId: WS_A, createdBy: USER, docType: "hotel", status: "SUCCESS",
    s3: { bucket: "b", key: "src", url: "u" },
    file: { originalName: "taj.pdf", mime: "application/pdf", size: 1234 },
    extractedJson: {
      type: "hotel",
      hotel_details: { name: "Taj Lakefront", city: "Bhopal" },
      stay_details: { check_in_date: "12 Nov", check_out_date: "15 Nov", total_nights: 3 },
      guest_details: { primary_guest: "Asha Rao", total_pax: 2, all_guest_names: ["Asha Rao", "Vikram Rao"] },
      booking_info: { booking_id: "BK-77", pnr: null, voucher_no: "V-9" },
      policies: { important_notes: [] },
    },
    rawModelResponse: { raw_candidate: "x".repeat(500) },
    renderedS3: rendered,
    createdAt: ago(1),
    ...over,
  };
}
function flight(over: Record<string, any> = {}) {
  return {
    workspaceId: WS_A, createdBy: USER, docType: "flight", status: "SUCCESS",
    s3: { bucket: "b", key: "src", url: "u" },
    file: { originalName: "6e.pdf", mime: "application/pdf", size: 999 },
    extractedJson: {
      type: "flight",
      flight_details: {
        segments: [
          { flight_no: "6E-2802", origin: { code: "BLR", date: "14 Jun" }, destination: { code: "DEL" } },
          { flight_no: "6E-118", origin: { code: "DEL" }, destination: { code: "BHO" } },
        ],
      },
      passengers: [{ name: "Neel Bhatia" }],
      booking_info: { pnr: "QX7ZPL" },
      policies: { important_notes: [] },
    },
    rawModelResponse: { raw_candidate: "y" },
    renderedS3: rendered,
    createdAt: ago(2),
    ...over,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("voucher-queue-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

describe("GET /api/vouchers/queue — lean rows", () => {
  it("carries the card summary and nothing heavy", async () => {
    await col().insertMany([hotel(), flight()]);
    const r = await asA(request(app).get("/api/vouchers/queue"));
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain("rawModelResponse");
    expect(raw).not.toContain("extractedJson");
    expect(raw).not.toContain("errorDetails");
    expect(raw).not.toContain("raw_candidate");

    const [h, f] = r.body.items; // newest first: hotel is 1 day old, flight 2
    expect(h.docType).toBe("hotel");
    expect(h.summary).toEqual({
      pnr: null, bookingRef: "BK-77", hotel: "Taj Lakefront", city: "Bhopal",
      checkIn: "12 Nov", checkOut: "15 Nov", nights: 3, leadGuest: "Asha Rao", paxCount: 2,
    });
    expect(h.rendered).toBe(true);
    expect(h.createdByName).toBeTruthy();
    expect(f.docType).toBe("flight");
    expect(f.summary).toEqual({
      pnr: "QX7ZPL", bookingRef: null, from: "BLR", to: "BHO", route: ["BLR", "DEL", "BHO"], flightNos: ["6E-2802", "6E-118"],
      departDate: "14 Jun", leadGuest: "Neel Bhatia", paxCount: 1,
    });
  });

  it("a round trip keeps its turning point in the route", async () => {
    const seg = (no: string, from: string, to: string) => ({ flight_no: no, origin: { code: from }, destination: { code: to } });
    await col().insertOne(flight({ extractedJson: { type: "flight", flight_details: { segments: [seg("AI 2993", "BOM", "GOI"), seg("AI 2994", "GOI", "BOM")] } } }));
    const r = await asA(request(app).get("/api/vouchers/queue"));
    expect(r.body.items[0].summary.route).toEqual(["BOM", "GOI", "BOM"]);
  });

  it("a field the voucher didn't state is null, never a placeholder", async () => {
    await col().insertOne(hotel({ extractedJson: { type: "hotel", hotel_details: { name: "N/A" } } }));
    const r = await asA(request(app).get("/api/vouchers/queue"));
    expect(r.body.items[0].summary.hotel).toBeNull();
    expect(r.body.items[0].summary.nights).toBeNull();
  });
});

describe("workspace scoping", () => {
  beforeEach(async () => {
    await col().insertMany([
      hotel({ file: { originalName: "a-hotel.pdf", mime: "application/pdf", size: 1 } }),
      flight({ workspaceId: WS_B, status: "FAILED", file: { originalName: "b-flight.pdf", mime: "application/pdf", size: 1 } }),
    ]);
  });

  it("a workspace caller never sees another workspace's rows", async () => {
    const r = await asA(request(app).get("/api/vouchers/queue"));
    expect(r.body.items.map((i: any) => i.file.originalName)).toEqual(["a-hotel.pdf"]);
    expect(r.body.total).toBe(1);
    // ...not even through a filter or a search that would match it
    const failed = await asA(request(app).get("/api/vouchers/queue?status=FAILED&q=b-flight"));
    expect(failed.body.items).toEqual([]);
    const review = await asA(request(app).get("/api/vouchers/queue?review=needs_review"));
    expect(review.body.items).toEqual([]);
  });

  it("a SUPERADMIN reads across workspaces", async () => {
    const r = await asSuper(request(app).get("/api/vouchers/queue"));
    expect(r.body.items.map((i: any) => i.file.originalName).sort()).toEqual(["a-hotel.pdf", "b-flight.pdf"]);
  });
});

describe("Needs review / Not rendered", () => {
  /** One record per case, named by file. */
  async function seed() {
    const named = (name: string) => ({ file: { originalName: name, mime: "application/pdf", size: 1 } });
    await col().insertMany([
      hotel({ ...named("ok") }),
      hotel({ ...named("failed"), status: "FAILED", renderedS3: undefined, extractedJson: undefined }),
      hotel({ ...named("render-failed"), renderedS3: undefined, errorDetails: { stage: "RENDER_PDF_FAILED" } }),
      hotel({ ...named("render-failed-manual"), renderedS3: undefined, errorDetails: { stage: "RENDER_PDF_FAILED_MANUAL" } }),
      // failed once, re-rendered fine later: errorDetails is never cleared
      hotel({ ...named("render-failed-then-fixed"), errorDetails: { stage: "RENDER_PDF_FAILED" } }),
      hotel({ ...named("warnings"), meta: { renderWarnings: ["Check-in year inferred"] } }),
      hotel({ ...named("empty-warnings"), meta: { renderWarnings: [] } }),
      hotel({ ...named("not-rendered"), renderedS3: undefined }),
      flight({ ...named("processing"), status: "PROCESSING", renderedS3: undefined, extractedJson: undefined }),
    ].map((d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined))));
  }
  const names = (r: any) => r.body.items.map((i: any) => i.file.originalName).sort();

  it("the filter is FAILED, render failed (no PDF), or render warnings — and not 'not rendered'", async () => {
    await seed();
    const r = await asA(request(app).get("/api/vouchers/queue?review=needs_review"));
    expect(names(r)).toEqual(["failed", "render-failed", "render-failed-manual", "warnings"]);
  });

  it("each card's flag and reasons come from the same rule", async () => {
    await seed();
    const r = await asA(request(app).get("/api/vouchers/queue"));
    const byName = Object.fromEntries(r.body.items.map((i: any) => [i.file.originalName, i]));
    const flagged = Object.keys(byName).filter((n) => byName[n].needsReview).sort();
    expect(flagged).toEqual(["failed", "render-failed", "render-failed-manual", "warnings"]);
    expect(byName["failed"].reviewReasons).toEqual(["failed"]);
    expect(byName["render-failed"].reviewReasons).toEqual(["render_failed"]);
    expect(byName["warnings"].reviewReasons).toEqual(["warnings"]);
    expect(byName["warnings"].renderWarningCount).toBe(1);
    expect(byName["not-rendered"].needsReview).toBe(false);
  });

  it("Not rendered = extracted with no PDF (overlaps render failed, never FAILED or PROCESSING)", async () => {
    await seed();
    const r = await asA(request(app).get("/api/vouchers/queue?review=not_rendered"));
    expect(names(r)).toEqual(["not-rendered", "render-failed", "render-failed-manual"]);
  });
});

describe("filters, search, paging", () => {
  it("status and type filters", async () => {
    await col().insertMany([hotel(), flight(), flight({ status: "FAILED" })]);
    expect((await asA(request(app).get("/api/vouchers/queue?type=flight"))).body.total).toBe(2);
    expect((await asA(request(app).get("/api/vouchers/queue?type=flight&status=FAILED"))).body.total).toBe(1);
    // unknown values are ignored, not errors
    expect((await asA(request(app).get("/api/vouchers/queue?type=combo&status=x"))).body.total).toBe(3);
  });

  it("searches the summary fields, case-insensitively, with regex characters escaped", async () => {
    await col().insertMany([hotel(), flight()]);
    const q = async (s: string) =>
      (await asA(request(app).get(`/api/vouchers/queue?q=${encodeURIComponent(s)}`))).body.items.map((i: any) => i.docType);
    expect(await q("qx7zpl")).toEqual(["flight"]); // PNR
    expect(await q("bhopal")).toEqual(["hotel"]); // city
    expect(await q("Vikram")).toEqual(["hotel"]); // any guest
    expect(await q("6E-118")).toEqual(["flight"]); // second segment
    expect(await q("BK-77")).toEqual(["hotel"]); // booking id
    expect(await q("taj.pdf")).toEqual(["hotel"]); // file name
    expect(await q(".*")).toEqual([]); // literal, not a regex
    expect(await q("nothing-matches")).toEqual([]);
  });

  it("pages newest first, with the filtered total", async () => {
    await col().insertMany(Array.from({ length: 7 }, (_, i) => hotel({ createdAt: ago(i), file: { originalName: `h${i}`, mime: "m", size: 1 } })));
    const p1 = await asA(request(app).get("/api/vouchers/queue?limit=3&page=1"));
    const p3 = await asA(request(app).get("/api/vouchers/queue?limit=3&page=3"));
    expect(p1.body).toMatchObject({ page: 1, limit: 3, total: 7 });
    expect(p1.body.items.map((i: any) => i.file.originalName)).toEqual(["h0", "h1", "h2"]);
    expect(p3.body.items.map((i: any) => i.file.originalName)).toEqual(["h6"]);
    expect((await asA(request(app).get("/api/vouchers/queue?limit=5000"))).body.limit).toBe(100);
  });
});

describe("legacy GET /api/vouchers (kept for the deploy gap)", () => {
  it("keeps its array shape but no longer ships the raw model response", async () => {
    await col().insertOne(hotel());
    const r = await asA(request(app).get("/api/vouchers"));
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body[0].extractedJson).toBeTruthy(); // the old page edits it
    expect(r.body[0]).not.toHaveProperty("rawModelResponse");
  });
});

describe("index", () => {
  it("declares {workspaceId, createdAt} for the queue", () => {
    const keys = VoucherExtraction.schema.indexes().map(([k]) => JSON.stringify(k));
    expect(keys).toContain(JSON.stringify({ workspaceId: 1, createdAt: -1 }));
  });
});

describe("GET /api/vouchers/counts — the stat cards", () => {
  async function seedCounts() {
    await col().insertMany([
      hotel({ createdAt: ago(1) }),
      hotel({ createdAt: ago(10), meta: { renderWarnings: ["Check-out year inferred"] } }),
      flight({ createdAt: ago(3), status: "FAILED" }),
      flight({ createdAt: ago(40) }),
      hotel({ createdAt: ago(2), status: "PROCESSING" }),
      // another workspace — must never be counted for WS_A
      hotel({ workspaceId: WS_B, createdAt: ago(1), status: "FAILED" }),
    ]);
    await col().insertOne(
      Object.fromEntries(Object.entries(hotel({ createdAt: ago(5) })).filter(([k]) => k !== "renderedS3")),
    );
  }

  it("counts within the caller's workspace only", async () => {
    await seedCounts();
    const r = await asA(request(app).get("/api/vouchers/counts"));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      total: 6, extracted: 4, failed: 1, processing: 1,
      needsReview: 2, notRendered: 1, hotel: 4, flight: 2,
      last7: { total: 4, hotel: 3, flight: 1 },
      last30: { total: 5 },
    });
  });

  it("a SUPERADMIN's counts span every workspace", async () => {
    await seedCounts();
    const r = await asSuper(request(app).get("/api/vouchers/counts"));
    expect(r.body.total).toBe(7);
    expect(r.body.failed).toBe(2);
    expect(r.body.needsReview).toBe(3);
  });

  it("the Needs-review card and the Needs-review filter always agree", async () => {
    await seedCounts();
    for (const as of [asA, asSuper]) {
      const counts = await as(request(app).get("/api/vouchers/counts"));
      const list = await as(request(app).get("/api/vouchers/queue?review=needs_review"));
      expect(list.body.total).toBe(counts.body.needsReview);
      const notRendered = await as(request(app).get("/api/vouchers/queue?review=not_rendered"));
      expect(notRendered.body.total).toBe(counts.body.notRendered);
    }
  });
});
