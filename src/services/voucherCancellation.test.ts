// Cancellation wording on extracted hotel vouchers (audit §9 H-03).
// Free cancellation must come from the document, never from a default:
// statedNonRefundable() reads what the model actually said, the adapter only
// builds a free tier from an explicit signal, and the template prints
// "As per supplier policy — contact support" when nothing was stated.
import { describe, it, expect } from "vitest";
import { notesSayNonRefundable, statedNonRefundable } from "./voucherNormalize.js";
import { adaptHotel } from "./voucherAdapter.js";
import { buildCancellationChips } from "@plumtrips/shared/voucher-templates/cancellationPolicy";
import { generateHotelVoucherHTML } from "@plumtrips/shared/voucher-templates/hotelVoucherGenerator";
import type { PlumtripsVoucher } from "../types/index.js";

function hotel(policies: Partial<PlumtripsVoucher["policies"]> = {}): PlumtripsVoucher {
  return {
    type: "hotel",
    booking_info: { booking_id: "261014802640", booking_date: "14 Oct, 2026", voucher_no: "CT_261014643196", supplier_conf_no: null },
    hotel_details: { name: "Perch Service Apartments", address: "DLF Phase 3, Gurugram", city: "Gurugram", country: null, contact: "+91-8800461053" },
    stay_details: { check_in_date: "2026-10-15", check_in_time: "01 PM", check_out_date: "2026-10-16", check_out_time: "12 PM", total_nights: "1" },
    guest_details: { primary_guest: "Mr Samved Patil", total_pax: null, adults: 1, children: 0, all_guest_names: [] },
    room_details: { room_type: "Classic Studio Apartment", no_of_rooms: "1", inclusions: [], special_requests: null },
    policies: { cancellation_deadline: null, is_non_refundable: null, important_notes: [], ...policies },
  };
}

const chipLabels = (v: PlumtripsVoucher) => {
  const p = adaptHotel(v, { createdAt: "2026-10-14T08:00:00Z" });
  return buildCancellationChips(p.cancelPolicies, { checkOut: p.checkOut }).map((c) => c.label);
};

describe("notesSayNonRefundable", () => {
  it.each([
    ["This booking is non-refundable.", true],
    ["Smart Saver Fare is non-refundable and non-changeable.", true],
    ["A non-refundable surcharge of INR100/passenger will be charged.", false],
    ["Non-refundable deposit of INR 2000 at check-in.", false],
    ["For no-show or early check-out, 100% charges apply and no refund will be honored.", false],
  ])("%s → %s", (note, expected) => {
    expect(notesSayNonRefundable([note])).toBe(expected);
  });
});

describe("statedNonRefundable — what the document said", () => {
  const rec = (stored: boolean | null, rawFlag: boolean | null | undefined, notes: string[] = []) => ({
    extractedJson: { policies: { is_non_refundable: stored, important_notes: notes } },
    rawModelResponse: rawFlag === undefined ? undefined : { raw_candidate: { policies: { is_non_refundable: rawFlag } } },
  });

  it("model said nothing, extractor collapsed it to false → unknown (null)", () => {
    expect(statedNonRefundable(rec(false, null))).toBeNull();
  });
  it("model said nothing, extractor's loose match said true on a surcharge note → unknown", () => {
    expect(statedNonRefundable(rec(true, null, ["A non-refundable surcharge of INR100 applies."]))).toBeNull();
  });
  it("model said nothing, a clear non-refundable note → true", () => {
    expect(statedNonRefundable(rec(true, null, ["This booking is non-refundable."]))).toBe(true);
  });
  it("model said true/false → that", () => {
    expect(statedNonRefundable(rec(true, true))).toBe(true);
    expect(statedNonRefundable(rec(false, false))).toBe(false);
  });
  it("an operator's edit that differs from the extractor's output is kept", () => {
    expect(statedNonRefundable(rec(true, false))).toBe(true);
    expect(statedNonRefundable(rec(true, null))).toBe(true); // extractor would have said false
  });
  it("no raw candidate → stored value", () => {
    expect(statedNonRefundable(rec(false, undefined))).toBe(false);
  });
  it("already three-state null stays null", () => {
    expect(statedNonRefundable(rec(null, null))).toBeNull();
  });
});

