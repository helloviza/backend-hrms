// services/partnerRevenue.ts — the pure maths: formula, cost-0 exclusion,
// credit-note reduction. Persistence and the routes are covered by
// routes/partnerRevenue.test.ts on a real (in-memory) database.
import { describe, it, expect } from "vitest";
import {
  computePartnerShare,
  creditRatioForBooking,
  bookingGrandTotal,
  refsOfLine,
  netOfCredit,
  hasCostPrice,
  isValidPartnerPct,
} from "./partnerRevenue.js";

const CONFIG = { enabled: true, visiblePct: 50, sharePct: 40, version: 3 };
const booking = (basePrice: number, actualPrice = 10_000) => ({ pricing: { actualPrice, basePrice } });

describe("computePartnerShare — bakedIn = basePrice × visible%, share = bakedIn × share%", () => {
  it("applies both percents to the GST-free margin", () => {
    const s = computePartnerShare(booking(1000), CONFIG, new Date("2026-10-22T00:00:00Z"))!;
    expect(s).toMatchObject({ visiblePct: 50, sharePct: 40, configVersion: 3, marginBase: 1000, bakedIn: 500, share: 200 });
    expect(s.at.toISOString()).toBe("2026-10-22T00:00:00.000Z");
  });

  it("rounds to paise", () => {
    const s = computePartnerShare(booking(847.46), { ...CONFIG, visiblePct: 33.3, sharePct: 12.5 })!;
    expect(s.bakedIn).toBe(282.2); // 847.46 × 0.333 = 282.20418
    expect(s.share).toBe(35.28); // 282.20 × 0.125 = 35.275
  });

  it("0% and 100% are both valid edges", () => {
    expect(computePartnerShare(booking(1000), { ...CONFIG, visiblePct: 100, sharePct: 100 })).toMatchObject({ bakedIn: 1000, share: 1000 });
    expect(computePartnerShare(booking(1000), { ...CONFIG, visiblePct: 0 })).toMatchObject({ bakedIn: 0, share: 0 });
  });

  it("a loss booking earns 0 — the partner is never charged for it", () => {
    expect(computePartnerShare(booking(-250), CONFIG)).toMatchObject({ marginBase: -250, bakedIn: 0, share: 0 });
  });

  it("no snapshot when the cost price is 0 or missing", () => {
    expect(computePartnerShare(booking(1000, 0), CONFIG)).toBeNull();
    expect(computePartnerShare({ pricing: { basePrice: 1000 } }, CONFIG)).toBeNull();
    expect(hasCostPrice({ pricing: { actualPrice: 1 } })).toBe(true);
    expect(hasCostPrice({})).toBe(false);
  });

  it("no snapshot when the config is absent or disabled", () => {
    expect(computePartnerShare(booking(1000), null)).toBeNull();
    expect(computePartnerShare(booking(1000), { ...CONFIG, enabled: false })).toBeNull();
  });

  it("refuses an out-of-range percent rather than paying it", () => {
    expect(computePartnerShare(booking(1000), { ...CONFIG, sharePct: 150 })).toBeNull();
    expect(isValidPartnerPct(-1)).toBe(false);
    expect(isValidPartnerPct("50")).toBe(false);
    expect(isValidPartnerPct(100)).toBe(true);
  });
});

