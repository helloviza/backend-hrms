// Route-level coverage for Phase 9d — routes/admin.visa.reports.ts (case
// log, activity, status, progress exports). Same in-memory-collection
// approach as the rest of the visa test suite (mongodb-memory-server can't
// start in this environment): every model this router touches is backed
// by a small generic store with real find/aggregate/sort/limit semantics,
// so filter-narrowing, the row cap, and the risk sort are all genuinely
// exercised, not just asserted against a hand-picked fixture.
//
// requirePermission itself is NOT mocked — this file's own coverage
// includes proving READ is sufficient and nothing higher is silently
// required (task brief's "no permission escalation").
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";

const {
  _applications,
  _requests,
  _travellers,
  _workspaces,
  _users,
  chainableArray,
  matches,
} = vi.hoisted(() => {
  function getPath(rec: any, path: string): any {
    return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), rec);
  }

  function matchValue(val: any, cond: any): boolean {
    if (cond === null) return val === null || val === undefined;
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("$in" in cond) return (cond.$in as any[]).map(String).includes(String(val));
      if ("$ne" in cond) return String(val) !== String((cond as any).$ne);
      if ("$gte" in cond || "$lte" in cond) {
        if (val == null) return false;
        const t = new Date(val).getTime();
        if ("$gte" in cond && !(t >= new Date((cond as any).$gte).getTime())) return false;
        if ("$lte" in cond && !(t <= new Date((cond as any).$lte).getTime())) return false;
        return true;
      }
    }
    return String(val) === String(cond);
  }

  function matches(rec: Record<string, any>, filter: Record<string, any>): boolean {
    return Object.entries(filter || {}).every(([key, cond]) => {
      if (key === "$or") return (cond as any[]).some((sub) => matches(rec, sub));
      return matchValue(getPath(rec, key), cond);
    });
  }

  function makeCollection() {
    const store = new Map<string, Record<string, any>>();
    return {
      store,
      insert(doc: Record<string, any>): Record<string, any> {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const rec = { ...doc, _id: id };
        store.set(String(id), rec);
        return rec;
      },
      query(filter: Record<string, any> = {}) {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      clear() {
        store.clear();
      },
    };
  }

  // Real sort/skip/limit — the row cap and "newest first" ordering are
  // both actual behaviour under test, not asserted against an unsliced
  // array.
  function chainableArray(getRecords: () => any[]) {
    let sortSpec: Record<string, number> | null = null;
    let skipN = 0;
    let limitN: number | undefined;
    const obj: any = {
      select: () => obj,
      sort: (spec: Record<string, number>) => {
        sortSpec = spec;
        return obj;
      },
      skip: (n: number) => {
        skipN = n;
        return obj;
      },
      limit: (n: number) => {
        limitN = n;
        return obj;
      },
      lean: () => {
        let recs = getRecords().map((r) => ({ ...r }));
        if (sortSpec) {
          const entries = Object.entries(sortSpec);
          recs.sort((a, b) => {
            for (const [field, dir] of entries) {
              const av = getPath(a, field);
              const bv = getPath(b, field);
              const at = av instanceof Date || typeof av === "string" ? new Date(av).getTime() : (av ?? 0);
              const bt = bv instanceof Date || typeof bv === "string" ? new Date(bv).getTime() : (bv ?? 0);
              if (at !== bt) return (at - bt) * (dir as number);
            }
            return 0;
          });
        }
        recs = recs.slice(skipN, limitN != null ? skipN + limitN : undefined);
        return Promise.resolve(recs);
      },
    };
    return obj;
  }

  return {
    _applications: makeCollection(),
    _requests: makeCollection(),
    _travellers: makeCollection(),
    _workspaces: makeCollection(),
    _users: makeCollection(),
    chainableArray,
    matches,
  };
});

let _activityRows: any[] = [];

