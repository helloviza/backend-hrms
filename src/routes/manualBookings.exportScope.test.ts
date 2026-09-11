// LEAK 2 — tenant isolation on GET /api/admin/manual-bookings/export.
//
// The list handler carried three gates (tenant, own-scope, soft-delete); the
// export handler ran buildSearchFilter + applyInvoiceFilter and queried with
// NONE of them. Same permission (manualBookings), same query string, but the
// export returned other tenants' bookings — with the cost, margin and
// base-profit columns the customer-facing surfaces deliberately strip.
//
// ASSERTIONS ARE ON THE FILTER OBJECT, not on returned rows. A rows-based
// assertion against a mocked model proves nothing here: the mock returns
// whatever it is handed, so it passes identically with the gate present or
// absent. That is precisely how this survived. Every test below reaches into
// the exact object passed to ManualBooking.find().
//
// NO DATABASE. apps/backend/.env points MONGO_URI at the PROD Atlas cluster,
// so an unmocked model fires live production queries. Every model the route
// imports is mocked, and requirePermission is mocked because its real
// implementation does a UserPermission.findOne().
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    // Attaches scope exactly as the real one does. Part of what is under test
    // is that scope "ALL" does NOT lift the TENANT gate (it lifts only the
    // own-scope tier), so the value has to reach the handler.
    req.permissionScope = req.__scope ?? "ALL";
    req.permissionAccess = "FULL";
    next();
  },
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));

/* ── ManualBooking: capture the filter, return a configurable result ── */
const captured: any[] = [];
const state: { rows: any[] } = { rows: [] };
vi.mock("../models/ManualBooking.js", async () => {
  // The route imports the model's enum constants to validate the multi-select
  // filter params against. Stubbing them would validate against the test's
  // idea of the enums instead of the schema's, so pull the real ones through.
  const actual: any = await vi.importActual("../models/ManualBooking.js");
  // Hoisted factory — reaches back through the module registry rather than
  // closing over `state`, which is not yet initialised when this runs.
  const rowsOf = () => (globalThis as any).__mbRows ?? [];
  const chain = (): any => {
    const node: any = {
      sort: () => node, skip: () => node, limit: () => node, populate: () => node,
      lean: () => Promise.resolve(rowsOf()),
      then: (r: any, j: any) => Promise.resolve(rowsOf()).then(r, j),
    };
    return node;
  };
  return {
    default: {
      find: (f: any) => { (globalThis as any).__mbCaptured.push(f); return chain(); },
      countDocuments: () => Promise.resolve(rowsOf().length),
      aggregate: () => Promise.resolve([]),
    },
    MANUAL_BOOKING_TYPES: actual.MANUAL_BOOKING_TYPES,
    ALL_SUB_STATUSES: actual.ALL_SUB_STATUSES,
    ATTACHMENT_REQUIRED_TYPES: [],
    isNewModelLineItems: () => false,
  };
});
(globalThis as any).__mbCaptured = captured;
(globalThis as any).__mbRows = state.rows;

/* ── Everything else the route module pulls in ───────────────────────
 * NOTE: vi.mock factories are hoisted above every top-level statement, so
 * they may not close over module-scope helpers — each factory builds its own
 * stubs inline. */
vi.mock("../models/Invoice.js", () => ({
  default: { find: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) },
}));
vi.mock("../models/Customer.js", () => ({
  default: {
    findById: () => ({
      select: () => ({ lean: () => Promise.resolve(null) }),
      lean: () => Promise.resolve(null),
    }),
  },
}));
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }), lean: () => Promise.resolve(null) }),
    findById: () => ({ lean: () => Promise.resolve(null) }),
  },
}));
vi.mock("../models/CustomerMember.js", () => ({
  default: { find: () => ({ lean: () => Promise.resolve([]) }) },
}));
vi.mock("../models/User.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
}));
vi.mock("../models/SBTBooking.js", () => ({
  default: { find: () => ({ lean: () => Promise.resolve([]) }) },
}));
vi.mock("../models/SBTHotelBooking.js", () => ({
  default: { find: () => ({ lean: () => Promise.resolve([]) }) },
}));
vi.mock("../models/ExtractedDocument.js", () => ({
  default: { find: () => ({ lean: () => Promise.resolve([]) }) },
}));

import express from "express";
import request from "supertest";
import router from "./manualBookings.js";

