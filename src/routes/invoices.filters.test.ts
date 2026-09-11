// Filter-enhancement coverage for /admin/invoices.
//
// Asserts on the filter object, and runs each case against BOTH the list and
// the export — they share buildInvoiceReadFilter, and that sharing is what
// makes "export what I'm filtering" true rather than aspirational.
//
// NO DATABASE — .env points at PROD Atlas; every model and requirePermission
// is mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/rbac.js", () => ({ requireAdmin: (_r: any, _s: any, n: any) => n() }));
vi.mock("../middleware/requireWorkspace.js", () => ({ requireWorkspace: (_r: any, _s: any, n: any) => n() }));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.permissionScope = "ALL"; req.permissionAccess = "FULL"; next();
  },
  requireAnyPermission: () => (_r: any, _s: any, n: any) => n(),
}));

const capturedFind: any[] = [];
const capturedAgg: any[] = [];
vi.mock("../models/Invoice.js", () => {
  const chain = (): any => {
    const node: any = {
      sort: () => node, skip: () => node, limit: () => node,
      lean: () => Promise.resolve([]),
      then: (r: any, j: any) => Promise.resolve([]).then(r, j),
    };
    return node;
  };
  return {
    default: {
      find: (f: any) => { (globalThis as any).__invFind.push(f); return chain(); },
      countDocuments: () => Promise.resolve(0),
      aggregate: (p: any) => { (globalThis as any).__invAgg.push(p); return Promise.resolve([]); },
    },
  };
});
(globalThis as any).__invFind = capturedFind;
(globalThis as any).__invAgg = capturedAgg;

vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }),
    findById: () => ({ lean: () => Promise.resolve(null) }),
  },
}));
vi.mock("../models/Customer.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
}));
vi.mock("../models/User.js", () => ({ default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) } }));
vi.mock("../models/ManualBooking.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));
vi.mock("../models/CreditNote.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));
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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // SUPERADMIN — gate coverage lives in invoices.tenantScope.test.ts; this
    // file is about the non-gate filter params.
    req.user = { _id: String(new mongoose.Types.ObjectId()), roles: ["SUPERADMIN"] };
    next();
  });
  app.use("/", router);
  return app;
}

async function bothPaths(qs: string) {
  capturedFind.length = 0;
  await request(makeApp()).get(`/${qs}`);
  const list = capturedFind[0];
  capturedFind.length = 0;
  await request(makeApp()).get(`/export${qs}`);
  const exp = capturedFind[0];
  return { list, exp };
}

beforeEach(() => { capturedFind.length = 0; capturedAgg.length = 0; });

describe("multi-select status", () => {
  it("single value stays an equality", async () => {
    const { list, exp } = await bothPaths("?status=PAID");
    expect(list.status).toBe("PAID");
    expect(exp.status).toBe("PAID");
  });

  it("'everything unpaid' becomes one $in instead of three page loads", async () => {
    const { list, exp } = await bothPaths("?status=DRAFT,SENT,PAYMENT_DECLARED");
    const want = { $in: ["DRAFT", "SENT", "PAYMENT_DECLARED"] };
    expect(list.status).toEqual(want);
    expect(exp.status).toEqual(want);
  });

  it("drops unknown values", async () => {
    const { list } = await bothPaths("?status=PAID,PENDING,SENT");
    // PENDING is a BOOKING status, not an invoice one.
    expect(list.status).toEqual({ $in: ["PAID", "SENT"] });
  });

  it("all-invalid matches nothing", async () => {
    const { list } = await bothPaths("?status=WIP");
    expect(list.status).toEqual({ $in: [] });
  });
});

describe("supplyType (GST type)", () => {
  it("is an exact match", async () => {
    const { list, exp } = await bothPaths("?supplyType=CGST_SGST");
    expect(list.supplyType).toBe("CGST_SGST");
    expect(exp.supplyType).toBe("CGST_SGST");
  });

  it("supports multi-select", async () => {
    const { list } = await bothPaths("?supplyType=IGST,EXPORT");
    expect(list.supplyType).toEqual({ $in: ["IGST", "EXPORT"] });
  });

  it("rejects a value outside the enum", async () => {
    const { list } = await bothPaths("?supplyType=VAT");
    expect(list.supplyType).toEqual({ $in: [] });
  });
});