vi.mock("../models/VisaApplication.js", async () => {
  const actual: any = await vi.importActual("../models/VisaApplication.js");
  return {
    VISA_APPLICATION_STATUSES: actual.VISA_APPLICATION_STATUSES,
    VISA_APPLICATION_OUTCOMES: actual.VISA_APPLICATION_OUTCOMES,
    isTravellerErased: actual.isTravellerErased,
    VISA_APPLICATION_ERASED_MESSAGE: actual.VISA_APPLICATION_ERASED_MESSAGE,
    default: {
      countDocuments: async (filter: any) => _applications.query(filter).length,
      find: (filter: any) => chainableArray(() => _applications.query(filter)),
      aggregate: async (pipeline: any[]) => {
        const matchStage = pipeline.find((s) => s.$match)?.$match ?? {};
        const rows = _applications.query(matchStage);
        const groups = new Map<string, { _id: any; count: number }>();
        for (const r of rows) {
          const key = JSON.stringify({
            status: r.status,
            destination: r.ruleSnapshot?.destinationName ?? null,
            workspaceId: String(r.workspaceId),
          });
          const g = groups.get(key);
          if (g) g.count += 1;
          else
            groups.set(key, {
              _id: { status: r.status, destination: r.ruleSnapshot?.destinationName ?? null, workspaceId: r.workspaceId },
              count: 1,
            });
        }
        return Array.from(groups.values());
      },
    },
  };
});

vi.mock("../models/VisaRequest.js", () => ({
  default: { find: (filter: any) => chainableArray(() => _requests.query(filter)) },
}));

vi.mock("../models/TravellerProfile.js", () => ({
  default: { find: (filter: any) => chainableArray(() => _travellers.query(filter)) },
}));

vi.mock("../models/CustomerWorkspace.js", () => ({
  default: { find: (filter: any) => chainableArray(() => _workspaces.query(filter)) },
}));

vi.mock("../models/User.js", () => ({
  default: { find: (filter: any) => chainableArray(() => _users.query(filter)) },
}));

vi.mock("../models/VisaActivityLog.js", async () => {
  const actual: any = await vi.importActual("../models/VisaActivityLog.js");
  return {
    VISA_ACTIVITY_EVENT_TYPES: actual.VISA_ACTIVITY_EVENT_TYPES,
    default: {
      countDocuments: async (filter: any) => _activityRows.filter((r) => matches(r, filter)).length,
      find: (filter: any) => chainableArray(() => _activityRows.filter((r) => matches(r, filter))),
      aggregate: async (pipeline: any[]) => {
        const matchStage = pipeline.find((s) => s.$match)?.$match ?? {};
        const rows = _activityRows.filter((r) => matches(r, matchStage));
        const sorted = [...rows].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
        const seen = new Map<string, any>();
        for (const r of sorted) {
          const key = String(r.applicationId);
          if (!seen.has(key)) seen.set(key, r.at);
        }
        return Array.from(seen.entries()).map(([id, lastTransitionAt]) => ({ _id: id, lastTransitionAt }));
      },
    },
  };
});

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

let permissionAccess: "NONE" | "READ" | "WRITE" | "FULL" | null = "READ";
vi.mock("../models/UserPermission.js", () => ({
  UserPermission: {
    findOne: () => ({
      lean: () =>
        Promise.resolve(
          permissionAccess == null ? null : { modules: { visaApplication: { access: permissionAccess } }, level: { code: "L4" } },
        ),
    }),
  },
  hasAccess: (actual: string, required: string) => {
    const order = ["NONE", "READ", "WRITE", "FULL"];
    return order.indexOf(actual) >= order.indexOf(required);
  },
}));

import express from "express";
import request from "supertest";
import router, { REPORT_ROW_CAP, PROGRESS_REPORT_FETCH_CEILING, summarizeActivityDetail } from "./admin.visa.reports.js";
import { maskTailId } from "../utils/piiMask.js";

const WORKSPACE_A = new mongoose.Types.ObjectId();
const WORKSPACE_B = new mongoose.Types.ObjectId();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(new mongoose.Types.ObjectId()), roles: ["OPS"], email: "concierge@plumtrips.com" };
    next();
  });
  app.use("/", router);
  return app;
}

function parseCsv(text: string): string[][] {
  return text
    .trim()
    .split("\n")
    .map((line) => line.split(","));
}

async function parseXlsxRows(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const sheet = workbook.worksheets[0];
  const rows: string[][] = [];
  sheet.eachRow((row) => {
    rows.push((row.values as any[]).slice(1).map((v) => String(v ?? "")));
  });
  return rows;
}

let day = 1;
function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 86400000);
}

