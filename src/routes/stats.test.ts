// B1 — /api/stats/dashboard must fail loudly (audit H4): a thrown error is a
// 500, never a 200 with zeros that the UI would render as real data.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
  resolveWorkspaceForUser: async () => null,
  default: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import router, { statsDeps } from "./stats.js";

function appAs(user: any) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = user;
    next();
  });
  app.use("/api/stats", router);
  return app;
}

const real = { ...statsDeps };
beforeEach(() => {
  Object.assign(statsDeps, real);
  statsDeps.resolveSelfWorkspaceFor = async () => null;
});

describe("GET /api/stats/dashboard", () => {
  it("returns 500 (not 200 + zeros) when the computation throws", async () => {
    statsDeps.computeDashboardStats = vi.fn(async () => {
      throw new Error("db down");
    });
    const res = await request(appAs({ sub: "507f1f77bcf86cd799439011" })).get("/api/stats/dashboard");
    expect(res.status).toBe(500);
    expect(res.body.attendancePercent).toBeUndefined();
    expect(res.body.docsUploaded).toBeUndefined();
  });

  it("returns 500 when resolving the workspace throws", async () => {
    statsDeps.resolveSelfWorkspaceFor = vi.fn(async () => {
      throw new Error("ws lookup failed");
    });
    const res = await request(appAs({ sub: "507f1f77bcf86cd799439011" })).get("/api/stats/dashboard");
    expect(res.status).toBe(500);
  });

  it("returns 401 without a user id", async () => {
    const res = await request(appAs({})).get("/api/stats/dashboard");
    expect(res.status).toBe(401);
  });

  it("returns the computed payload on success, without a workspace when none resolves", async () => {
    const compute = vi.fn(async () => ({ attendancePercent: "50%" }) as any);
    statsDeps.computeDashboardStats = compute;
    const res = await request(appAs({ sub: "507f1f77bcf86cd799439011" })).get("/api/stats/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.attendancePercent).toBe("50%");
    expect(compute).toHaveBeenCalledWith({ userId: "507f1f77bcf86cd799439011", workspaceObjectId: null });
  });
});
