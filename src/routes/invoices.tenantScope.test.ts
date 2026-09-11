// Tenant isolation + search for the ADMIN invoice read paths.
//
// WHY THESE ASSERT ON THE FILTER, NOT ON RETURNED ROWS: the leak this covers
// survived in production precisely because nothing inspected the query. Every
// admin read handler built its `filter` from `{}` and never consulted the
// caller's workspace, so a returned-rows assertion against a mocked model
// passes just as happily with no gate as with one — the mock returns whatever
// it was told to. These tests therefore capture the exact object handed to
// Mongo and assert on its structure.
//
// Urgency context (see the Step 0 finding): routes/saas.signup.ts is mounted
// PUBLIC and provisions every self-service signup with
// invoices: { access: "FULL", scope: "ALL" }. So "holds invoices:READ" is NOT
// equivalent to "is Plumtrips staff", and the gate must not key its bypass off
// permissionScope === "ALL" — every live holder has it.
//
// NO TEST MAY TOUCH A DATABASE. The backend's .env points MONGO_URI at the
// PROD Atlas cluster, so an unmocked model here fires live queries at
// production. Every model the route imports is mocked below, and
// requirePermission is mocked too — its real implementation does a
// UserPermission.findOne().
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

/* ── Middleware: all four are passthroughs ──────────────────────────
 * requirePermission is mocked NOT for convenience but for safety: the real one
 * queries UserPermission. It still attaches permissionScope, because part of
 * what's under test is that scope ALL does NOT lift the tenant gate. */
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/rbac.js", () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.permissionScope = req.__scope ?? "ALL";
    req.permissionAccess = "FULL";
    next();
  },
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));

/* ── Invoice model: captures every filter handed to it ─────────────── */
const captured: { find: any[]; count: any[]; aggregate: any[] } = {
  find: [], count: [], aggregate: [],
};
let findResult: any[] = [];

function chain(result: () => any) {
  // Supports every shape the read paths use:
  //   find().sort().skip().limit().lean()   (list)
  //   find().sort().lean()                  (export, bulk-pdf)
  //   find().sort().limit().lean()          (activity)
  const node: any = {
    sort: () => node,
    skip: () => node,
    limit: () => node,
    lean: () => Promise.resolve(result()),
    then: (r: any, j: any) => Promise.resolve(result()).then(r, j),
  };
  return node;
}

vi.mock("../models/Invoice.js", () => ({
  default: {
    find: (f: any) => { captured.find.push(f); return chain(() => findResult); },
    countDocuments: (f: any) => { captured.count.push(f); return Promise.resolve(0); },
    aggregate: (p: any) => { captured.aggregate.push(p); return Promise.resolve([]); },
  },
}));

/* ── Every other model the route module imports ────────────────────── */
let cwsLookupResult: any = null;
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(cwsLookupResult) }) }),
    findById: () => ({ lean: () => Promise.resolve(null) }),
  },
}));
vi.mock("../models/Customer.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
}));
vi.mock("../models/User.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
}));
vi.mock("../models/ManualBooking.js", () => ({
  default: { find: () => ({ lean: () => Promise.resolve([]) }) },
}));
vi.mock("../models/CreditNote.js", () => ({
  default: { find: () => ({ lean: () => Promise.resolve([]) }) },
}));
vi.mock("../models/CompanySettings.js", () => ({
  getCompanySettings: () => Promise.resolve({}),
  default: { findOne: () => ({ lean: () => Promise.resolve(null) }) },
}));
vi.mock("../utils/invoicePdf.js", () => ({
  generateInvoicePdf: () => Promise.resolve(Buffer.from("")),
  prefetchInvoiceAssets: () => Promise.resolve({}),
}));

import express from "express";
import request from "supertest";
import router from "./invoices.js";

/* ── Fixtures ───────────────────────────────────────────────────────
 * Two distinct id-spaces for tenant A (the caller's), plus tenant B (the one
 * a correctly-gated caller must never be able to reach). */
const CWS_A  = new mongoose.Types.ObjectId(); // CustomerWorkspace._id
const CUST_A = new mongoose.Types.ObjectId(); // Customer._id
const CWS_B  = new mongoose.Types.ObjectId();
const CUST_B = new mongoose.Types.ObjectId();
const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254"; // utils/bookingAccess.ts

type Caller = {
  roles?: string[];
  workspaceObjectId?: any;
  customerId?: any;
  scope?: string;
};

function makeApp(caller: Caller) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(new mongoose.Types.ObjectId()), roles: caller.roles ?? ["ADMIN"] };
    if (caller.workspaceObjectId !== undefined) req.workspaceObjectId = caller.workspaceObjectId;
    if (caller.customerId !== undefined) req.workspace = { customerId: String(caller.customerId) };
    req.__scope = caller.scope ?? "ALL";
    next();
  });
  app.use("/", router);
  return app;
}

/** A tenant admin exactly like the live L0 SaaS-signup holders: not SUPERADMIN,
 *  not HOUSE, but carrying invoices scope "ALL". */
const tenantA: Caller = { roles: ["ADMIN"], workspaceObjectId: CWS_A, customerId: CUST_A, scope: "ALL" };