function seedFixtures() {
  const req1 = _requests.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId: WORKSPACE_A,
    referenceNumber: "HV26-000001",
    destinationIso2: "FR",
    travelDateFrom: daysFromNow(5),
    travelDateTo: daysFromNow(12),
  });
  const req2 = _requests.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId: WORKSPACE_B,
    referenceNumber: "HV26-000002",
    destinationIso2: "DE",
    travelDateFrom: daysFromNow(40),
    travelDateTo: daysFromNow(50),
  });

  const traveller1 = _travellers.insert({ firstName: "Anna", lastName: "Eriksson", passportNo: "P1234567" });
  const traveller2 = _travellers.insert({ firstName: "Raj", lastName: "Kumar", passportNo: "Z9988776" });

  _workspaces.insert({ _id: WORKSPACE_A, companyName: "Acme Travel" });
  _workspaces.insert({ _id: WORKSPACE_B, companyName: "Globex Corp" });

  const officer = _users.insert({ name: "Asha Rao", email: "asha@plumtrips.com" });

  const app1 = _applications.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId: WORKSPACE_A,
    requestId: req1._id,
    travellerProfileId: traveller1._id,
    status: "lodged",
    outcome: undefined,
    submittedAt: daysFromNow(-3),
    lodgedAt: daysFromNow(-1),
    createdAt: daysFromNow(-4),
    visaNumber: "",
    ruleSnapshot: { destinationName: "France", purpose: "TOURIST", serviceTier: "STANDARD" },
    indicativeCostSnapshot: { totalInr: 5000 },
    actualTotalInr: 5200,
    assignedConciergeUserId: officer._id,
    assignedScreeningOfficerId: null,
    servicePartnerName: "VFS Bengaluru",
  });

  const app2 = _applications.insert({
    _id: new mongoose.Types.ObjectId(),
    workspaceId: WORKSPACE_B,
    requestId: req2._id,
    travellerProfileId: traveller2._id,
    status: "submitted",
    outcome: undefined,
    submittedAt: daysFromNow(-1),
    lodgedAt: undefined,
    createdAt: daysFromNow(-1),
    visaNumber: "",
    ruleSnapshot: { destinationName: "Germany", purpose: "BUSINESS", serviceTier: "EXPRESS" },
    indicativeCostSnapshot: { totalInr: 8000 },
    actualTotalInr: undefined,
    assignedConciergeUserId: null,
    assignedScreeningOfficerId: null,
  });

  _activityRows.push(
    {
      _id: new mongoose.Types.ObjectId(),
      applicationId: app1._id,
      requestId: req1._id,
      workspaceId: WORKSPACE_A,
      eventType: "STATUS_CHANGED",
      actorUserId: officer._id,
      actorType: "STAFF",
      at: daysFromNow(-2),
      detail: { from: "submitted", to: "docs_under_review" },
    },
    {
      _id: new mongoose.Types.ObjectId(),
      applicationId: app1._id,
      requestId: req1._id,
      workspaceId: WORKSPACE_A,
      eventType: "COSTS_RECORDED",
      actorUserId: officer._id,
      actorType: "STAFF",
      at: daysFromNow(-1),
      detail: { actualTotalInr: 5200, varianceInr: 200 },
    },
    {
      _id: new mongoose.Types.ObjectId(),
      applicationId: app2._id,
      requestId: req2._id,
      workspaceId: WORKSPACE_B,
      eventType: "SUBMITTED",
      actorUserId: null,
      actorType: "CUSTOMER",
      at: daysFromNow(-1),
      detail: {},
    },
  );

  return { req1, req2, traveller1, traveller2, officer, app1, app2 };
}

beforeEach(() => {
  _applications.clear();
  _requests.clear();
  _travellers.clear();
  _workspaces.clear();
  _users.clear();
  _activityRows = [];
  permissionAccess = "READ";
});

