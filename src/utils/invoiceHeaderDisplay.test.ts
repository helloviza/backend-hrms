// apps/backend/src/utils/invoiceHeaderDisplay.test.ts
//
// The invoice header's BALANCE DUE / DUE DATE boxes, by status:
//   • the rule itself (utils/invoiceHeaderDisplay.ts);
//   • the backend and frontend copies stay byte-identical below their 3-line
//     headers (skipped where the frontend isn't checked out — the backend-only
//     GitHub subtree);
//   • the real invoice PDF — the one staff, workspace customers and consumers
//     download — draws "Paid"/"Cancelled" and "NA" for PAID/CANCELLED, the
//     amount and due date for every other status, and the full Total always.
//
// Real: invoicePdf.ts rendering through PDFKit. The spy only records each
// string drawn (calls through). Company settings are injected via prefetch,
// so no database is needed.
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import { invoiceHeaderDisplay } from "./invoiceHeaderDisplay.js";
import { generateInvoicePdf } from "./invoicePdf.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendCopy = path.join(here, "invoiceHeaderDisplay.ts");
const frontendCopy = path.resolve(here, "../../../frontend/src/lib/invoiceHeaderDisplay.ts");
const body = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").split("\n").slice(3).join("\n");

describe.skipIf(!fs.existsSync(frontendCopy))("invoice header rule: PDF and screens agree", () => {
  it("the two copies are identical below the header", () => {
    expect(body(backendCopy)).toBe(body(frontendCopy));
  });
});

describe("invoiceHeaderDisplay", () => {
  it("PAID → Paid / NA, amount kept", () => {
    expect(invoiceHeaderDisplay({ status: "PAID", grandTotal: 11800 }))
      .toEqual({ balanceDueText: "Paid", balanceDueAmount: 11800, dueDateText: "NA" });
  });
  it("CANCELLED → Cancelled / NA", () => {
    expect(invoiceHeaderDisplay({ status: "CANCELLED", grandTotal: 11800 }))
      .toEqual({ balanceDueText: "Cancelled", balanceDueAmount: 11800, dueDateText: "NA" });
  });
  it.each(["DRAFT", "SENT", "PAYMENT_DECLARED", undefined])("%s → amount and due date as before", (status) => {
    expect(invoiceHeaderDisplay({ status, grandTotal: 11800 }))
      .toEqual({ balanceDueText: null, balanceDueAmount: 11800, dueDateText: null });
  });
  it("missing grandTotal reads as 0", () => {
    expect(invoiceHeaderDisplay({ status: "SENT" }).balanceDueAmount).toBe(0);
  });
});

const prefetch = { settings: { companyName: "Plumtrips" } as any, logoBuffer: null };
const invoice = (status: string) => ({
  invoiceNo: "PT/26-27/0001",
  status,
  invoiceDate: new Date("2026-10-01T00:00:00Z"),
  generatedAt: new Date("2026-10-01T00:00:00Z"),
  dueDate: new Date("2026-10-31T00:00:00Z"),
  clientDetails: { companyName: "Acme Ltd", state: "Karnataka" },
  lineItems: [{ description: "Flight DEL-BOM", quantity: 1, rate: 10000, amount: 11800, igst: 1800 }],
  subtotal: 10000,
  totalGST: 1800,
  grandTotal: 11800,
});

// Every string the renderer draws, in order.
async function pdfText(inv: any, options?: any): Promise<string[]> {
  const spy = vi.spyOn(PDFDocument.prototype as any, "text");
  try {
    const buf = await generateInvoicePdf(inv, prefetch, options);
    expect(buf.length).toBeGreaterThan(1000);
    return spy.mock.calls.map((a: any[]) => String(a[0]));
  } finally {
    spy.mockRestore();
  }
}

// The value drawn right after a caption ("BALANCE DUE" → its value).
const after = (t: string[], caption: string) => t[t.indexOf(caption) + 1];
const TOTAL = "11,800.00";

describe("invoice PDF header", () => {
  it("PAID: BALANCE DUE Paid, DUE DATE NA, Total still the full amount", async () => {
    const t = await pdfText(invoice("PAID"), { paid: true });
    expect(after(t, "BALANCE DUE")).toBe("Paid");
    expect(after(t, "DUE DATE")).toBe("NA");
    expect(t).not.toContain("AMOUNT PAID");
    expect(t.some((s) => s.includes(TOTAL))).toBe(true);
  });

  it("CANCELLED: BALANCE DUE Cancelled, DUE DATE NA, Total unchanged", async () => {
    const t = await pdfText(invoice("CANCELLED"), { paid: false });
    expect(after(t, "BALANCE DUE")).toBe("Cancelled");
    expect(after(t, "DUE DATE")).toBe("NA");
    expect(t.some((s) => s.includes(TOTAL))).toBe(true);
  });

  it.each(["SENT", "PAYMENT_DECLARED", "DRAFT"])("%s: amount and due date as today", async (status) => {
    const t = await pdfText(invoice(status), { paid: false });
    expect(after(t, "BALANCE DUE")).toContain(TOTAL);
    expect(after(t, "DUE DATE")).toBe("31/10/2026");
  });

  it("consumer receipt (paid: true asserted by the caller) reads Paid / NA whatever the stored status", async () => {
    const t = await pdfText(invoice("SENT"), { hideBankDetails: true, paid: true });
    expect(after(t, "BALANCE DUE")).toBe("Paid");
    expect(after(t, "DUE DATE")).toBe("NA");
    expect(t.some((s) => s.includes(TOTAL))).toBe(true);
  });
});
