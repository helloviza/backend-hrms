// What the flight ticket prints for an extracted voucher: cards that don't split
// across pages, no page counter it can't keep, and no blank booking box
// (audit §9 H-10, H-11, H-12).
import { describe, it, expect } from "vitest";
import { adaptFlight } from "./voucherAdapter.js";
import { generateTicketHTML } from "@plumtrips/shared/voucher-templates/ticketGenerator";
import type { PlumtripsVoucher } from "../types/index.js";

function ticket(over: Partial<PlumtripsVoucher["booking_info"]> = {}, segments = 1): PlumtripsVoucher {
  const seg = (o: string, d: string, day: string) => ({
    airline: "Air India",
    flight_no: "AI 2361",
    class: "Economy",
    duration: null,
    layover_duration: null,
    origin: { city: null, code: o, time: "22:55", date: day, terminal: null },
    destination: { city: null, code: d, time: "03:10", date: day, terminal: null },
    ancillaries: { cabin_bag: null, checkin_bag: "25 Kg(s)", seat: null, meal: null, barcode_string: null },
  });
  return {
    type: "flight",
    booking_info: { booking_id: null, booking_date: "12 Oct 2026", voucher_no: null, supplier_conf_no: null, pnr: "8RLUYX", ...over },
    policies: { cancellation_deadline: null, is_non_refundable: null, important_notes: [] },
    flight_details: {
      segments: [seg("MNL", "DEL", "15 Oct 2026"), seg("DEL", "BOM", "17 Oct 2026"), seg("BOM", "MNL", "19 Oct 2026")].slice(0, segments),
    },
    passengers: ["Mr Arunav Sharma", "Ms Riya Sharma", "Mstr Kabir Sharma"].map((name) => ({ name, type: "adult", ticket_no: null })),
  } as PlumtripsVoucher;
}

async function html(v: PlumtripsVoucher) {
  const { booking, returnBooking } = adaptFlight(v, { createdAt: "2026-10-12T08:00:00Z" });
  return generateTicketHTML(booking, [], returnBooking, undefined, false);
}

describe("booking ID box (H-12)", () => {
  it("a source with only a PNR: no booking-ID box, and the PNR isn't repeated in its place", async () => {
    const { booking } = adaptFlight(ticket(), {});
    expect(booking.bookingId).toBe("");
    const out = await html(ticket());
    expect(out).not.toContain("Booking ID");
    expect(out).not.toContain("Booking ref");
    expect(out).toContain("grid-template-columns:repeat(3,1fr)");
    // the PNR prints in its own box (letter-spaced) and the sidebar, never as a booking ID
    expect(out.match(/font-size:12px;">8RLUYX<\/div>/g)).toBeNull();
  });

  it("every leg page leaves it out, hero line included", async () => {
    const out = await html(ticket({}, 3));
    expect(out).not.toContain("Booking ID");
    expect(out.match(/grid-template-columns:repeat\(3,1fr\)/g)?.length).toBe(3);
  });

  it("a stated booking ID keeps its box (and SBT, which always has one, is unchanged)", async () => {
    const v = ticket({ booking_id: "NN9AMQTL78497311245" });
    const out = await html(v);
    expect(out).toContain(">Booking ID</div>");
    expect(out).toContain("NN9AMQTL78497311245");
    expect(out).toContain("grid-template-columns:repeat(4,1fr)");
    expect(out).not.toContain("repeat(3,1fr)");
  });
});

describe("page breaks (H-10) and page numbers (H-11)", () => {
  it("the manifest card, each passenger row and each barcode block never split", async () => {
    const out = await html(ticket({}, 2));
    const noSplit = "break-inside:avoid;page-break-inside:avoid;";
    // Two manifests (one per leg page), each with 3 rows and 3 barcode blocks.
    expect(out.match(new RegExp(`<div style="${noSplit}background:#ffffff;border-radius:12px;overflow:hidden;`, "g"))?.length).toBe(2);
    expect(out.match(new RegExp(`<tr style="${noSplit}`, "g"))?.length).toBe(6);
    expect(out.match(new RegExp(`<div style="${noSplit}margin-bottom:12px;">`, "g"))?.length).toBe(6);
  });

  it("prints no 'Page X of N' on any leg page", async () => {
    for (const n of [1, 2, 3]) {
      const out = await html(ticket({}, n));
      expect(out).not.toMatch(/Page \d+ of \d+/);
      expect(out).toContain("Generated via PlumTrips");
    }
  });
});