describe("GET /reports/case-log", () => {
  it("returns one row per application with the documented columns", async () => {
    const { app1, app2 } = seedFixtures();
    const res = await request(makeApp()).get("/reports/case-log").query({ format: "csv" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      "Reference", "Workspace", "Traveller", "Passport (masked)", "Destination", "Purpose", "Service Tier",
      "Status", "Submitted Date", "Lodged Date", "Outcome", "Visa Number",
      "Assigned Concierge", "Assigned Screening Officer",
      "Travel Date From", "Travel Date To", "Days Until Travel",
      "Indicative Cost (INR)", "Actual Cost (INR)", "Variance (INR)",
      "Service Partner",
    ]);
    // Newest-submitted first: app2 (submitted -1 day) sorts before app1 (-3 days).
    expect(rows[1][0]).toBe("HV26-000002");
    expect(rows[2][0]).toBe("HV26-000001");

    const app1Row = rows.find((r) => r[0] === "HV26-000001")!;
    expect(app1Row[1]).toBe("Acme Travel");
    expect(app1Row[2]).toBe("Anna Eriksson");
    expect(app1Row[4]).toBe("France");
    expect(app1Row[12]).toBe("Asha Rao");
    expect(app1Row[17]).toBe("5000"); // indicative
    expect(app1Row[18]).toBe("5200"); // actual
    expect(app1Row[19]).toBe("200"); // variance
    expect(app1Row[20]).toBe("VFS Bengaluru"); // service partner
    const app2Row = rows.find((r) => r[0] === "HV26-000002")!;
    expect(app2Row[20]).toBe(""); // never set — blank, not a placeholder
    void app1;
    void app2;
  });

  it("masks passport numbers — never the raw value", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/case-log").query({ format: "csv" });
    const rows = parseCsv(res.text);
    const app1Row = rows.find((r) => r[0] === "HV26-000001")!;
    expect(app1Row[3]).toBe(maskTailId("P1234567"));
    expect(app1Row[3]).not.toBe("P1234567");
    expect(res.text).not.toContain("P1234567");
    expect(res.text).not.toContain("Z9988776");
  });

  it("filters by status server-side", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/case-log").query({ format: "csv", status: "lodged" });
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(2); // header + 1 data row
    expect(rows[1][0]).toBe("HV26-000001");
  });

  it("filters by workspace server-side", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/case-log").query({ format: "csv", workspaceId: String(WORKSPACE_B) });
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe("HV26-000002");
  });

  it("filters by destination server-side (resolved via VisaRequest.destinationIso2)", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/case-log").query({ format: "csv", destination: "de" });
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe("HV26-000002");
  });

  it("filters by assignee (either role) server-side", async () => {
    const { officer } = seedFixtures();
    const res = await request(makeApp()).get("/reports/case-log").query({ format: "csv", assigneeUserId: String(officer._id) });
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe("HV26-000001");
  });

  it("reports truncation instead of silently dropping rows", async () => {
    seedFixtures();
    for (let i = 0; i < REPORT_ROW_CAP + 5; i++) {
      _applications.insert({
        _id: new mongoose.Types.ObjectId(),
        workspaceId: WORKSPACE_A,
        requestId: new mongoose.Types.ObjectId(),
        travellerProfileId: new mongoose.Types.ObjectId(),
        status: "submitted",
        submittedAt: daysFromNow(-i),
        createdAt: daysFromNow(-i),
        ruleSnapshot: { destinationName: "Nowhere", purpose: "TOURIST", serviceTier: "STANDARD" },
        indicativeCostSnapshot: { totalInr: 100 },
      });
    }

    const res = await request(makeApp()).get("/reports/case-log").query({ format: "csv" });
    expect(res.headers["x-report-truncated"]).toBe("true");
    expect(Number(res.headers["x-report-row-count"])).toBe(REPORT_ROW_CAP);
    expect(Number(res.headers["x-report-total-matched"])).toBeGreaterThan(REPORT_ROW_CAP);

    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(1 + REPORT_ROW_CAP + 1); // header + capped rows + notice row
    expect(rows[rows.length - 1][0]).toContain("Showing");
    expect(rows[rows.length - 1][0]).toContain("narrow your filters");
  });

  it("also serves XLSX with the same row count as CSV", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/case-log").query({ format: "xlsx" }).buffer().parse((res: any, cb: any) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    const rows = await parseXlsxRows(res.body);
    expect(rows).toHaveLength(3); // header + 2 applications
  });
});

