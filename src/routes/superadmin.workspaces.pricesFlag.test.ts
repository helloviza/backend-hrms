// apps/backend/src/routes/superadmin.workspaces.pricesFlag.test.ts
//
// PUT /superadmin/workspaces/:id/features (slice S7, audit F12):
//   - the feature name must be a declared config.features flag, read off the
//     CustomerWorkspace schema; unknown or dotted names → 400, nothing written
//   - approvalFlightPricesEnabled / approvalHotelPricesEnabled toggle like any
//     other flag (the S3 refusal is gone)
//   - every toggle writes a WorkspaceFeatureAudit row: workspace, flag, old,
//     new, who, when; each linked flag the toggle forced AND actually changed
//     gets its own row, linkedTo the clicked one
//   - a failed audit write never fails a saved toggle (200, saved state, error log)
//   - the workspace list and detail carry the price flags' last change as
//     {by: profile name, at} — never a raw id; "System" with no actor
//   - SUPERADMIN only
// The end to end (switch ON here → approval search shows prices) is in
// approvals.searchPrices.test.ts.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
vi.mock("../utils/mailer.js", () => ({ sendMail: async () => ({ messageId: "test" }) }));

const { default: router, WORKSPACE_FEATURE_NAMES } = await import("./superadmin.workspaces.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: WorkspaceFeatureAudit } = await import("../models/WorkspaceFeatureAudit.js");
const { default: logger } = await import("../utils/logger.js");

const app = express();
app.use(express.json());
app.use("/api/superadmin", router);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = new mongoose.Types.ObjectId();
const SA_ID = new mongoose.Types.ObjectId();
const SA = JSON.stringify({ _id: String(SA_ID), sub: String(SA_ID), email: "priya@plumtrips.com", roles: ["SUPERADMIN"] });
const ADMIN = JSON.stringify({ _id: String(new mongoose.Types.ObjectId()), email: "admin@plumtrips.com", roles: ["ADMIN"] });

const features = async () => ((await col("customerworkspaces").findOne({ _id: WS })) as any).config.features;
const toggle = (feature: any, enabled: any, as = SA) =>
  request(app).put(`/api/superadmin/workspaces/${WS}/features`).set("x-test-user", as).send({ feature, enabled });
const auditRows = () => col("workspacefeatureaudits").find({ workspaceId: WS }).sort({ createdAt: 1, _id: 1 }).toArray();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("superadmin-prices-flag-test"));
  await col("customerworkspaces").insertOne({
    _id: WS, customerId: "C1", name: "WS", status: "ACTIVE", tenantType: "CORPORATE",
    config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } },
  } as any);
  await col("users").insertOne({ _id: SA_ID, email: "priya@plumtrips.com", name: "Priya Sharma", roles: ["SUPERADMIN"] } as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("the allow-list", () => {
  it("is exactly the schema's config.features flags", () => {
    const fromSchema = Object.keys((CustomerWorkspace as any).schema.paths)
      .filter((p) => p.startsWith("config.features."))
      .map((p) => p.split(".")[2]);
    expect([...WORKSPACE_FEATURE_NAMES].sort()).toEqual(fromSchema.sort());
    expect(WORKSPACE_FEATURE_NAMES.has("approvalFlightPricesEnabled")).toBe(true);
    expect(WORKSPACE_FEATURE_NAMES.has("approvalHotelPricesEnabled")).toBe(true);
    expect(WORKSPACE_FEATURE_NAMES.has("visaEnabled")).toBe(true);
  });

  for (const feature of ["madeUpEnabled", "approvalFlowEnabled.x", "config.travelFlow", "features.visaEnabled", "", "__proto__", 42]) {
    it(`refuses ${JSON.stringify(feature)} with 400 and writes nothing`, async () => {
      const before = await col("customerworkspaces").findOne({ _id: WS });
      const rows = (await auditRows()).length;
      const r = await toggle(feature, true);
      expect(r.status).toBe(400);
      expect(await col("customerworkspaces").findOne({ _id: WS })).toEqual(before);
      expect((await auditRows()).length).toBe(rows);
    });
  }
});

describe("approval price flags", () => {
  for (const feature of ["approvalFlightPricesEnabled", "approvalHotelPricesEnabled"]) {
    it(`${feature} turns on and off, one audit row per toggle with the actor`, async () => {
      expect((await features())[feature]).toBeUndefined();

      const on = await toggle(feature, true);
      expect(on.status).toBe(200);
      expect(on.body.workspace.config.features[feature]).toBe(true);
      expect((await features())[feature]).toBe(true);

      const off = await toggle(feature, false);
      expect(off.status).toBe(200);
      expect((await features())[feature]).toBe(false);

      const rows = (await auditRows()).filter((a: any) => a.feature === feature);
      expect(rows.map((a: any) => [a.from, a.to])).toEqual([[null, true], [true, false]]);
      for (const a of rows) {
        expect(String(a.workspaceId)).toBe(String(WS));
        expect(String(a.actorId)).toBe(String(SA_ID));
        expect(a.actorEmail).toBe("priya@plumtrips.com");
        expect(a.createdAt).toBeInstanceOf(Date);
      }
      expect(off.body.workspace.featureChanges[feature]).toEqual({ by: "Priya Sharma", at: rows[1].createdAt.toISOString() });
    });
  }

  it("other features still toggle, and are audited too", async () => {
    const r = await toggle("visaEnabled", true);
    expect(r.status).toBe(200);
    expect((await features()).visaEnabled).toBe(true);
    const last = (await auditRows()).at(-1) as any;
    expect([last.feature, last.from, last.to]).toEqual(["visaEnabled", null, true]);
  });

  it("non-superadmin: 403, nothing written", async () => {
    const before = await col("customerworkspaces").findOne({ _id: WS });
    const rows = (await auditRows()).length;
    const r = await toggle("approvalFlightPricesEnabled", true, ADMIN);
    expect(r.status).toBe(403);
    expect(await col("customerworkspaces").findOne({ _id: WS })).toEqual(before);
    expect((await auditRows()).length).toBe(rows);
  });
});

describe("last change on the workspace list and detail", () => {
  it("names the actor, never their id; price flags only", async () => {
    await toggle("approvalHotelPricesEnabled", true);
    const list = await request(app).get("/api/superadmin/workspaces").set("x-test-user", SA);
    const detail = await request(app).get(`/api/superadmin/workspaces/${WS}`).set("x-test-user", SA);
    for (const ws of [list.body.workspaces.find((w: any) => String(w._id) === String(WS)), detail.body.workspace]) {
      expect(Object.keys(ws.featureChanges).sort()).toEqual(["approvalFlightPricesEnabled", "approvalHotelPricesEnabled"]);
      expect(ws.featureChanges.approvalHotelPricesEnabled.by).toBe("Priya Sharma");
      expect(new Date(ws.featureChanges.approvalHotelPricesEnabled.at).getTime()).toBeGreaterThan(0);
      expect(JSON.stringify(ws.featureChanges)).not.toContain(String(SA_ID));
    }
  });

  it("a row with no actor reads System", async () => {
    await col("workspacefeatureaudits").insertOne({
      workspaceId: WS, feature: "approvalFlightPricesEnabled", from: false, to: true, createdAt: new Date(Date.now() + 60_000),
    } as any);
    const detail = await request(app).get(`/api/superadmin/workspaces/${WS}`).set("x-test-user", SA);
    expect(detail.body.workspace.featureChanges.approvalFlightPricesEnabled.by).toBe("System");
  });
});

describe("linked flags", () => {
  const LWS = new mongoose.Types.ObjectId();
  const set = (feature: string, enabled: boolean) =>
    request(app).put(`/api/superadmin/workspaces/${LWS}/features`).set("x-test-user", SA).send({ feature, enabled });
  const rows = () => col("workspacefeatureaudits").find({ workspaceId: LWS }).sort({ _id: 1 }).toArray();
  const shape = (a: any) => [a.feature, a.from, a.to, a.linkedTo ?? null];

  beforeAll(async () => {
    await col("customerworkspaces").insertOne({
      _id: LWS, customerId: "C2", name: "Linked", status: "ACTIVE", tenantType: "CORPORATE",
      config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: false, approvalDirectEnabled: false, sbtEnabled: true } },
    } as any);
  });

  it("Approval Direct ON: rows for Direct, and for Approval Flow and SBT which it changed, linked to Direct", async () => {
    expect((await set("approvalDirectEnabled", true)).status).toBe(200);
    const r = await rows();
    expect(r.map(shape).sort()).toEqual([
      ["approvalDirectEnabled", false, true, null],
      ["approvalFlowEnabled", false, true, "approvalDirectEnabled"],
      ["sbtEnabled", true, false, "approvalDirectEnabled"],
    ].sort());
    for (const a of r) expect(String(a.actorId)).toBe(String(SA_ID));
  });

  it("a linked flag already at its forced value gets no row", async () => {
    await col("workspacefeatureaudits").deleteMany({ workspaceId: LWS });
    // Flow is already on and SBT already off from the previous test.
    expect((await set("approvalDirectEnabled", true)).status).toBe(200);
    expect((await rows()).map(shape)).toEqual([["approvalDirectEnabled", true, true, null]]);
  });

  it("SBT ON: both approval flows off, each linked to SBT", async () => {
    await col("workspacefeatureaudits").deleteMany({ workspaceId: LWS });
    expect((await set("sbtEnabled", true)).status).toBe(200);
    expect((await rows()).map(shape).sort()).toEqual([
      ["approvalDirectEnabled", true, false, "sbtEnabled"],
      ["approvalFlowEnabled", true, false, "sbtEnabled"],
      ["sbtEnabled", false, true, null],
    ].sort());
  });

  it("turning a flag OFF forces nothing, so one row", async () => {
    await col("workspacefeatureaudits").deleteMany({ workspaceId: LWS });
    expect((await set("sbtEnabled", false)).status).toBe(200);
    expect((await rows()).map(shape)).toEqual([["sbtEnabled", true, false, null]]);
  });
});

