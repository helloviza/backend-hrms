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
const s3UploadMock = vi.fn(async (_opts: any) => ({ bucket: "b", key: "k", url: "u" }));
vi.mock("../utils/s3Upload.js", () => ({ uploadBufferToS3: (o: any) => s3UploadMock(o), deleteObject: async () => {} }));
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

describe("voucher prompt variant", () => {
  it("both the first call and the route's repair pass ask for the voucher variant", async () => {
    extractQueue.push(blockedHotel, completeHotel);
    await upload();
    expect(extractMock).toHaveBeenCalledTimes(2);
    for (const call of extractMock.mock.calls as any[]) expect(call[0].promptVariant).toBe("voucher");
  });

  it("GET /:id gives the Summary the PDF's cancellation lines and three-state refundability", async () => {
    extractQueue.push(completeHotel);
    const r = await upload();
    const got = await as(request(app).get(`/api/vouchers/${r.body.id}`));
    expect(got.body.displayDates.checkIn.yearAssumed).toBe(false);
    expect(got.body.displayDates.cancellation.lines).toEqual([{ text: "As per supplier policy — contact support", tone: "info", kind: "info" }]);
    expect(got.body.statedNonRefundable).toBeNull();
  });
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

describe("retention hooks in the route", () => {
  it("a re-render and a correction list the replaced PDF in supersededRenders (F-08)", async () => {
    extractQueue.push(completeHotel);
    const r = await upload();
    const first = (await stored(r.body.id)).renderedS3.key;
    await as(request(app).post(`/api/vouchers/${r.body.id}/render`));
    let row = await stored(r.body.id);
    expect(row.supersededRenders.map((s: any) => s.key)).toEqual([first]);
    await as(request(app).patch(`/api/vouchers/${r.body.id}`)).send({ extractedJson: row.extractedJson });
    row = await stored(r.body.id);
    expect(row.supersededRenders).toHaveLength(2);
    expect(row.renderedS3).toBeUndefined();
  });

  it("a removed source / PDF answers 410 with the removal date; a removed PDF is not 'Not rendered'", async () => {
    extractQueue.push(completeHotel);
    const r = await upload();
    const when = new Date("2026-10-20T06:00:00Z");
    await mongoose.connection.db!.collection("voucherextractions").updateOne(
      { _id: new mongoose.Types.ObjectId(r.body.id) },
      { $set: { sourceDeletedAt: when, renderDeletedAt: when }, $unset: { renderedS3: "" } },
    );
    const src = await as(request(app).get(`/api/vouchers/${r.body.id}/open`));
    expect(src.status).toBe(410);
    expect(src.body.message).toBe("Removed on 20 Oct 2026 (retention policy)");
    const pdf = await as(request(app).get(`/api/vouchers/${r.body.id}/open-rendered`));
    expect(pdf.status).toBe(410);
    expect(pdf.body.message).toMatch(/^Removed on 20 Oct 2026 \(retention policy\)/);

    const counts = await as(request(app).get(`/api/vouchers/counts`));
    expect(counts.body.notRendered).toBe(0);
    const q = await as(request(app).get(`/api/vouchers/queue`));
    expect(q.body.items[0]).toMatchObject({ rendered: false, renderRemovedAt: when.toISOString() });

    // Regenerate PDF = the ordinary render route, from the JSON
    const rr = await as(request(app).post(`/api/vouchers/${r.body.id}/render`));
    expect(rr.status).toBe(200);
    expect((await stored(r.body.id)).renderedS3.key).toBeTruthy();
  });
});

describe("upload file check (F-14)", () => {
  const send = (buf: Buffer, filename: string, contentType: string) =>
    as(request(app).post("/api/vouchers/extract")).field("voucherType", "hotel").attach("file", buf, { filename, contentType });

  it("a non-voucher file is refused with a clear message before S3 or Gemini", async () => {
    s3UploadMock.mockClear();
    const r = await send(Buffer.from("PK word doc"), "booking.pdf", "application/pdf");
    expect(r.status).toBe(415);
    expect(r.body).toEqual({
      message: "booking.pdf isn't a PDF, JPEG, PNG or WEBP file. Upload the supplier voucher as a PDF or as a JPEG, PNG or WEBP image.",
      code: "UNSUPPORTED_FILE_TYPE",
    });
    expect(s3UploadMock).not.toHaveBeenCalled();
    expect(extractMock).not.toHaveBeenCalled();
    expect(await mongoose.connection.db!.collection("voucherextractions").countDocuments()).toBe(0);
  });

  it("the type read from the bytes replaces the browser's claim (S3, record, model)", async () => {
    s3UploadMock.mockClear();
    extractQueue.push(completeHotel);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const r = await send(png, "scan.pdf", "application/pdf");
    expect(r.status).toBe(200);
    expect(s3UploadMock.mock.calls[0][0].mime).toBe("image/png");
    expect((extractMock.mock.calls[0] as any)[0].mimeType).toBe("image/png");
    expect((await stored(r.body.id)).file.mime).toBe("image/png");
  });
});

describe("stuck PROCESSING on page load (F-05)", () => {
  it("/counts fails records PROCESSING for 15+ minutes first, so Processing (which drives polling) drops to 0", async () => {
    const col = mongoose.connection.db!.collection("voucherextractions");
    const base = {
      workspaceId: WS, createdBy: USER, docType: "hotel", status: "PROCESSING",
      s3: { bucket: "b", key: "k", url: "u" }, file: { originalName: "v.pdf", mime: "application/pdf", size: 1 },
    };
    const otherWs = new mongoose.Types.ObjectId();
    const { insertedIds } = await col.insertMany([
      { ...base, createdAt: new Date(Date.now() - 20 * 60_000) },
      { ...base, createdAt: new Date(Date.now() - 60_000) },
      { ...base, workspaceId: otherWs, createdAt: new Date(Date.now() - 20 * 60_000) },
    ]);
    const c = await as(request(app).get("/api/vouchers/counts"));
    expect(c.body.processing).toBe(1);
    expect(c.body.failed).toBe(1);
    expect(await col.findOne({ _id: insertedIds[0] })).toMatchObject({ status: "FAILED", error: "Timed out" });
    expect((await col.findOne({ _id: insertedIds[1] }))!.status).toBe("PROCESSING");
    // another workspace's record is not this caller's to touch
    expect((await col.findOne({ _id: insertedIds[2] }))!.status).toBe("PROCESSING");
  });
});

describe("no trip date (retention fix 3)", () => {
  it("the render flags it, so it lands in Needs review and stays flagged across re-renders", async () => {
    extractQueue.push({ ...completeHotel, parsed: { ...completeHotel.parsed, stay_details: {} } });
    const r = await upload();
    expect((await stored(r.body.id)).meta.renderWarnings).toContain("Trip date unknown — files kept until reviewed");
    await as(request(app).post(`/api/vouchers/${r.body.id}/render`));
    expect((await stored(r.body.id)).meta.renderWarnings).toContain("Trip date unknown — files kept until reviewed");
    const q = await as(request(app).get("/api/vouchers/queue?review=needs_review"));
    expect(q.body.items.map((i: any) => i._id)).toContain(r.body.id);
  });
});