describe("GET /reports/activity", () => {
  it("returns one row per activity entry, newest first, with a readable summary", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/activity").query({ format: "csv" });
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual(["Timestamp", "Actor Name", "Actor Type", "Event Type", "Application Reference", "Traveller", "Summary"]);
    expect(rows).toHaveLength(4); // header + 3 seeded activity rows
    // Newest first: COSTS_RECORDED (-1 day) and SUBMITTED (-1 day) both
    // precede STATUS_CHANGED (-2 days).
    expect(rows[rows.length - 1][3]).toBe("STATUS_CHANGED");
  });

  it("resolves actor name, application reference, and traveller", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/activity").query({ format: "csv" });
    const rows = parseCsv(res.text);
    const statusRow = rows.find((r) => r[3] === "STATUS_CHANGED")!;
    expect(statusRow[1]).toBe("Asha Rao");
    expect(statusRow[2]).toBe("STAFF");
    expect(statusRow[4]).toBe("HV26-000001");
    expect(statusRow[5]).toBe("Anna Eriksson");
    expect(statusRow[6]).toBe("submitted -> docs_under_review");
  });

  it("SYSTEM/no-actor rows resolve to 'System'", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/activity").query({ format: "csv" });
    const rows = parseCsv(res.text);
    const submittedRow = rows.find((r) => r[3] === "SUBMITTED")!;
    expect(submittedRow[1]).toBe("System");
  });

  it("filters by eventType server-side", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/activity").query({ format: "csv", eventType: "COSTS_RECORDED" });
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(2);
    expect(rows[1][3]).toBe("COSTS_RECORDED");
  });

  it("Phase 9f: ?statusTo narrows STATUS_CHANGED rows to a specific target status (dashboard throughput drilldown)", async () => {
    const { app1, req1 } = seedFixtures();
    _activityRows.push({
      _id: new mongoose.Types.ObjectId(),
      applicationId: app1._id,
      requestId: req1._id,
      workspaceId: WORKSPACE_A,
      eventType: "STATUS_CHANGED",
      actorUserId: null,
      actorType: "STAFF",
      at: new Date(),
      detail: { from: "cost_confirmed", to: "lodged" },
    });

    const res = await request(makeApp()).get("/reports/activity").query({ format: "csv", eventType: "STATUS_CHANGED", statusTo: "lodged" });
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(2); // header + only the lodged transition, not the seeded submitted->docs_under_review one
    expect(rows[1][6]).toBe("cost_confirmed -> lodged");
  });

  it("Phase 9f: ?outcome narrows OUTCOME_RECORDED rows to a specific outcome (dashboard outcomes drilldown)", async () => {
    const { app1, req1 } = seedFixtures();
    _activityRows.push(
      {
        _id: new mongoose.Types.ObjectId(),
        applicationId: app1._id,
        requestId: req1._id,
        workspaceId: WORKSPACE_A,
        eventType: "OUTCOME_RECORDED",
        actorUserId: null,
        actorType: "STAFF",
        at: new Date(),
        detail: { outcome: "APPROVED" },
      },
      {
        _id: new mongoose.Types.ObjectId(),
        applicationId: app1._id,
        requestId: req1._id,
        workspaceId: WORKSPACE_A,
        eventType: "OUTCOME_RECORDED",
        actorUserId: null,
        actorType: "STAFF",
        at: new Date(),
        detail: { outcome: "REJECTED" },
      },
    );

    const res = await request(makeApp()).get("/reports/activity").query({ format: "csv", eventType: "OUTCOME_RECORDED", outcome: "APPROVED" });
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(2); // header + only the APPROVED row
    expect(rows[1][6]).toBe("Outcome: APPROVED");
  });

  it("Phase 9f: rejects an invalid ?outcome value", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/activity").query({ format: "csv", outcome: "MAYBE" });
    expect(res.status).toBe(400);
  });

  it("filters by actorUserId server-side", async () => {
    const { officer } = seedFixtures();
    const res = await request(makeApp()).get("/reports/activity").query({ format: "csv", actorUserId: String(officer._id) });
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(3); // STATUS_CHANGED + COSTS_RECORDED, both by officer
  });

  it("filters by status via the application join (destination/status/assignee resolve through VisaApplication)", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/activity").query({ format: "csv", status: "submitted" });
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(2); // only app2's SUBMITTED row
    expect(rows[1][3]).toBe("SUBMITTED");
  });
});

describe("GET /reports/status", () => {
  it("counts by status x destination x workspace", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/status").query({ format: "csv" });
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual(["Status", "Destination", "Workspace", "Count"]);
    expect(rows).toHaveLength(3); // header + 2 groups (one per application, distinct status/destination/workspace)
    const franceRow = rows.find((r) => r[1] === "France")!;
    expect(franceRow[0]).toBe("lodged");
    expect(franceRow[2]).toBe("Acme Travel");
    expect(franceRow[3]).toBe("1");
  });

  it("filters by workspace server-side", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/status").query({ format: "csv", workspaceId: String(WORKSPACE_A) });
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(2);
    expect(rows[1][2]).toBe("Acme Travel");
  });
});