describe("credit notes — weighted: the credited fraction of what was invoiced for the booking", () => {
  const INV = "6a0000000000000000000001";
  const OTHER_INV = "6a0000000000000000000002";
  const snap = { bakedIn: 500, share: 200 };
  const MB1 = { bookingRef: "MB-1", invoiceId: INV };
  const MB2 = { bookingRef: "MB-2", invoiceId: INV };
  const NO_TOTALS = new Map<string, number>();

  // Invoice lines exactly as utils/invoiceLineItems.ts emits them.
  const cost = (bookingRef: string, amount: number, description = "Air Ticket") => ({ bookingRef, rowType: "COST", description, amount });
  const fee = (bookingRef: string, amount: number) => ({ bookingRef, rowType: "SERVICE_FEE", description: "Transaction Fees", amount });
  const invoice = (lineItems: any[], _id = INV) => ({ _id, lineItems });
  // A credit-note line carries the invoice line's key plus what was credited.
  const credit = (line: any, creditedAmount: number) => ({ ...line, originalAmount: line.amount, creditedAmount, amount: creditedAmount });
  const cn = (lineItems: any[], extra: Record<string, unknown> = {}) => ({ status: "ISSUED", originalInvoiceId: INV, creditNoteNo: "CN-1", lineItems, ...extra });

  // ON_MARKUP booking: COST 10000 + Transaction Fees 1180 = 11180 invoiced.
  const ON_MARKUP = invoice([cost("MB-1", 10_000), fee("MB-1", 1180)]);

  it("ON_MARKUP, 50% credited on BOTH lines → the share halves", () => {
    const ratio = creditRatioForBooking(MB1, ON_MARKUP, [cn([credit(cost("MB-1", 10_000), 5_000), credit(fee("MB-1", 1180), 590)])], NO_TOTALS);
    expect(ratio).toBe(0.5);
    expect(netOfCredit(snap, ratio)).toEqual({ bakedIn: 250, share: 100 });
  });

  it("only the cost line credited 100% → the share drops by that line's weight (10000 / 11180)", () => {
    const ratio = creditRatioForBooking(MB1, ON_MARKUP, [cn([credit(cost("MB-1", 10_000), 10_000)])], NO_TOTALS);
    expect(ratio).toBeCloseTo(10_000 / 11_180, 10);
    expect(netOfCredit(snap, ratio)).toEqual({ bakedIn: 52.77, share: 21.11 }); // × 1180/11180
  });

  it("only the fee line credited 50% → reduced by half of the fee's weight", () => {
    const ratio = creditRatioForBooking(MB1, ON_MARKUP, [cn([credit(fee("MB-1", 1180), 590)])], NO_TOTALS);
    expect(ratio).toBeCloseTo(590 / 11_180, 10);
    expect(netOfCredit(snap, ratio)).toEqual({ bakedIn: 473.61, share: 189.45 });
  });

  it("ON_FULL: its single line credited 25% → share × 0.75", () => {
    const onFull = invoice([cost("MB-1", 12_980)]);
    const ratio = creditRatioForBooking(MB1, onFull, [cn([credit(cost("MB-1", 12_980), 3_245)])], NO_TOTALS);
    expect(ratio).toBe(0.25);
    expect(netOfCredit(snap, ratio)).toEqual({ bakedIn: 375, share: 150 });
  });

  it('combined "MB-1, MB-2" line with unequal grand totals — each booking reduced by its own weight', () => {
    // MB-1 (11180) and MB-2 (22360) share one combined line of 33540; MB-1 also
    // has a 5000 line of its own. Half the combined line is credited.
    const combined = cost("MB-1, MB-2", 33_540);
    const inv = invoice([combined, cost("MB-1", 5_000, "Visa Fee")]);
    const totals = new Map([["MB-1", 11_180], ["MB-2", 22_360]]);
    const notes = [cn([credit(combined, 16_770)])];

    // MB-1: portion 33540 × 1/3 = 11180, half credited = 5590; invoiced 11180 + 5000.
    const r1 = creditRatioForBooking(MB1, inv, notes, totals);
    expect(r1).toBeCloseTo(5_590 / 16_180, 10);
    expect(netOfCredit(snap, r1).share).toBe(130.9);
    // MB-2: portion 33540 × 2/3 = 22360, half credited; nothing else invoiced.
    const r2 = creditRatioForBooking(MB2, inv, notes, totals);
    expect(r2).toBeCloseTo(0.5, 10);
    expect(netOfCredit(snap, r2).share).toBe(100);
    // An even split would have given MB-1 8385 / 21770 — the weights matter.
    expect(r1).not.toBeCloseTo(8_385 / 21_770, 3);
  });

  it("combined line with no grand totals falls back to an even split", () => {
    const combined = cost("MB-1, MB-2", 20_000);
    const r = creditRatioForBooking(MB1, invoice([combined]), [cn([credit(combined, 5_000)])], NO_TOTALS);
    expect(r).toBe(0.25);
  });

  it("full credit → 0", () => {
    const notes = [cn([credit(cost("MB-1", 10_000), 10_000), credit(fee("MB-1", 1180), 1180)], { isFullCredit: true })];
    expect(netOfCredit(snap, creditRatioForBooking(MB1, ON_MARKUP, notes, NO_TOTALS))).toEqual({ bakedIn: 0, share: 0 });
  });

  it("several credit notes on one booking are summed per line", () => {
    const notes = [
      cn([credit(cost("MB-1", 10_000), 2_500)]),
      cn([credit(cost("MB-1", 10_000), 2_500), credit(fee("MB-1", 1180), 590)], { creditNoteNo: "CN-2" }),
    ];
    const ratio = creditRatioForBooking(MB1, ON_MARKUP, notes, NO_TOTALS);
    expect(ratio).toBe(0.5); // (5000 + 590) / 11180
    expect(netOfCredit(snap, ratio)).toEqual({ bakedIn: 250, share: 100 });
  });

  it("…and capped: a line credited twice in full counts once, the booking never past 1", () => {
    const feeTwice = [cn([credit(fee("MB-1", 1180), 1180)]), cn([credit(fee("MB-1", 1180), 1180)], { creditNoteNo: "CN-2" })];
    expect(creditRatioForBooking(MB1, ON_MARKUP, feeTwice, NO_TOTALS)).toBeCloseTo(1180 / 11_180, 10);
    const everythingTwice = [
      cn([credit(cost("MB-1", 10_000), 10_000), credit(fee("MB-1", 1180), 1180)]),
      cn([credit(cost("MB-1", 10_000), 10_000), credit(fee("MB-1", 1180), 1180)], { creditNoteNo: "CN-2" }),
    ];
    expect(creditRatioForBooking(MB1, ON_MARKUP, everythingTwice, NO_TOTALS)).toBe(1);
    expect(netOfCredit(snap, 3)).toEqual({ bakedIn: 0, share: 0 });
  });

  it("a booking on no line of its invoice is not reduced", () => {
    expect(creditRatioForBooking({ bookingRef: "MB-9", invoiceId: INV }, ON_MARKUP, [cn([credit(fee("MB-1", 1180), 1180)])], NO_TOTALS)).toBe(0);
  });

  it("ignores DRAFT / CANCELLED notes, notes on another invoice, another invoice's lines, and un-invoiced bookings", () => {
    const full = [credit(cost("MB-1", 10_000), 10_000), credit(fee("MB-1", 1180), 1180)];
    expect(creditRatioForBooking(MB1, ON_MARKUP, [
      cn(full, { status: "DRAFT" }),
      cn(full, { status: "CANCELLED" }),
      cn(full, { originalInvoiceId: OTHER_INV }),
    ], NO_TOTALS)).toBe(0);
    expect(creditRatioForBooking(MB1, invoice(ON_MARKUP.lineItems, OTHER_INV), [cn(full)], NO_TOTALS)).toBe(0);
    expect(creditRatioForBooking({ bookingRef: "MB-1" }, ON_MARKUP, [cn(full)], NO_TOTALS)).toBe(0);
  });

  it("refs are whole and trimmed: MB-11 is not MB-1", () => {
    expect(refsOfLine(" MB-1 ,MB-2,, MB-3 ")).toEqual(["MB-1", "MB-2", "MB-3"]);
    expect(refsOfLine(undefined)).toEqual([]);
    const other = invoice([cost("MB-11", 10_000)]);
    expect(creditRatioForBooking(MB1, other, [cn([credit(cost("MB-11", 10_000), 10_000)])], NO_TOTALS)).toBe(0);
  });

  it("bookingGrandTotal uses the customer-facing total chain", () => {
    expect(bookingGrandTotal({ pricing: { grandTotal: 11_180, quotedPrice: 1 } })).toBe(11_180);
    expect(bookingGrandTotal({ pricing: { quotedPrice: 900 } })).toBe(900);
    expect(bookingGrandTotal({})).toBe(0);
  });
});
