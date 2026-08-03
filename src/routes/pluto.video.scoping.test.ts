// Phase 3 — video registration fix + tenant-isolation guard.
//
// Two defects, both proven here:
//  1. VideoAnalysis.create() omitted workspaceId, which the schema marks
//     required → every /register threw ValidationError → 500 "Failed to
//     register video". The whole video feature was dark.
//  2. /status and /context filtered on the legacy `tenantId`, which
//     resolveTenantId() collapsed to the literal "staff" for EVERY internal
//     user — so any staff member could read any other staff member's video
//     analysis. The consumer (copilot.travel.ts) meanwhile queried by
//     workspaceId, so writer and reader disagreed about what a tenant was.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const H = vi.hoisted(() => ({ create: vi.fn(), findOne: vi.fn() }));

vi.mock("../models/VideoAnalysis.js", () => ({
  default: { create: H.create, findOne: H.findOne },
}));
vi.mock("../services/video/startVideoAnalysis.js", () => ({ startVideoAnalysis: vi.fn() }));
vi.mock("../middleware/auth.js", () => ({
  default: (_req: any, _res: any, next: any) => next(),
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class {}, PutObjectCommand: class {} }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));

import express from "express";
import request from "supertest";
import router from "./pluto.video.js";

const WS_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const WS_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

/** App acting as a user of the given workspace (requireWorkspace does this in prod). */
function appFor(workspaceId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { sub: "u1", _id: "u1" };
    req.workspaceObjectId = workspaceId;
    req.workspaceId = workspaceId;
    next();
  });
  app.use("/", router);
  return app;
}

/**
 * Stand-in for Mongo that HONOURS the filter. If the route forgets to scope by
 * workspaceId, this returns the other tenant's row and the isolation test fails
 * — which is the whole point.
 */
function seed(rows: any[]) {
  H.findOne.mockImplementation((filter: any) => ({
    select: () => ({
      lean: async () =>
        rows.find(
          (r) =>
            String(r._id) === String(filter._id) &&
            (filter.workspaceId === undefined ||
              String(r.workspaceId) === String(filter.workspaceId)),
        ) ?? null,
    }),
    lean: async () =>
      rows.find(
        (r) =>
          String(r._id) === String(filter._id) &&
          (filter.workspaceId === undefined ||
            String(r.workspaceId) === String(filter.workspaceId)),
      ) ?? null,
  }));
}

beforeEach(() => {
  H.create.mockReset();
  H.findOne.mockReset();
});

describe("POST /register — the 500 is gone", () => {
  it("passes workspaceId, so the required field is satisfied", async () => {
    H.create.mockResolvedValue({ _id: "v1", status: "processing" });
    const res = await request(appFor(WS_A))
      .post("/register")
      .send({ s3Key: "videos/x.mp4", originalFileName: "x.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const payload = H.create.mock.calls[0][0];
    expect(String(payload.workspaceId)).toBe(WS_A);
    // The legacy key must not be written alongside — one source of truth.
    expect(payload.tenantId).toBeUndefined();
  });

  it("the payload the route builds now PASSES real schema validation", async () => {
    // Exercised against the REAL Mongoose schema (no DB connection needed):
    // validateSync() is exactly what create() runs before hitting Mongo.
    const { default: RealVideoAnalysis } = await vi.importActual<any>(
      "../models/VideoAnalysis.js",
    );

    const withoutWorkspace = new RealVideoAnalysis({
      userId: new mongoose.Types.ObjectId(),
      s3Key: "videos/x.mp4",
      status: "processing",
      progress: 0,
    });
    // This is the ValidationError that became the 500.
    expect(withoutWorkspace.validateSync()?.errors?.workspaceId).toBeTruthy();

    const withWorkspace = new RealVideoAnalysis({
      workspaceId: new mongoose.Types.ObjectId(WS_A),
      userId: new mongoose.Types.ObjectId(),
      s3Key: "videos/y.mp4",
      status: "processing",
      progress: 0,
    });
    expect(withWorkspace.validateSync()).toBeUndefined();
  });
});

describe("CROSS-TENANT ISOLATION — workspace A cannot read workspace B's video", () => {
  const videoOfB = {
    _id: "vB",
    workspaceId: WS_B,
    status: "analyzed",
    progress: 100,
    updatedAt: new Date(),
    insights: { destinations: [{ city: "Bali", country: "Indonesia", confidence: 0.9 }] },
    injectedContext: { secret: "workspace B trip signals" },
    transcript: "B's private transcript",
  };

  it("GET /:id/status — B's video is 404 to A, and readable to B", async () => {
    seed([videoOfB]);

    const leak = await request(appFor(WS_A)).get("/vB/status");
    expect(leak.status).toBe(404);
    expect(JSON.stringify(leak.body)).not.toContain("analyzed");

    const own = await request(appFor(WS_B)).get("/vB/status");
    expect(own.status).toBe(200);
    expect(own.body.status).toBe("analyzed");
  });

  it("GET /:id/context — B's insights never reach A", async () => {
    seed([videoOfB]);

    const leak = await request(appFor(WS_A)).get("/vB/context");
    expect(leak.status).toBe(404);
    const body = JSON.stringify(leak.body);
    expect(body).not.toContain("Bali");
    expect(body).not.toContain("workspace B trip signals");
    expect(body).not.toContain("private transcript");

    const own = await request(appFor(WS_B)).get("/vB/context");
    expect(own.status).toBe(200);
    expect(own.body.insights.destinations[0].city).toBe("Bali");
  });

  it("every scoped query carries workspaceId in its filter", async () => {
    seed([videoOfB]);
    await request(appFor(WS_A)).get("/vB/status");
    await request(appFor(WS_A)).get("/vB/context");
    expect(H.findOne).toHaveBeenCalledTimes(2);
    for (const [filter] of H.findOne.mock.calls) {
      expect(filter.workspaceId).toBeDefined();
      // The legacy key must be gone — leaving both would keep the "staff"
      // collapse alive on whichever path still used it.
      expect(filter.tenantId).toBeUndefined();
    }
  });
});