describe("dateField", () => {
  it("defaults to generatedAt", async () => {
    const { list, exp } = await bothPaths("?dateFrom=2026-09-01&dateTo=2026-09-30");
    expect(list.generatedAt).toBeTruthy();
    expect(list.invoiceDate).toBeUndefined();
    expect(exp.generatedAt).toBeTruthy();
  });

  it("switches the range onto invoiceDate when asked", async () => {
    const { list, exp } = await bothPaths("?dateField=invoiceDate&dateFrom=2026-09-01&dateTo=2026-09-30");
    expect(list.invoiceDate).toBeTruthy();
    expect(list.generatedAt).toBeUndefined();
    expect(exp.invoiceDate).toBeTruthy();
    expect(exp.generatedAt).toBeUndefined();
  });

  it("falls back to generatedAt for a field outside the whitelist", async () => {
    // Without the whitelist this would aim the range at an arbitrary path.
    const { list } = await bothPaths("?dateField=grandTotal&dateFrom=2026-09-01");
    expect(list.generatedAt).toBeTruthy();
    expect(list.grandTotal).toBeUndefined();
  });

  it("applies inclusive IST bounds on whichever field is chosen", async () => {
    const { list } = await bothPaths("?dateField=invoiceDate&dateFrom=2026-09-01&dateTo=2026-09-30");
    expect(list.invoiceDate.$gte.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(list.invoiceDate.$lte.toISOString()).toBe("2026-09-30T18:29:59.999Z");
  });
});

describe("search", () => {
  it("a bare '(' does not throw", async () => {
    capturedFind.length = 0;
    const res = await request(makeApp()).get("/?search=" + encodeURIComponent("("));
    expect(res.status).toBe(200);
    const [anchored, loose] = capturedFind[0].invoiceNo.$in;
    expect(anchored.test("(X")).toBe(true);
    expect(loose.test("a(b")).toBe(true);
  });

  it("reaches the export path too", async () => {
    const { exp } = await bothPaths("?search=INV-DEMO");
    expect(exp.invoiceNo).toBeTruthy();
    expect(exp.invoiceNo.$in).toHaveLength(2);
  });
});

describe("stats aggregate", () => {
  it("runs over the SAME filter object as the rows", async () => {
    capturedFind.length = 0; capturedAgg.length = 0;
    await request(makeApp()).get("/?status=PAID&supplyType=IGST");

    const match = capturedAgg[0][0].$match;
    // Identical predicate — if these ever diverge the cards describe a
    // different set from the table, which is the bug being designed out.
    expect(match.status).toEqual(capturedFind[0].status);
    expect(match.supplyType).toEqual(capturedFind[0].supplyType);
  });

  it("groups the five card figures", async () => {
    await request(makeApp()).get("/");
    const group = capturedAgg[0][1].$group;
    for (const k of ["totalReceivables", "outstanding", "pendingCount", "overdueCount", "settledToday"]) {
      expect(group, `${k} missing from the stats aggregate`).toHaveProperty(k);
    }
  });

  it("returns zeroed stats when the aggregate matches nothing", async () => {
    const res = await request(makeApp()).get("/?status=CANCELLED");
    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({
      totalReceivables: 0, outstanding: 0, settledToday: 0, pendingCount: 0, overdueCount: 0,
    });
  });
});

describe("every new param reaches the export path", () => {
  it("a fully-loaded query produces the same non-gate filter on both", async () => {
    const qs = "?status=DRAFT,SENT&supplyType=IGST&dateField=invoiceDate" +
               "&dateFrom=2026-09-01&dateTo=2026-09-30&search=INV";
    const { list, exp } = await bothPaths(qs);
    expect(exp.status).toEqual(list.status);
    expect(exp.supplyType).toEqual(list.supplyType);
    expect(exp.invoiceDate.$gte.getTime()).toBe(list.invoiceDate.$gte.getTime());
    expect(exp.invoiceDate.$lte.getTime()).toBe(list.invoiceDate.$lte.getTime());
    expect(exp.invoiceNo).toBeTruthy();
  });
});
