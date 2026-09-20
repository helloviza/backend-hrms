// POST /api/admin/manual-bookings/extract-preview — the synchronous, stateless
// extraction the create form uses to auto-fill from a STAGED ticket.
//
// The extractor itself (Gemini) is mocked; what is under test is the route's
// contract: form-shaped flight fill on success, 200 + extracted:false on every
// non-blocking outcome (unreadable, non-flight, oversize, wrong mime), and —
// the property the form depends on — that it NEVER writes anything.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const { extractMock, enqueueMock } = vi.hoisted(() => ({ extractMock: vi.fn(), enqueueMock: vi.fn() }));
vi.mock("../services/documentExtraction.service.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  extractDocument: (...a: any[]) => extractMock(...a),
  enqueueExtraction: (...a: any[]) => enqueueMock(...a),
}));

const s3 = vi.hoisted(() => ({ puts: 0 }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: async () => { s3.puts += 1; return { bucket: "b", key: "k", url: "u" }; },
}));

import express from "express";
import request from "supertest";
import router from "./manualBookings.js";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.user = { _id: "507f1f77bcf86cd799439011", roles: ["ADMIN"] };
  req.workspaceObjectId = "69679a7628330a58d29f2254";
  req.permissionScope = "ALL";
  next();
});
app.use("/", router);

const pdf = Buffer.from("%PDF-1.4 fake");
const post = (buf: Buffer = pdf, filename = "ticket.pdf", contentType = "application/pdf") =>
  request(app).post("/extract-preview").attach("file", buf, { filename, contentType });

function flightVoucher() {
  return {
    type: "flight",
    booking_info: { booking_id: "B1", booking_date: null, voucher_no: null, supplier_conf_no: null, pnr: "PNR123" },
    flight_details: { segments: [{ airline: "Air India", flight_no: "AI 302", class: null, duration: null,
      origin: { city: "Delhi", code: "DEL", time: "10:00", date: "12/11/2026", terminal: null },
      destination: { city: "Bengaluru", code: "BLR", time: "12:45", date: "12/11/2026", terminal: null } }] },
    passengers: [{ name: "Rahul Verma", type: "ADT", ticket_no: null, phone: null, email: "rahul@x.com", baggage_check_in: null, baggage_cabin: null }],
    policies: { is_non_refundable: false, important_notes: [] },
  };
}

beforeEach(() => {
  extractMock.mockReset();
  enqueueMock.mockReset();
  s3.puts = 0;
});

describe("POST /extract-preview", () => {
  it("returns the form-shaped flight fill for a flight ticket", async () => {
    extractMock.mockResolvedValue({ docType: "flight", voucher: flightVoucher(), rawCandidate: null, modelUsed: "gemini-test", validationErrorCount: 0 });
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, extracted: true, docType: "flight", modelUsed: "gemini-test" });
    expect(r.body.flight).toMatchObject({
      travelDate: "2026-11-12", origin: "DEL", destination: "BLR", flightNo: "AI 302", airline: "Air India",
      supplierPNR: "PNR123", supplierName: null, segmentCount: 1,
    });
    expect(r.body.flight.passengers).toEqual([{ name: "Rahul Verma", type: "ADULT", email: "rahul@x.com", phone: null }]);
    // Hinted as a flight — the model's own detection still wins inside extractDocument.
    expect(extractMock).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "application/pdf", typeHint: "flight" }));
  });

  it("is stateless: no S3 write, no extraction row, whatever the outcome", async () => {
    extractMock.mockResolvedValue({ docType: "flight", voucher: flightVoucher(), rawCandidate: null, modelUsed: "m", validationErrorCount: 0 });
    await post();
    extractMock.mockRejectedValue(new Error("model down"));
    await post();
    expect(s3.puts).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a hotel voucher → docType hotel, flight:null, hotel fill in the form's field names", async () => {
    extractMock.mockResolvedValue({
      docType: "hotel", rawCandidate: null, modelUsed: "m", validationErrorCount: 0,
      voucher: {
        type: "hotel",
        booking_info: { booking_id: "HB-1", booking_date: null, voucher_no: null, supplier_conf_no: "CONF-9" },
        hotel_details: { name: "Taj Lands End", address: null, city: "Mumbai", country: "India", contact: null },
        stay_details: { check_in_date: "03/12/2026", check_in_time: null, check_out_date: "05/12/2026", check_out_time: null, total_nights: "2" },
        guest_details: { primary_guest: "Anita Rao", total_pax: "2", adults: 2, children: 0, all_guest_names: ["Anita Rao", "Vikram Rao"] },
        room_details: { room_type: "Sea View Twin", no_of_rooms: "1", inclusions: [], special_requests: null },
        policies: { is_non_refundable: false, important_notes: [] },
      },
    });
    const r = await post(pdf, "voucher.pdf");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ extracted: true, docType: "hotel", flight: null });
    expect(r.body.hotel).toMatchObject({
      travelDate: "2026-12-03", returnDate: "2026-12-05", hotelName: "Taj Lands End", city: "Mumbai",
      roomType: "Sea View Twin", roomCount: 1, nights: 2, supplierPNR: "CONF-9", supplierName: null,
    });
    expect(r.body.hotel.guests).toEqual([{ name: "Anita Rao" }, { name: "Vikram Rao" }]);
  });

  it("a flight ticket still yields hotel:null (flight path unchanged)", async () => {
    extractMock.mockResolvedValue({ docType: "flight", voucher: flightVoucher(), rawCandidate: null, modelUsed: "m", validationErrorCount: 0 });
    const r = await post();
    expect(r.body.hotel).toBeNull();
    expect(r.body.flight.flightNo).toBe("AI 302");
  });

  it("a hotel voucher with nothing usable → extracted:true, hotel:null", async () => {
    extractMock.mockResolvedValue({ docType: "hotel", voucher: { type: "hotel", booking_info: {}, policies: { is_non_refundable: false, important_notes: [] } }, rawCandidate: null, modelUsed: "m", validationErrorCount: 0 });
    const r = await post();
    expect(r.body).toMatchObject({ extracted: true, docType: "hotel", flight: null, hotel: null });
  });

  it("an unreadable document → 200, extracted:false, a human-readable reason — never a 5xx", async () => {
    extractMock.mockRejectedValue(new Error("Model returned invalid JSON"));
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.body.extracted).toBe(false);
    expect(r.body.extractionError).toMatch(/couldn't read/i);
  });

  it("a flight voucher with nothing usable → extracted:true but flight:null", async () => {
    extractMock.mockResolvedValue({ docType: "flight", voucher: { type: "flight", flight_details: { segments: [] }, passengers: [], booking_info: {} }, rawCandidate: null, modelUsed: "m", validationErrorCount: 0 });
    const r = await post();
    expect(r.body).toMatchObject({ extracted: true, docType: "flight", flight: null });
  });

  it("oversize file → 200, extracted:false, no model call", async () => {
    const big = Buffer.alloc(7 * 1024 * 1024 + 1, 0x20);
    const r = await post(big);
    expect(r.status).toBe(200);
    expect(r.body.extracted).toBe(false);
    expect(r.body.extractionError).toMatch(/capped/);
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("missing file → 400", async () => {
    const r = await request(app).post("/extract-preview");
    expect(r.status).toBe(400);
  });
});
