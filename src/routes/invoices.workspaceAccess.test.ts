// Route-level coverage for the NEW requireInvoiceAccess gate on the
// customer-facing invoices router (GET /mine). Before this gate, the route
// only checked requireAuth + requireWorkspace — any authenticated workspace
// member could read every invoice for the tenant regardless of role or the
// canViewBilling flag. Proves:
//   1. admin roles bypass;
//   2. WORKSPACE_LEADER bypasses canViewBilling (matches admin.billing.ts's
//      documented WL-bypass);
//   3. a plain member needs canViewBilling===true, else 403
//      BILLING_ACCESS_DENIED;
//   4. a user whose own User.customerId doesn't match the resolved workspace
//      is denied even if their own canViewBilling is true (cross-tenant
//      guard) — the toggle is only for connecting billing WITHIN the
//      caller's own workspace, never a cross-tenant bypass.
//
// requireAuth / requireWorkspace are NOT part of this router (mounted by
// server.ts) — the test injects req.user / req.workspace / req.workspaceObjectId
// directly, same approach as myBookings.manual.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

// invoices.ts's workspaceRouter bakes in its OWN requireAuth/requireWorkspace
// via router.use(...) (unlike myBookings.ts, which relies on server.ts to
// apply them externally) — mock both as passthroughs so the test's injected
// req.user/req.workspace/req.workspaceObjectId (set by makeApp below) reach
// requireInvoiceAccess untouched, instead of requireAuth 401ing on a real
// JWT that was never sent.
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));

const findByIdMock = vi.fn();
vi.mock("../models/User.js", () => ({
  default: { findById: (...args: any[]) => ({ select: () => ({ lean: () => findByIdMock(...args) }) }) },
}));

const invoiceFindMock = vi.fn();
const invoiceCountMock = vi.fn();
vi.mock("../models/Invoice.js", () => ({
  default: {
    find: (...args: any[]) => ({
      sort: () => ({ skip: () => ({ limit: () => ({ lean: () => invoiceFindMock(...args) }) }) }),
    }),
    countDocuments: (...args: any[]) => invoiceCountMock(...args),
  },
}));

import express from "express";
import request from "supertest";
import { workspaceRouter } from "./invoices.js";

const COMPANY_A_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const COMPANY_B_ID = "cccccccccccccccccccccccc";

function makeApp(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspace = { customerId: COMPANY_A_ID };
    req.workspaceObjectId = COMPANY_A_ID;
    next();
  });
  app.use("/", workspaceRouter);
  return app;
}

beforeEach(() => {
  findByIdMock.mockReset();
  invoiceFindMock.mockReset().mockResolvedValue([]);
  invoiceCountMock.mockReset().mockResolvedValue(0);
});

describe("GET /invoices/workspace/mine — requireInvoiceAccess", () => {
  it("admin role bypasses — no User lookup needed", async () => {
    const app = makeApp({ sub: "u1", roles: ["ADMIN"] });
    const res = await request(app).get("/mine");
    expect(res.status).toBe(200);
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it("WORKSPACE_LEADER bypasses canViewBilling entirely", async () => {
    const app = makeApp({ sub: "u2", roles: ["WORKSPACE_LEADER"], customerMemberRole: "WORKSPACE_LEADER" });
    const res = await request(app).get("/mine");
    expect(res.status).toBe(200);
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it("plain member with canViewBilling=true is allowed", async () => {
    findByIdMock.mockResolvedValue({ customerId: COMPANY_A_ID, canViewBilling: true });
    const app = makeApp({ sub: "u3", roles: ["CUSTOMER"] });
    const res = await request(app).get("/mine");
    expect(res.status).toBe(200);
  });

  it("plain member with canViewBilling=false is denied with BILLING_ACCESS_DENIED", async () => {
    findByIdMock.mockResolvedValue({ customerId: COMPANY_A_ID, canViewBilling: false });
    const app = makeApp({ sub: "u4", roles: ["CUSTOMER"] });
    const res = await request(app).get("/mine");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("BILLING_ACCESS_DENIED");
    expect(invoiceFindMock).not.toHaveBeenCalled();
  });

  it("plain member with no canViewBilling field at all is denied (default-deny, not default-allow)", async () => {
    findByIdMock.mockResolvedValue({ customerId: COMPANY_A_ID });
    const app = makeApp({ sub: "u5", roles: ["CUSTOMER"] });
    const res = await request(app).get("/mine");
    expect(res.status).toBe(403);
  });

  it("denies a user whose own User.customerId doesn't match the resolved workspace, even with canViewBilling=true", async () => {
    findByIdMock.mockResolvedValue({ customerId: COMPANY_B_ID, canViewBilling: true });
    const app = makeApp({ sub: "u6", roles: ["CUSTOMER"] });
    const res = await request(app).get("/mine");
    expect(res.status).toBe(403);
    expect(invoiceFindMock).not.toHaveBeenCalled();
  });
});
