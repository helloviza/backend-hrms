// apps/backend/src/routes/vouchers.extractMeta.test.ts
//
// POST /api/vouchers/extract stores timings and whether the route's repair
// pass ran on a SUCCESS record (meta.extract), keeps them across a re-render,
// and never lets that bookkeeping touch FAILED records.
//
// Real: vouchers router, VoucherExtraction model, in-memory Mongo. Stubbed:
// guards, S3, the shared Gemini extractor (called, never changed) and the PDF
// renderer.
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
    req.workspaceId = id;
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
    req.workspace = { _id: req.workspaceObjectId, customerId: null };
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
vi.mock("../services/voucherLambdaRenderer.js", () => ({
  VOUCHER_RENDER_VIA_LAMBDA: false,
  invokeRendererLambda: async () => Buffer.from("%PDF"),
}));
const renderMock = vi.fn(async () => Buffer.from("%PDF-1.4"));
vi.mock("../services/pdfService.js", () => ({ generateTravelPDF: (...a: any[]) => renderMock(...(a as [])) }));

/** Each call returns the next queued result: a complete or an incomplete hotel. */
const extractQueue: any[] = [];
const extractMock = vi.fn(async () => extractQueue.shift());
vi.mock("../services/voucherExtractorGemini.js", () => ({
  extractVoucherViaGemini: (...a: any[]) => extractMock(...(a as [])),
}));

const { default: vouchersRouter } = await import("./vouchers.js");

const app = express();
app.use(express.json());
app.use("/api/vouchers", vouchersRouter);

let mongod: MongoMemoryServer;
const WS = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const as = (r: request.Test) =>
  r.set("x-test-user", JSON.stringify({ _id: String(USER), roles: ["ADMIN"] })).set("x-test-ws", String(WS));

const completeHotel = {
  parsed: {
    type: "hotel",
    booking_info: { custom_logo: "https://logo/x.png", booking_id: "BK-1" },
    hotel_details: { name: "Taj", city: "Bhopal" },
    stay_details: { check_in_date: "12 Nov 2026", check_out_date: "15 Nov 2026" },
    room_details: { room_type: "Deluxe" },
    guest_details: { primary_guest: "Asha Rao" },
    policies: { important_notes: [] },
  },
  raw: { raw_candidate: {}, model: "test" },
};
/** No logo: validateForRender blocks on it, which triggers the route's repair pass. */
const blockedHotel = {
  parsed: { ...completeHotel.parsed, booking_info: { booking_id: "BK-1" } },
  raw: { raw_candidate: {}, model: "test" },
};

const upload = () =>
  as(request(app).post("/api/vouchers/extract"))
    .field("voucherType", "hotel")
    .attach("file", Buffer.from("%PDF-1.4 source"), { filename: "v.pdf", contentType: "application/pdf" });

const stored = async (id: string) =>
  (await mongoose.connection.db!.collection("voucherextractions").findOne({ _id: new mongoose.Types.ObjectId(id) })) as any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("voucher-extract-meta-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  extractQueue.length = 0;
  extractMock.mockClear();
  renderMock.mockReset();
  renderMock.mockImplementation(async () => Buffer.from("%PDF-1.4"));
});

describe("meta.extract on SUCCESS", () => {
  it("stores extract / render / total ms, and no repair pass", async () => {
    extractQueue.push(completeHotel);
    const r = await upload();
    expect(r.status).toBe(200);
    const row = await stored(r.body.id);
    expect(row.status).toBe("SUCCESS");
    expect(row.meta.extract).toEqual({
      extractMs: expect.any(Number),
      renderMs: expect.any(Number),
      totalMs: expect.any(Number),
      repairPassUsed: false,
    });
    const m = row.meta.extract;
    expect(m.totalMs).toBeGreaterThanOrEqual(m.extractMs + m.renderMs);
    expect(Array.isArray(row.meta.renderWarnings)).toBe(true); // the render's own meta survives
    expect(extractMock).toHaveBeenCalledTimes(1);
  });

  it("records that the route's repair pass ran", async () => {
    extractQueue.push(blockedHotel, completeHotel);
    const r = await upload();
    expect(r.status).toBe(200);
    expect((await stored(r.body.id)).meta.extract.repairPassUsed).toBe(true);
    expect(extractMock).toHaveBeenCalledTimes(2);
  });

  it("still records timings when the render fails (extraction stays SUCCESS)", async () => {
    renderMock.mockImplementation(async () => {
      throw new Error("pdf boom");
    });
    extractQueue.push(completeHotel);
    const r = await upload();
    const row = await stored(r.body.id);
    expect(row.status).toBe("SUCCESS");
    expect(row.errorDetails.stage).toBe("RENDER_PDF_FAILED");
    expect(row.meta.extract.renderMs).toEqual(expect.any(Number));
    expect(row.meta.extract.repairPassUsed).toBe(false);
  });

  it("a re-render keeps meta.extract", async () => {
    extractQueue.push(completeHotel);
    const r = await upload();
    const before = (await stored(r.body.id)).meta.extract;
    const rr = await as(request(app).post(`/api/vouchers/${r.body.id}/render`));
    expect(rr.status).toBe(200);
    expect((await stored(r.body.id)).meta.extract).toEqual(before);
  });

  it("a FAILED extraction gets no meta.extract", async () => {
    extractQueue.push(blockedHotel, blockedHotel);
    const r = await upload();
    expect(r.status).toBe(422);
    const row = await stored(r.body.id);
    expect(row.status).toBe("FAILED");
    expect(row.meta?.extract).toBeUndefined();
  });
});