describe("audit write fails after a successful save", () => {
  it("still 200 with the saved state; the failure is logged at error level", async () => {
    const insert = vi.spyOn(WorkspaceFeatureAudit, "insertMany").mockRejectedValueOnce(new Error("audit down"));
    const error = vi.spyOn(logger, "error");
    try {
      const r = await toggle("approvalHotelPricesEnabled", false);
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(true);
      expect(r.body.workspace.config.features.approvalHotelPricesEnabled).toBe(false);
      expect((await features()).approvalHotelPricesEnabled).toBe(false);
      // The logger's declared signature is narrower than the (message, meta) call it gets.
      const logged = error.mock.calls.find(([m]) => String(m).includes("audit write failed")) as unknown[] | undefined;
      expect(logged).toBeDefined();
      expect(logged?.[1]).toMatchObject({ feature: "approvalHotelPricesEnabled", enabled: false, err: "audit down" });
    } finally {
      insert.mockRestore();
      error.mockRestore();
    }
  });
});

describe("stored feature state, missing as off (review M2)", () => {
  const MWS = new mongoose.Types.ObjectId();
  beforeAll(async () => {
    // No approvalFlowEnabled / approvalDirectEnabled stored at all (schema default for Flow is true).
    await col("customerworkspaces").insertOne({
      _id: MWS, customerId: "C3", name: "Missing keys", status: "ACTIVE", tenantType: "CORPORATE",
      config: { travelFlow: "APPROVAL_FLOW", features: { visaEnabled: false } },
    } as any);
  });

  it("toggling another flag reports approvalFlowEnabled as off in the save response, list and detail", async () => {
    const r = await request(app).put(`/api/superadmin/workspaces/${MWS}/features`).set("x-test-user", SA)
      .send({ feature: "visaEnabled", enabled: true });
    expect(r.status).toBe(200);
    expect(r.body.workspace.config.features.approvalFlowEnabled).toBe(false);
    expect(r.body.workspace.config.features.visaEnabled).toBe(true);

    const list = await request(app).get("/api/superadmin/workspaces").set("x-test-user", SA);
    const detail = await request(app).get(`/api/superadmin/workspaces/${MWS}`).set("x-test-user", SA);
    for (const f of [list.body.workspaces.find((w: any) => String(w._id) === String(MWS)).features, detail.body.workspace.features]) {
      expect(f.approvalFlowEnabled).toBe(false);
      expect(f.approvalDirectEnabled).toBe(false);
      expect(f.visaEnabled).toBe(true);
    }
  });

  it("never writes the defaults into the database", async () => {
    const stored = ((await col("customerworkspaces").findOne({ _id: MWS })) as any).config.features;
    expect(Object.keys(stored).sort()).toEqual(["visaEnabled"]);
  });
});