/* ── Structural helpers ─────────────────────────────────────────────── */

/** The gate clause: an $and entry that is an $or over workspaceId, or the
 *  fail-closed empty-result clause. */
function gateOf(filter: any): any {
  const and: any[] = filter?.$and ?? [];
  return and.find(
    (c) => (Array.isArray(c?.$or) && c.$or.every((a: any) => "workspaceId" in a)) || c?._id?.$in,
  );
}

/** Every workspaceId value referenced anywhere in the filter, as strings. */
function workspaceIdsIn(node: any, out: string[] = []): string[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => workspaceIdsIn(n, out)); return out; }
  for (const [k, v] of Object.entries(node)) {
    if (k === "workspaceId") {
      if (v && typeof v === "object" && Array.isArray((v as any).$in)) {
        (v as any).$in.forEach((x: any) => out.push(String(x)));
      } else {
        out.push(String(v));
      }
    } else {
      workspaceIdsIn(v, out);
    }
  }
  return out;
}

beforeEach(() => {
  captured.find = []; captured.count = []; captured.aggregate = [];
  findResult = [];
  cwsLookupResult = null;
});

/* ─────────────────────────────────────────────────────────────────── */

describe("admin invoice reads — tenant gate", () => {
  it("non-privileged caller is confined to their own ids, in BOTH id-spaces", async () => {
    const res = await request(makeApp(tenantA)).get("/");
    expect(res.status).toBe(200);

    const filter = captured.find[0];
    const gate = gateOf(filter);
    expect(gate, "a tenant gate clause must be present in $and").toBeTruthy();

    const arms = gate.$or.map((a: any) => String(a.workspaceId)).sort();
    expect(arms).toEqual([String(CWS_A), String(CUST_A)].sort());
  });

  it("a tenant caller's filter has NO unrestricted path to another tenant", async () => {
    await request(makeApp(tenantA)).get("/");
    const filter = captured.find[0];

    // Nothing anywhere in the filter may reference a foreign workspace...
    const ids = workspaceIdsIn(filter);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect([String(CWS_A), String(CUST_A)]).toContain(id);
    }
    expect(ids).not.toContain(String(CWS_B));
    expect(ids).not.toContain(String(CUST_B));

    // ...and the count query must carry the same gate, or the pager leaks totals.
    expect(gateOf(captured.count[0])).toBeTruthy();
  });

  it("scope 'ALL' does NOT lift the gate (every live holder has scope ALL)", async () => {
    await request(makeApp({ ...tenantA, scope: "ALL" })).get("/");
    expect(gateOf(captured.find[0])).toBeTruthy();
  });

  it("SUPERADMIN is unrestricted", async () => {
    const res = await request(makeApp({ roles: ["SUPERADMIN"] })).get("/");
    expect(res.status).toBe(200);
    expect(gateOf(captured.find[0])).toBeFalsy();
    expect(captured.find[0].$and ?? []).toHaveLength(0);
  });

  it("HOUSE staff are unrestricted", async () => {
    const res = await request(makeApp({
      roles: ["ADMIN"],
      workspaceObjectId: HOUSE_WORKSPACE_ID,
    })).get("/");
    expect(res.status).toBe(200);
    expect(gateOf(captured.find[0])).toBeFalsy();
  });

  it("no resolvable workspace fails CLOSED, not open", async () => {
    const res = await request(makeApp({ roles: ["ADMIN"] })).get("/");
    expect(res.status).toBe(200);

    const gate = gateOf(captured.find[0]);
    expect(gate).toEqual({ _id: { $in: [] } });
    // The distinction that matters: an ABSENT clause is what "return
    // everything" looks like. Assert the clause is present, not just falsy-ish.
    expect(captured.find[0].$and).toContainEqual({ _id: { $in: [] } });
  });
});

describe("caller-supplied workspaceId narrows but cannot widen", () => {
  it("a tenant caller passing another tenant's id keeps their own gate", async () => {
    cwsLookupResult = { _id: CWS_B };
    await request(makeApp(tenantA)).get(`/?workspaceId=${String(CUST_B)}`);

    const filter = captured.find[0];
    const and: any[] = filter.$and;

    // BOTH clauses present as separate $and entries — this is the specific
    // regression guard. Two sibling `filter.workspaceId = …` assignments would
    // leave only the caller-controlled one, erasing the gate.
    expect(and.length).toBe(2);
    expect(gateOf(filter).$or.map((a: any) => String(a.workspaceId)).sort())
      .toEqual([String(CWS_A), String(CUST_A)].sort());

    const narrow = and.find((c) => c.workspaceId?.$in);
    expect(narrow.workspaceId.$in.map(String).sort())
      .toEqual([String(CUST_B), String(CWS_B)].sort());

    // The intersection of gate and narrowing is empty, so the caller sees
    // nothing — which is the point. Crucially, `workspaceId` is NOT a
    // top-level key that could have overwritten the gate.
    expect(filter.workspaceId).toBeUndefined();
  });

  it("staff narrowing to one client still produces exactly one clause", async () => {
    cwsLookupResult = { _id: CWS_B };
    await request(makeApp({ roles: ["SUPERADMIN"] })).get(`/?workspaceId=${String(CUST_B)}`);

    const and: any[] = captured.find[0].$and;
    expect(and).toHaveLength(1); // narrowing only, no gate for SUPERADMIN
    expect(and[0].workspaceId.$in.map(String).sort())
      .toEqual([String(CUST_B), String(CWS_B)].sort());
  });
});

