// Phase 3 — GET /trips/watches: the read-only tracker surface.
//
// The disruption watcher has been writing TripWatch + TripAlert and notifying
// travellers for a while, but /concierge showed none of it. This endpoint is a
// pure consumer — it must never write, and must never let one workspace read
// another's watches.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"; });

const H = vi.hoisted(() => ({ watchFind: vi.fn(), alertFind: vi.fn() }));

/** Chainable find() stub: .sort().limit().lean() */
function chain(rows: any[]) {
  const c: any = {
    sort: () => c,
    limit: () => c,
    lean: async () => rows,
  };
  return c;
}

vi.mock("../models/TripWatch.js", () => ({ default: { find: H.watchFind } }));
vi.mock("../models/TripAlert.js", () => ({ default: { find: H.alertFind } }));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: vi.fn() }));

import express from "express";
import request from "supertest";
import router from "./copilot.travel.js";

const WS_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const WS_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

function appFor(workspaceId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: "u1", email: "t@plumtrips.com" };
    req.workspaceObjectId = workspaceId;
    req.workspaceId = workspaceId;
    next();
  });
  app.use("/", router);
  return app;
}

const watchA = {
  _id: "wA", workspaceId: WS_A, flightNo: "6E-2582", carrier: "6E",
  origin: "DEL", destination: "BOM", departDate: new Date("2026-09-20T10:00:00Z"),
  status: "ACTIVE", notifyChannel: "WHATSAPP", lastCheckedAt: new Date("2026-09-19T10:00:00Z"),
  lastKnownState: { status: "Scheduled", depScheduled: "2026-09-20T10:00:00Z" },
};
const watchB = {
  _id: "wB", workspaceId: WS_B, flightNo: "AI-4305", carrier: "AI",
  origin: "DEL", destination: "DXB", departDate: new Date("2026-09-21T15:15:00Z"),
  status: "ACTIVE", notifyChannel: "EMAIL", lastCheckedAt: null, lastKnownState: null,
};

/** Honours workspaceId in the filter — an unscoped query leaks and fails a test. */
function seed(watches: any[], alerts: any[]) {
  H.watchFind.mockImplementation((f: any) =>
    chain(watches.filter((w) => String(w.workspaceId) === String(f.workspaceId))),
  );
  H.alertFind.mockImplementation((f: any) => {
    const ids = (f.tripWatchId?.$in ?? []).map(String);
    return chain(
      alerts.filter(
        (a) =>
          String(a.workspaceId) === String(f.workspaceId) &&
          ids.includes(String(a.tripWatchId)),
      ),
    );
  });
}

beforeEach(() => { H.watchFind.mockReset(); H.alertFind.mockReset(); });

describe("GET /trips/watches — honest empty state", () => {
  it("returns an empty list, not a fabricated status, when nothing is tracked", async () => {
    seed([], []);
    const res = await request(appFor(WS_A)).get("/trips/watches");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, watches: [] });
    // No alert query at all when there are no watches.
    expect(H.alertFind).not.toHaveBeenCalled();
  });
});

describe("GET /trips/watches — real data", () => {
  it("returns the caller's watches with their alerts", async () => {
    seed(
      [watchA],
      [
        { _id: "a1", workspaceId: WS_A, tripWatchId: "wA", kind: "DELAY", detail: "Departure delayed 45 min", createdAt: new Date("2026-09-20T09:00:00Z"), deliveryStatus: "SENT" },
      ],
    );
    const res = await request(appFor(WS_A)).get("/trips/watches");
    expect(res.status).toBe(200);
    expect(res.body.watches).toHaveLength(1);
    const w = res.body.watches[0];
    expect(w.flightNo).toBe("6E-2582");
    expect(w.origin).toBe("DEL");
    expect(w.lastKnownState.status).toBe("Scheduled");
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].kind).toBe("DELAY");
    expect(w.alerts[0].detail).toBe("Departure delayed 45 min");
  });

  it("surfaces a never-checked watch as null state rather than inventing one", async () => {
    seed([watchB], []);
    const res = await request(appFor(WS_B)).get("/trips/watches");
    expect(res.body.watches[0].lastKnownState).toBeNull();
    expect(res.body.watches[0].lastCheckedAt).toBeNull();
    expect(res.body.watches[0].alerts).toEqual([]);
  });
});

describe("CROSS-TENANT ISOLATION — one workspace cannot read another's watches", () => {
  it("A sees only A's watch, B only B's", async () => {
    seed([watchA, watchB], []);

    const a = await request(appFor(WS_A)).get("/trips/watches");
    expect(a.body.watches.map((w: any) => w.flightNo)).toEqual(["6E-2582"]);
    expect(JSON.stringify(a.body)).not.toContain("AI-4305");

    const b = await request(appFor(WS_B)).get("/trips/watches");
    expect(b.body.watches.map((w: any) => w.flightNo)).toEqual(["AI-4305"]);
    expect(JSON.stringify(b.body)).not.toContain("6E-2582");
  });

  it("another tenant's ALERT can never attach, even on a same-id watch", async () => {
    seed(
      [watchA],
      [
        { _id: "a1", workspaceId: WS_A, tripWatchId: "wA", kind: "DELAY", detail: "A's delay", createdAt: new Date(), deliveryStatus: "SENT" },
        // Same tripWatchId, different workspace — must be excluded by the
        // workspaceId half of the alert filter.
        { _id: "a2", workspaceId: WS_B, tripWatchId: "wA", kind: "CANCELLED", detail: "B's private cancellation", createdAt: new Date(), deliveryStatus: "SENT" },
      ],
    );
    const res = await request(appFor(WS_A)).get("/trips/watches");
    expect(res.body.watches[0].alerts).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("B's private cancellation");
  });

  it("both queries always carry workspaceId from the REQUEST, never the body", async () => {
    seed([watchA], [{ _id: "a1", workspaceId: WS_A, tripWatchId: "wA", kind: "DELAY", detail: "d", createdAt: new Date(), deliveryStatus: "SENT" }]);
    await request(appFor(WS_A)).get("/trips/watches").send({ workspaceId: WS_B });

    expect(String(H.watchFind.mock.calls[0][0].workspaceId)).toBe(WS_A);
    expect(String(H.alertFind.mock.calls[0][0].workspaceId)).toBe(WS_A);
    // Alerts are additionally bounded to the watches we just read.
    expect(H.alertFind.mock.calls[0][0].tripWatchId.$in).toBeDefined();
  });

  it("is READ-ONLY — no write method is ever reached on either model", async () => {
    seed([watchA], []);
    await request(appFor(WS_A)).get("/trips/watches");
    // The mocked models expose ONLY find(); any create/update/delete call would
    // have thrown "is not a function" and failed this request.
    expect(H.watchFind).toHaveBeenCalledTimes(1);
  });
});