describe("GET /reports/progress", () => {
  it("computes days-in-status, age-since-submission, and travel risk, sorted by risk", async () => {
    seedFixtures();
    const res = await request(makeApp()).get("/reports/progress").query({ format: "csv" });
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      "Reference", "Workspace", "Traveller", "Current Status",
      "Days In Current Status", "Days Since Submission",
      "Travel Date", "Days Until Travel", "Risk",
    ]);
    // app1 travels in 5 days (within the 14-day risk window) and isn't
    // decided -> AT RISK, and must sort before app2 (travels in 40 days).
    expect(rows[1][0]).toBe("HV26-000001");
    expect(rows[1][8]).toBe("AT RISK");
    expect(rows[2][0]).toBe("HV26-000002");
    expect(rows[2][8]).toBe("");
  });

  it("excludes draft applications by default", async () => {
    seedFixtures();
    _applications.insert({
      _id: new mongoose.Types.ObjectId(),
      workspaceId: WORKSPACE_A,
      requestId: new mongoose.Types.ObjectId(),
      travellerProfileId: new mongoose.Types.ObjectId(),
      status: "draft",
      createdAt: new Date(),
      ruleSnapshot: { destinationName: "Nowhere", purpose: "TOURIST", serviceTier: "STANDARD" },
    });
    const res = await request(makeApp()).get("/reports/progress").query({ format: "csv" });
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(3); // header + the 2 non-draft seeded applications only
  });

  it("refuses (413) rather than silently under-ranking when the filtered set exceeds the fetch ceiling", async () => {
    for (let i = 0; i < PROGRESS_REPORT_FETCH_CEILING + 1; i++) {
      _applications.insert({
        _id: new mongoose.Types.ObjectId(),
        workspaceId: WORKSPACE_A,
        requestId: new mongoose.Types.ObjectId(),
        travellerProfileId: new mongoose.Types.ObjectId(),
        status: "submitted",
        submittedAt: new Date(),
        createdAt: new Date(),
        ruleSnapshot: { destinationName: "Nowhere", purpose: "TOURIST", serviceTier: "STANDARD" },
      });
    }
    const res = await request(makeApp()).get("/reports/progress").query({ format: "csv" });
    expect(res.status).toBe(413);
    expect(res.body.error).toContain("narrow the filter");
  });
});

describe("permission gate — READ is sufficient, no escalation", () => {
  const ROUTES = ["/reports/case-log", "/reports/activity", "/reports/status", "/reports/progress"];

  it("every report is reachable with only READ access", async () => {
    seedFixtures();
    permissionAccess = "READ";
    const app = makeApp();
    for (const path of ROUTES) {
      const res = await request(app).get(path).query({ format: "csv" });
      expect(res.status).toBe(200);
    }
  });

  it("every report is reachable with WRITE/FULL too (READ is the floor, not the ceiling)", async () => {
    seedFixtures();
    const app = makeApp();
    for (const access of ["WRITE", "FULL"] as const) {
      permissionAccess = access;
      for (const path of ROUTES) {
        const res = await request(app).get(path).query({ format: "csv" });
        expect(res.status).toBe(200);
      }
    }
  });

  it("403s on every report with no permission record or NONE access", async () => {
    seedFixtures();
    const app = makeApp();
    for (const access of [null, "NONE"] as const) {
      permissionAccess = access;
      for (const path of ROUTES) {
        const res = await request(app).get(path).query({ format: "csv" });
        expect(res.status).toBe(403);
      }
    }
  });
});

describe("summarizeActivityDetail", () => {
  it("never echoes anything beyond what's already in the row-level detail (no PII leak path)", () => {
    expect(summarizeActivityDetail("ACTION_REQUIRED_SET", { reason: "Bank stamp missing" })).toBe("Reason: Bank stamp missing");
    expect(summarizeActivityDetail("DOCUMENT_REJECTED", { docCode: "DOC-01", reason: "Blurry" })).toBe("DOC-01: Blurry");
    expect(summarizeActivityDetail("EXTRACTION_FAILED", { failureCategory: "MALFORMED_MRZ" })).toBe("Failed: MALFORMED_MRZ");
    expect(summarizeActivityDetail("STATUS_CHANGED", { from: "submitted", to: "lodged" })).toBe("submitted -> lodged");
    expect(summarizeActivityDetail("UNKNOWN_EVENT", { anything: "x" })).toBe("");
  });
});
