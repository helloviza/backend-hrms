// Route-level coverage for PUT /invoices/workspace/:id/declare-payment —
// the customer-only SENT -> PAYMENT_DECLARED transition. Proves:
//   1. SENT invoices transition to PAYMENT_DECLARED, stamping
//      paymentDeclaredAt/paymentDeclaredBy and an editHistory entry tagged
//      source:"customer_portal" (so finance can tell a customer declaration
//      from a staff action without cross-referencing editedBy's role);
//   2. every other source status (DRAFT, PAYMENT_DECLARED, PAID, CANCELLED)
//      is rejected with 400 — a customer can never set PAID/DRAFT/CANCELLED
//      directly, and can never re-declare or reverse;
//   3. workspace-scoped — an invoice belonging to a different workspace is
//      404, never touched;
//   4. the route inherits requireInvoiceAccess (mounted once via
//      workspaceRouter.use(...) above it) — a canViewBilling=false, non-leader
//      caller is denied before the transition logic ever runs.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));

const userFindByIdMock = vi.fn();
vi.mock("../models/User.js", () => ({
  default: { findById: (...args: any[]) => ({ select: () => ({ lean: () => userFindByIdMock(...args) }) }) },
}));

function makeInvoiceDoc(overrides: Record<string, any> = {}) {
  const doc: any = {
    _id: "inv1",
    status: "SENT",
    workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    grandTotal: 21004.46,
    invoiceNo: "INV-20260001",
    editHistory: [],
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return doc;
}

let currentInvoice: any = null;
const invoiceFindOneMock = vi.fn();
vi.mock("../models/Invoice.js", () => ({
  default: {
    findOne: (...args: any[]) => invoiceFindOneMock(...args),
    find: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) }),
    countDocuments: () => Promise.resolve(0),
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

const LEADER = { sub: "u1", _id: "u1", roles: ["WORKSPACE_LEADER"], customerMemberRole: "WORKSPACE_LEADER" };

beforeEach(() => {
  userFindByIdMock.mockReset();
  invoiceFindOneMock.mockReset();
  currentInvoice = null;
  invoiceFindOneMock.mockImplementation(() => Promise.resolve(currentInvoice));
});

describe("PUT /invoices/workspace/:id/declare-payment", () => {
  it("SENT -> PAYMENT_DECLARED succeeds and tags editHistory with source:customer_portal", async () => {
    currentInvoice = makeInvoiceDoc({ status: "SENT" });
    const app = makeApp(LEADER);
    const res = await request(app).put("/inv1/declare-payment");

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe("PAYMENT_DECLARED");
    expect(currentInvoice.paymentDeclaredAt).toBeInstanceOf(Date);
    expect(currentInvoice.paymentDeclaredBy).toBe("u1");
    expect(currentInvoice.editHistory).toHaveLength(1);
    expect(currentInvoice.editHistory[0]).toMatchObject({
      fieldsChanged: ["status"],
      oldValues: { status: "SENT" },
      source: "customer_portal",
    });
    expect(currentInvoice.save).toHaveBeenCalledOnce();
  });

  it.each(["DRAFT", "PAYMENT_DECLARED", "PAID", "CANCELLED"])(
    "rejects with 400 when current status is %s",
    async (status) => {
      currentInvoice = makeInvoiceDoc({ status });
      const app = makeApp(LEADER);
      const res = await request(app).put("/inv1/declare-payment");
      expect(res.status).toBe(400);
      expect(currentInvoice.save).not.toHaveBeenCalled();
    },
  );

  it("404s (not found) for an invoice belonging to a different workspace — never leaks or touches it", async () => {
    // findOne is called with {_id, workspaceId: req.workspaceObjectId} — a
    // cross-tenant invoice simply won't match that filter in real Mongo, so
    // the mock returning null here models that correctly.
    currentInvoice = null;
    const app = makeApp(LEADER);
    const res = await request(app).put("/inv1/declare-payment");
    expect(res.status).toBe(404);
    expect(invoiceFindOneMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: COMPANY_A_ID }),
    );
  });

  it("inherits requireInvoiceAccess — a non-leader with canViewBilling=false is denied before any transition logic runs", async () => {
    currentInvoice = makeInvoiceDoc({ status: "SENT" });
    userFindByIdMock.mockResolvedValue({ customerId: COMPANY_A_ID, canViewBilling: false });
    const app = makeApp({ sub: "u2", _id: "u2", roles: ["CUSTOMER"] });
    const res = await request(app).put("/inv1/declare-payment");
    expect(res.status).toBe(403);
    expect(invoiceFindOneMock).not.toHaveBeenCalled();
  });
});