describe("all five read paths share the builder", () => {
  const paths: Array<[string, string, () => any]> = [
    ["list",     "/",          () => captured.find[0]],
    ["export",   "/export",    () => captured.find[0]],
    ["bulk-pdf", "/bulk-pdf",  () => captured.find[0]],
    ["activity", "/activity",  () => captured.find[0]],
    ["insight",  "/insight",   () => captured.count[0]],
  ];

  for (const [name, path, pick] of paths) {
    it(`${name} is gated`, async () => {
      await request(makeApp(tenantA)).get(path);
      const filter = pick();
      expect(filter, `${name} issued no query`).toBeTruthy();
      expect(gateOf(filter), `${name} has no tenant gate`).toBeTruthy();
    });
  }

  it("insight gates every arm, including the outstanding-total aggregate", async () => {
    await request(makeApp(tenantA)).get("/insight");
    expect(captured.count).toHaveLength(3);
    for (const f of captured.count) expect(gateOf(f)).toBeTruthy();

    const match = captured.aggregate[0][0].$match;
    expect(gateOf(match)).toBeTruthy();
    // The base predicate must survive alongside the gate, not be replaced.
    expect(match.status.$in).toEqual(["DRAFT", "SENT", "PAYMENT_DECLARED"]);
  });

  it("insight's countDocuments arms keep their own predicates", async () => {
    await request(makeApp(tenantA)).get("/insight");
    expect(captured.count[0].status).toEqual({ $ne: "CANCELLED" });
    expect(captured.count[1].status).toBe("PAID");
    expect(captured.count[2].$expr).toBeTruthy();
  });
});

describe("invoiceNo search", () => {
  it("is applied at all (it was silently dropped before)", async () => {
    await request(makeApp(tenantA)).get("/?search=INV-2026");
    const f = captured.find[0];
    expect(f.invoiceNo).toBeTruthy();
    expect(f.invoiceNo.$in).toHaveLength(2);
  });

  it("offers an anchored, case-sensitive arm so the unique index is usable", async () => {
    await request(makeApp(tenantA)).get("/?search=inv-2026");
    const [anchored, loose] = captured.find[0].invoiceNo.$in;

    // "-" is not a metacharacter outside a character class, so escapeRegex
    // leaves it alone — the anchor and the upper-casing are what matter here.
    expect(anchored.source).toBe("^INV-2026");
    expect(anchored.flags).toBe("");          // case-sensitive => index-usable
    expect(anchored.test("INV-20260299")).toBe(true);
    expect(anchored.test("XINV-20260299")).toBe(false); // genuinely anchored

    expect(loose.flags).toBe("i");            // mid-string fallback
    expect(loose.test("XX-inv-2026")).toBe(true);
  });

  it("a regex-special character does not throw (bare '(' used to 500)", async () => {
    const res = await request(makeApp(tenantA)).get("/?search=" + encodeURIComponent("("));
    expect(res.status).toBe(200);
    const [anchored, loose] = captured.find[0].invoiceNo.$in;
    expect(anchored.test("(ABC")).toBe(true);
    expect(loose.test("x(y")).toBe(true);
  });

  it("input is treated as literal text, not as a pattern", async () => {
    await request(makeApp(tenantA)).get("/?search=" + encodeURIComponent(".*"));
    const [, loose] = captured.find[0].invoiceNo.$in;
    expect(loose.test("INV-2026")).toBe(false); // would match everything unescaped
    expect(loose.test("a.*b")).toBe(true);
  });

  it("search composes with the gate rather than replacing it", async () => {
    await request(makeApp(tenantA)).get("/?search=INV");
    expect(gateOf(captured.find[0])).toBeTruthy();
    expect(captured.find[0].invoiceNo).toBeTruthy();
  });
});

describe("date range is IST calendar days", () => {
  it("dateFrom is IST midnight and dateTo includes the whole last day", async () => {
    await request(makeApp(tenantA)).get("/?dateFrom=2026-09-01&dateTo=2026-09-30");
    const range = captured.find[0].generatedAt;

    expect(range.$gte.toISOString()).toBe("2026-08-31T18:30:00.000Z"); // 00:00 IST 1 Sep
    expect(range.$lte.toISOString()).toBe("2026-09-30T18:29:59.999Z"); // 23:59:59.999 IST 30 Sep

    // The old bare new Date("2026-09-30") was 2026-09-30T00:00:00Z — 05:30 IST
    // — which cut almost the entire final day.
    expect(range.$lte.getTime()).toBeGreaterThan(new Date("2026-09-30").getTime());
  });

  it("date range still carries the gate", async () => {
    await request(makeApp(tenantA)).get("/?dateFrom=2026-09-01");
    expect(gateOf(captured.find[0])).toBeTruthy();
  });
});
