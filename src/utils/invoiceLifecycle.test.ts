// utils/invoiceLifecycle.test.ts — the invoice status state machine.
// Every allowed move (with its owning route), the route ownership of each
// move, reason enforcement, and a sample of moves that must never happen.
import { describe, it, expect } from "vitest";
import {
  assertInvoiceTransition,
  allowedInvoiceTransitions,
  InvoiceTransitionError,
  INVOICE_STATUSES,
  type InvoiceTransitionRoute,
} from "./invoiceLifecycle.js";

const refused = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InvoiceTransitionError);
    expect((e as InvoiceTransitionError).httpStatus).toBe(400);
    return (e as Error).message;
  }
  throw new Error("expected the transition to be refused");
};

describe("allowed moves, each through its own route", () => {
  const ALLOWED: Array<[string, string, InvoiceTransitionRoute, string?]> = [
    ["DRAFT", "SENT", "status"],
    ["DRAFT", "SENT", "bulk-mark-sent"],
    ["SENT", "PAYMENT_DECLARED", "declare-payment"],
    ["SENT", "PAID", "status"],
    ["SENT", "PAID", "bulk-mark-paid"],
    ["PAYMENT_DECLARED", "PAID", "status"],
    ["PAYMENT_DECLARED", "PAID", "bulk-mark-paid"],
    ["PAID", "SENT", "revert-to-sent", "money never arrived"],
    ["PAYMENT_DECLARED", "SENT", "revert-to-sent", "claim rejected"],
    ["SENT", "DRAFT", "revert-to-draft", "wrong client"],
    ["DRAFT", "CANCELLED", "cancel", "duplicate"],
    ["SENT", "CANCELLED", "cancel", "duplicate"],
    ["PAYMENT_DECLARED", "CANCELLED", "cancel", "duplicate"],
  ];
  it.each(ALLOWED)("%s → %s via %s", (from, to, via, reason) => {
    expect(() => assertInvoiceTransition(from, to, { via, reason })).not.toThrow();
    expect(() => assertInvoiceTransition(from, to)).not.toThrow();
  });

  it("allowedInvoiceTransitions lists exactly the machine's targets", () => {
    expect(allowedInvoiceTransitions("DRAFT").sort()).toEqual(["CANCELLED", "SENT"]);
    expect(allowedInvoiceTransitions("SENT").sort()).toEqual(["CANCELLED", "DRAFT", "PAID", "PAYMENT_DECLARED"]);
    expect(allowedInvoiceTransitions("PAYMENT_DECLARED").sort()).toEqual(["CANCELLED", "PAID", "SENT"]);
    expect(allowedInvoiceTransitions("PAID")).toEqual(["SENT"]);
    expect(allowedInvoiceTransitions("CANCELLED")).toEqual([]);
  });
});

describe("illegal moves are refused whatever the route", () => {
  it("nothing leaves CANCELLED", () => {
    for (const to of INVOICE_STATUSES.filter((s) => s !== "CANCELLED")) {
      expect(refused(() => assertInvoiceTransition("CANCELLED", to))).toMatch(/cancelled invoice is final/i);
    }
  });

  it("PAID → CANCELLED points at the credit-note flow", () => {
    expect(refused(() => assertInvoiceTransition("PAID", "CANCELLED", { via: "cancel", reason: "x" }))).toMatch(/credit note/i);
  });

  it("DRAFT → PAID must go via SENT", () => {
    expect(refused(() => assertInvoiceTransition("DRAFT", "PAID", { via: "status" }))).toMatch(/SENT first/);
  });

  it.each([
    ["PAID", "DRAFT"],
    ["PAID", "PAYMENT_DECLARED"],
    ["PAYMENT_DECLARED", "DRAFT"],
    ["DRAFT", "PAYMENT_DECLARED"],
  ])("%s → %s is not a transition", (from, to) => {
    expect(refused(() => assertInvoiceTransition(from, to))).toMatch(/not an allowed invoice transition/);
  });

  it("same status and unknown statuses are refused", () => {
    expect(refused(() => assertInvoiceTransition("SENT", "SENT"))).toMatch(/already SENT/);
    expect(refused(() => assertInvoiceTransition("SENT", "VOID"))).toMatch(/Unknown invoice status/);
    expect(refused(() => assertInvoiceTransition("WEIRD", "SENT"))).toMatch(/unknown status/);
  });
});

describe("a legal move through the wrong route names the right one", () => {
  it.each([
    ["SENT", "CANCELLED", "status", /\/:id\/cancel.*reason is required/],
    ["DRAFT", "CANCELLED", "status", /\/:id\/cancel/],
    ["SENT", "DRAFT", "status", /revert-to-draft.*reason is required/],
    ["PAID", "SENT", "status", /revert-to-sent.*reason is required/],
    ["PAYMENT_DECLARED", "SENT", "bulk-mark-sent", /revert-to-sent/],
    ["SENT", "PAYMENT_DECLARED", "status", /declare-payment/],
    ["DRAFT", "SENT", "bulk-mark-paid", /status|bulk-mark-sent/],
    ["SENT", "PAID", "revert-to-sent", /PUT \/api\/admin\/invoices\/:id\/status/],
  ] as Array<[string, string, InvoiceTransitionRoute, RegExp]>)("%s → %s via %s", (from, to, via, msg) => {
    expect(refused(() => assertInvoiceTransition(from, to, { via, reason: "some reason" }))).toMatch(msg);
  });
});

describe("reason-required moves", () => {
  it.each([
    ["PAID", "SENT", "revert-to-sent"],
    ["SENT", "DRAFT", "revert-to-draft"],
    ["SENT", "CANCELLED", "cancel"],
  ] as Array<[string, string, InvoiceTransitionRoute]>)("%s → %s via %s refuses a blank reason", (from, to, via) => {
    expect(refused(() => assertInvoiceTransition(from, to, { via }))).toMatch(/reason is required/);
    expect(refused(() => assertInvoiceTransition(from, to, { via, reason: "   " }))).toMatch(/reason is required/);
  });

  it("forward marks need no reason", () => {
    expect(() => assertInvoiceTransition("DRAFT", "SENT", { via: "status" })).not.toThrow();
    expect(() => assertInvoiceTransition("SENT", "PAID", { via: "bulk-mark-paid" })).not.toThrow();
  });
});
