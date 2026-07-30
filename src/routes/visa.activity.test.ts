// Route-level coverage for Phase 9c's customer-facing surface: GET
// /api/visa/requests/:id now returns a trimmed `activity` array alongside
// `request`/`applications`. Same "spy on the real static methods" approach
// as admin.visa.activity.test.ts — VisaActivityLog is the REAL model, not
// mocked away, so these tests prove the customer-visible-event-type filter
// (VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES) actually excludes assignment/
// cost rows at the DB-query level, not just that a route "did something".
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { requests, applications, chainable } = vi.hoisted(() => {
  type Doc = Record<string, any>;

  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, cond]) => {
      if (key === "$in") return true;
      return String(rec[key]) === String(cond);
    });
  }

  function makeCollection() {
    const store = new Map<string, Doc>();
    return {
      store,
      insert(doc: Doc): Doc {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const record: Doc = { ...doc, _id: id, createdAt: new Date(), updatedAt: new Date() };
        store.set(String(id), record);
        return record;
      },
      query(filter: Doc): Doc[] {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      clear() {
        store.clear();
      },
    };
  }

  function chainable(getResult: () => any) {
    const obj: any = { select: () => obj, sort: () => obj, limit: () => obj, lean: () => Promise.resolve(getResult()) };
    return obj;
  }

  return { requests: makeCollection(), applications: makeCollection(), chainable };
});

vi.mock("../models/VisaRequest.js", () => ({
  default: { findOne: (filter: any) => chainable(() => requests.query(filter)[0] ?? null) },
}));

vi.mock("../models/VisaApplication.js", () => ({
  default: { find: (filter: any) => chainable(() => applications.query(filter)) },
}));

vi.mock("../models/TravellerProfile.js", () => ({ default: { find: () => chainable(() => []) } }));
vi.mock("../models/User.js", () => ({ default: { find: () => chainable(() => []) } }));

import express from "express";
import request from "supertest";
import router from "./visa.js";
import VisaActivityLog from "../models/VisaActivityLog.js";

const WORKSPACE_A = new mongoose.Types.ObjectId();
const USER_A = new mongoose.Types.ObjectId();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(USER_A), roles: ["EMPLOYEE"] };
    req.workspaceObjectId = WORKSPACE_A;
    req.workspaceId = String(WORKSPACE_A);
    req.workspace = { _id: WORKSPACE_A, status: "ACTIVE" };
    next();
  });
  app.use("/", router);
  return app;
}

let _activityRows: Record<string, any>[] = [];

beforeEach(() => {
  requests.clear();
  applications.clear();
  _activityRows = [];

  vi.spyOn(VisaActivityLog, "find").mockImplementation(((filter: any) => {
    const eventTypes: string[] = filter.eventType?.$in ?? [];
    const rows = _activityRows.filter(
      (r) => String(r.requestId) === String(filter.requestId) && eventTypes.includes(r.eventType),
    );
    return chainable(() => [...rows].sort((a, b) => b.at.getTime() - a.at.getTime()));
  }) as any);
});

function seedActivity(requestId: any, eventType: string, at: Date, extra: Record<string, any> = {}) {
  _activityRows.push({
    _id: new mongoose.Types.ObjectId(),
    requestId,
    applicationId: extra.applicationId ?? null,
    eventType,
    actorType: extra.actorType ?? "STAFF",
    at,
    detail: extra.detail ?? {},
  });
}

describe("GET /requests/:id — trimmed customer activity feed", () => {
  it("includes lifecycle and document events, excludes assignment/cost/billing/extraction events", async () => {
    const req = requests.insert({ workspaceId: WORKSPACE_A, referenceNumber: "HV26-000001", status: "active" });

    seedActivity(req._id, "SUBMITTED", new Date("2026-01-01T00:00:00Z"));
    seedActivity(req._id, "DOCUMENT_UPLOADED", new Date("2026-01-02T00:00:00Z"), { detail: { docCode: "DOC-01", version: 1 } });
    // These three are seeded into the SAME requestId but are NOT
    // customer-visible event types — the mock's own eventType.$in filter
    // (mirroring the real query) already excludes them, which is exactly
    // what routes/visa.ts's VISA_ACTIVITY_CUSTOMER_VISIBLE_EVENT_TYPES
    // filter is supposed to produce against the real collection.
    seedActivity(req._id, "CONCIERGE_ASSIGNED", new Date("2026-01-03T00:00:00Z"));
    seedActivity(req._id, "COSTS_RECORDED", new Date("2026-01-04T00:00:00Z"));
    seedActivity(req._id, "EXTRACTION_COMPLETED", new Date("2026-01-05T00:00:00Z"));

    const res = await request(makeApp()).get(`/requests/${req._id}`);

    expect(res.status).toBe(200);
    const eventTypes = res.body.activity.map((e: any) => e.eventType);
    expect(eventTypes).toEqual(["DOCUMENT_UPLOADED", "SUBMITTED"]); // newest first
    expect(eventTypes).not.toContain("CONCIERGE_ASSIGNED");
    expect(eventTypes).not.toContain("COSTS_RECORDED");
    expect(eventTypes).not.toContain("EXTRACTION_COMPLETED");
  });

  it("never leaks another workspace's activity — scoped by requestId which is itself workspace-scoped", async () => {
    const req = requests.insert({ workspaceId: WORKSPACE_A, referenceNumber: "HV26-000002", status: "active" });
    const otherReq = new mongoose.Types.ObjectId();
    seedActivity(otherReq, "SUBMITTED", new Date());

    const res = await request(makeApp()).get(`/requests/${req._id}`);
    expect(res.status).toBe(200);
    expect(res.body.activity).toEqual([]);
  });

  it("shapes each entry with id/eventType/actorType/at/detail — no actorUserId exposed to the customer", async () => {
    const req = requests.insert({ workspaceId: WORKSPACE_A, referenceNumber: "HV26-000003", status: "active" });
    seedActivity(req._id, "ACTION_REQUIRED_SET", new Date(), { actorType: "STAFF", detail: { reason: "Missing bank stamp" } });

    const res = await request(makeApp()).get(`/requests/${req._id}`);
    expect(res.status).toBe(200);
    expect(res.body.activity).toHaveLength(1);
    const entry = res.body.activity[0];
    expect(Object.keys(entry).sort()).toEqual(["actorType", "applicationId", "at", "detail", "eventType", "id"]);
    expect(entry.actorType).toBe("STAFF");
    expect(entry.detail).toEqual({ reason: "Missing bank stamp" });
  });
});