const CWS_A  = new mongoose.Types.ObjectId(); // caller's CustomerWorkspace._id
const CUST_A = new mongoose.Types.ObjectId(); // caller's Customer._id
const CUST_B = new mongoose.Types.ObjectId(); // another tenant
const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254"; // utils/bookingAccess.ts
const HOUSE_CUSTOMER_ID  = "6a4e0d2ea90c293c9e129f48";

function makeApp(caller: {
  roles?: string[]; workspaceObjectId?: any; customerId?: any; scope?: string; userId?: string;
}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: caller.userId ?? String(new mongoose.Types.ObjectId()), roles: caller.roles ?? ["ADMIN"] };
    if (caller.workspaceObjectId !== undefined) req.workspaceObjectId = caller.workspaceObjectId;
    if (caller.customerId !== undefined) req.workspace = { customerId: String(caller.customerId) };
    req.__scope = caller.scope ?? "ALL";
    next();
  });
  app.use("/", router);
  return app;
}

const tenantA = { roles: ["ADMIN"], workspaceObjectId: CWS_A, customerId: CUST_A, scope: "ALL" };

/** The tenant clause: an $and entry that is an $or purely over workspaceId,
 *  or the fail-closed empty-result clause. */
function tenantClauseOf(filter: any): any {
  const and: any[] = filter?.$and ?? [];
  return and.find(
    (c) =>
      (Array.isArray(c?.$or) && c.$or.length > 0 && c.$or.every((a: any) => "workspaceId" in a && !("createdBy" in a) && !("assignPerson" in a) && !("assignmentStatus" in a))) ||
      (c?._id?.$in && c._id.$in.length === 0),
  );
}

/** The own-scope clause: an $and entry whose $or mentions createdBy. */
function ownScopeClauseOf(filter: any): any {
  const and: any[] = filter?.$and ?? [];
  return and.find((c) => Array.isArray(c?.$or) && c.$or.some((a: any) => "createdBy" in a));
}

function setRows(rows: any[]) { (globalThis as any).__mbRows = rows; }

beforeEach(() => { captured.length = 0; setRows([]); });

describe("GET /export — tenant gate (leak 2)", () => {
  it("a cross-tenant caller's export filter carries the restricting clause", async () => {
    const res = await request(makeApp(tenantA)).get("/export");
    expect(res.status).toBe(200);

    const filter = captured[0];
    const clause = tenantClauseOf(filter);
    expect(clause, "export ran with NO tenant clause").toBeTruthy();

    const arms = clause.$or.map((a: any) => String(a.workspaceId)).sort();
    expect(arms).toEqual([String(CWS_A), String(CUST_A)].sort());
    expect(arms).not.toContain(String(CUST_B));
  });

  it("export and list produce the same tenant clause for the same caller", async () => {
    await request(makeApp(tenantA)).get("/");
    const listFilter = captured[0];
    captured.length = 0;
    await request(makeApp(tenantA)).get("/export");
    const exportFilter = captured[0];

    expect(JSON.stringify(tenantClauseOf(exportFilter)))
      .toBe(JSON.stringify(tenantClauseOf(listFilter)));
  });

  it("scope 'ALL' does NOT lift the tenant gate on export", async () => {
    await request(makeApp({ ...tenantA, scope: "ALL" })).get("/export");
    expect(tenantClauseOf(captured[0])).toBeTruthy();
    // ...but it DOES lift the own-scope tier, which is the documented split.
    expect(ownScopeClauseOf(captured[0])).toBeFalsy();
  });

  it("SUPERADMIN exports unrestricted", async () => {
    const res = await request(makeApp({ roles: ["SUPERADMIN"] })).get("/export");
    expect(res.status).toBe(200);
    expect(tenantClauseOf(captured[0])).toBeFalsy();
  });

  it("HOUSE staff export unrestricted", async () => {
    await request(makeApp({ roles: ["ADMIN"], workspaceObjectId: HOUSE_WORKSPACE_ID })).get("/export");
    expect(tenantClauseOf(captured[0])).toBeFalsy();
  });

  it("no resolvable tenant fails CLOSED on export", async () => {
    await request(makeApp({ roles: ["ADMIN"] })).get("/export");
    expect(captured[0].$and).toContainEqual({ _id: { $in: [] } });
  });
});

