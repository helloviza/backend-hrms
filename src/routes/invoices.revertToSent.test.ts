// Route-level coverage for the WIDENED POST /admin/invoices/:id/revert-to-sent
// — now accepts PAYMENT_DECLARED as a source status (staff rejecting a
// customer's payment claim that never arrived), alongside the original
// PAID -> SENT revert. Proves:
//   1. PAYMENT_DECLARED -> SENT succeeds, clears paymentDeclaredAt/
//      paymentDeclaredBy (not paidAt), and the editHistory entry's
//      oldValues carries the declaration fields, not paidAt;
//   2. PAID -> SENT (the original behaviour) is unchanged — still clears
//      paidAt, oldValues still carries paidAt not the declaration fields;
//   3. every other source status (DRAFT, SENT, CANCELLED) is still
//      rejected with 400 — this route never became a general-purpose revert;
//   4. reason is still required regardless of source status.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/rbac.js", () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

let currentInvoice: any = null;
const invoiceFindByIdMock = vi.fn();
vi.mock("../models/Invoice.js", () => ({
  default: { findById: (...args: any[]) => invoiceFindByIdMock(...args) },
}));

import express from "express";
import request from "supertest";
import router from "./invoices.js";

function makeInvoiceDoc(overrides: Record<string, any> = {}) {
  return {
    _id: "inv1",
    status: "PAID",
    paidAt: new Date("2026-07-01"),
    editHistory: [],
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { sub: "staff1", _id: "staff1", roles: ["ADMIN"] };
    next();
  });
  app.use("/", router);
  return app;
}

beforeEach(() => {
  invoiceFindByIdMock.mockReset();
  currentInvoice = null;
  invoiceFindByIdMock.mockImplementation(() => Promise.resolve(currentInvoice));
});

describe("POST /admin/invoices/:id/revert-to-sent — widened for PAYMENT_DECLARED", () => {
  it("PAYMENT_DECLARED -> SENT: clears declaration fields, not paidAt", async () => {
    currentInvoice = makeInvoiceDoc({
      status: "PAYMENT_DECLARED",
      paidAt: undefined,
      paymentDeclaredAt: new Date("2026-07-15"),
      paymentDeclaredBy: "customer1",
    });
    const app = makeApp();
    const res = await request(app).post("/inv1/revert-to-sent").send({ reason: "Customer confirmed no payment sent" });

    expect(res.status).toBe(200);
    expect(currentInvoice.status).toBe("SENT");
    expect(currentInvoice.paymentDeclaredAt).toBeUndefined();
    expect(currentInvoice.paymentDeclaredBy).toBeUndefined();
    const entry = currentInvoice.editHistory[0];
    expect(entry.oldValues).toMatchObject({ status: "PAYMENT_DECLARED", paymentDeclaredBy: "customer1" });
    expect(entry.oldValues.paidAt).toBeUndefined();
    expect(entry.newValues.reason).toBe("Customer confirmed no payment sent");
  });

  it("PAID -> SENT (original behaviour): still clears paidAt, unaffected by the widening", async () => {
    currentInvoice = makeInvoiceDoc({ status: "PAID", paidAt: new Date("2026-07-01") });
    const app = makeApp();
    const res = await request(app).post("/inv1/revert-to-sent").send({ reason: "Payment reversed by bank" });

    expect(res.status).toBe(200);
    expect(currentInvoice.status).toBe("SENT");
    expect(currentInvoice.paidAt).toBeUndefined();
    const entry = currentInvoice.editHistory[0];
    expect(entry.oldValues).toMatchObject({ status: "PAID" });
    expect(entry.oldValues.paymentDeclaredAt).toBeUndefined();
  });

  it.each(["DRAFT", "SENT", "CANCELLED"])(
    "still rejects with 400 when current status is %s — not a general-purpose revert",
    async (status) => {
      currentInvoice = makeInvoiceDoc({ status });
      const app = makeApp();
      const res = await request(app).post("/inv1/revert-to-sent").send({ reason: "test" });
      expect(res.status).toBe(400);
      expect(currentInvoice.save).not.toHaveBeenCalled();
    },
  );

  it("still requires a reason for a PAYMENT_DECLARED source", async () => {
    currentInvoice = makeInvoiceDoc({ status: "PAYMENT_DECLARED" });
    const app = makeApp();
    const res = await request(app).post("/inv1/revert-to-sent").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });
});