describe("adaptHotel — cancelPolicies only from a stated signal", () => {
  it("unknown refundability, no deadline → no tiers (the Perch voucher)", () => {
    expect(chipLabels(hotel())).toEqual([]);
  });

  it("unknown refundability + a deadline alone → no tiers", () => {
    expect(chipLabels(hotel({ cancellation_deadline: "24-Jun-2027" }))).toEqual([]);
  });

  it("explicit false, no deadline → no tiers (refundable is not 'free any time')", () => {
    expect(chipLabels(hotel({ is_non_refundable: false }))).toEqual([]);
  });

  it("non-refundable → 'Non-refundable' (the section was hidden before)", () => {
    expect(chipLabels(hotel({ is_non_refundable: true }))).toEqual(["Non-refundable · 100% charge from booking date"]);
  });

  it("explicit false + a dated deadline → free until the end of the day before", () => {
    expect(chipLabels(hotel({ is_non_refundable: false, cancellation_deadline: "2026-10-10" }))).toEqual([
      "Free cancellation until 9 Oct 2026 23:59",
      "100% cancellation charge from 10 Oct 2026",
    ]);
  });

  it("a deadline time the document printed is kept", () => {
    const labels = chipLabels(hotel({ is_non_refundable: false, cancellation_deadline: "Mon, 12 Oct 2026, 12:59 PM" }));
    expect(labels[0]).toBe("Free cancellation until 12 Oct 2026 12:59");
  });

  it("an explicit free-cancellation statement + deadline, flag unknown → free until", () => {
    const labels = chipLabels(
      hotel({ cancellation_deadline: "08-Oct-2026", important_notes: ["Cancellation is free if cancelled before 08-Oct-2026."] }),
    );
    expect(labels[0]).toBe("Free cancellation until 7 Oct 2026 23:59");
  });

  it("a relative deadline counts back from check-in at the check-in time", () => {
    const labels = chipLabels(hotel({ is_non_refundable: false, cancellation_deadline: "48 hours prior to arrival" }));
    expect(labels[0]).toBe("Free cancellation until 13 Oct 2026 12:59");
  });

  it("'free cancellation any time' stated as such → free any time", () => {
    expect(chipLabels(hotel({ important_notes: ["Free cancellation any time before check-in."] }))).toEqual([
      "Free cancellation any time",
    ]);
  });
});

describe("hotel template — cancellation wording by source", () => {
  it("extracted, nothing stated → supplier-policy line, never 'free'", async () => {
    const html = await generateHotelVoucherHTML(adaptHotel(hotel(), { createdAt: "2026-10-14T08:00:00Z" }));
    expect(html).toContain("As per supplier policy — contact support");
    expect(html).not.toMatch(/free cancellation/i);
  });

  it("extracted never prints the minimum-age line", async () => {
    const html = await generateHotelVoucherHTML(adaptHotel(hotel(), { createdAt: "2026-10-14T08:00:00Z" }));
    expect(html).not.toContain("Minimum age");
  });

  it("SBT keeps its existing fallback and min-age line", async () => {
    const params = {
      ...adaptHotel(hotel(), { createdAt: "2026-10-14T08:00:00Z" }),
      source: "sbt" as const,
      cancelPolicies: [{ FromDate: "01-01-2030 00:00:00", ChargeType: "Percentage", CancellationCharge: 100 }],
    };
    const html = await generateHotelVoucherHTML(params);
    expect(html).toContain("Free cancellation available");
    expect(html).toContain("Minimum age");
  });
});

describe("hotel template — the cancellation deadline as stated", () => {
  const html = (v: PlumtripsVoucher) => generateHotelVoucherHTML(adaptHotel(v, { createdAt: "2026-10-14T08:00:00Z" }));

  it("a deadline with no refundability statement → neutral line, no free-cancellation chip", async () => {
    const out = await html(hotel({ cancellation_deadline: "19-Dec-2026" }));
    expect(out).toContain("Cancellation deadline: 19 Dec 2026. Charges may apply after this, as per supplier policy.");
    expect(out).not.toMatch(/free cancellation/i);
    expect(out).not.toContain("As per supplier policy — contact support");
  });

  it("the neutral line keeps a stated time and fills in the year", async () => {
    const out = await html(hotel({ cancellation_deadline: "25 Dec, 11:59 PM IST" }));
    expect(out).toContain("Cancellation deadline: 25 Dec 2026, 11:59 PM IST.");
  });

  it("explicit refundable + date-only deadline → free chip names the stated date", async () => {
    const out = await html(hotel({ is_non_refundable: false, cancellation_deadline: "2026-10-10" }));
    expect(out).toContain("Free cancellation before 10 Oct 2026");
    expect(out).toContain("100% cancellation charge from 10 Oct 2026");
    expect(out).not.toContain("9 Oct 2026");
    expect(out).not.toContain("Cancellation deadline:");
  });

  it("explicit free-cancellation statement + timed deadline → free until that time", async () => {
    const out = await html(
      hotel({ cancellation_deadline: "Mon, 12 Oct 2026, 12:59 PM", important_notes: ["Free cancellation before the deadline."] }),
    );
    expect(out).toContain("Free cancellation until 12 Oct 2026 12:59");
    expect(out).not.toContain("Cancellation deadline:");
  });

  it("non-refundable ignores the deadline", async () => {
    const out = await html(hotel({ is_non_refundable: true, cancellation_deadline: "19-Dec-2026" }));
    expect(out).toContain("Non-refundable");
    expect(out).not.toContain("Cancellation deadline:");
  });

  it("SBT never prints the extracted deadline line", async () => {
    const out = await generateHotelVoucherHTML({
      ...adaptHotel(hotel({ cancellation_deadline: "19-Dec-2026" }), { createdAt: "2026-10-14T08:00:00Z" }),
      source: "sbt",
    });
    expect(out).not.toContain("Cancellation deadline:");
  });
});