describe("GET /export — own-scope tier", () => {
  it("a non-ALL caller is confined to their own rows plus HOUSE carve-outs", async () => {
    const me = String(new mongoose.Types.ObjectId());
    await request(makeApp({ ...tenantA, scope: "OWN", userId: me })).get("/export");

    const clause = ownScopeClauseOf(captured[0]);
    expect(clause, "export applied no own-scope tier").toBeTruthy();
    expect(clause.$or[0]).toEqual({ createdBy: me });

    // The two HOUSE intake carve-outs the list has, preserved verbatim.
    const houseArms = clause.$or.slice(1);
    expect(houseArms).toHaveLength(2);
    for (const a of houseArms) expect(String(a.workspaceId)).toBe(HOUSE_CUSTOMER_ID);
    expect(houseArms[0].assignmentStatus).toBe("PENDING_TO_ASSIGN");
    expect(String(houseArms[1].assignPerson)).toBe(me);
  });

  it("both tiers stack for a non-ALL cross-tenant caller", async () => {
    await request(makeApp({ ...tenantA, scope: "OWN" })).get("/export");
    expect(tenantClauseOf(captured[0])).toBeTruthy();
    expect(ownScopeClauseOf(captured[0])).toBeTruthy();
  });
});

describe("GET /export — soft delete and demo", () => {
  it("hides soft-deleted rows", async () => {
    await request(makeApp(tenantA)).get("/export");
    expect(captured[0].isActive).toEqual({ $ne: false });
  });

  it("a non-SUPERADMIN cannot export deleted rows via showDeleted", async () => {
    await request(makeApp(tenantA)).get("/export?showDeleted=true");
    expect(captured[0].isActive).toEqual({ $ne: false });
  });

  it("SUPERADMIN may still export deleted rows deliberately", async () => {
    await request(makeApp({ roles: ["SUPERADMIN"] })).get("/export?showDeleted=true");
    expect(captured[0].isActive).toBe(false);
  });

  it("demo rows stay excluded (via buildSearchFilter, not duplicated)", async () => {
    await request(makeApp(tenantA)).get("/export");
    expect(captured[0].isDemo).toEqual({ $ne: true });
  });
});

describe("the list still renders rows after the gate extraction", () => {
  // REGRESSION GUARD. Extracting the gates into applyBookingReadGates removed
  // the `accessCtx` binding that the list's PII-masking line further down still
  // referenced. Every gate test above passed anyway, because they all assert on
  // the filter and the mock returns zero rows — the masking line never ran.
  // tsc caught it; these tests had not. Exercising a NON-EMPTY result set is
  // what closes that gap.
  const row = () => ({
    _id: new mongoose.Types.ObjectId(),
    workspaceId: CUST_A,
    bookingRef: "MB-2607-0045",
    pricing: { grandTotal: 1000 },
    passengers: [{ name: "A Traveller", panNo: "ABCDE1234F", passportNo: "Z1234567" }],
  });

  it("returns 200 and a row for a tenant caller", async () => {
    setRows([row()]);
    const res = await request(makeApp(tenantA)).get("/");
    expect(res.status).toBe(200);
    expect(res.body.docs).toHaveLength(1);
  });

  it("masks passenger PII for a non-SUPERADMIN caller", async () => {
    setRows([row()]);
    const res = await request(makeApp(tenantA)).get("/");
    const pax = res.body.docs[0].passengers[0];
    expect(pax.panNo).not.toBe("ABCDE1234F");
    expect(pax.passportNo).not.toBe("Z1234567");
  });

  it("leaves PII intact for SUPERADMIN", async () => {
    setRows([row()]);
    const res = await request(makeApp({ roles: ["SUPERADMIN"] })).get("/");
    const pax = res.body.docs[0].passengers[0];
    expect(pax.panNo).toBe("ABCDE1234F");
  });

  it("export renders rows too", async () => {
    setRows([row()]);
    const res = await request(makeApp(tenantA)).get("/export");
    expect(res.status).toBe(200);
    expect(res.text).toContain("MB-2607-0045");
  });
});

describe("GET /export — search composes with the gates", () => {
  it("free-text search is AND-ed in, never left as a sibling $or", async () => {
    await request(makeApp(tenantA)).get("/export?search=MB-2607");
    const filter = captured[0];

    // The $or buildSearchFilter installs must have been lifted into $and —
    // if it were still a sibling key it would OR against the gate and widen it.
    expect(filter.$or).toBeUndefined();

    const searchClause = (filter.$and ?? []).find(
      (c: any) => Array.isArray(c.$or) && c.$or.some((a: any) => "bookingRef" in a),
    );
    expect(searchClause).toBeTruthy();
    expect(tenantClauseOf(filter)).toBeTruthy();
  });
});
