// Multi-leg (Step 4, Piece 3): the staff export gains THREE appended columns —
// Trip Type / Route (all legs) / Legs — and nothing else moves. Same harness as
// pricingMask.test.ts (route mounted with auth/permission mocked, the model's
// find() answering with fixtures) so the CSV and XLSX bytes are the real
// bookingToRow / BOOKING_COLUMNS / TOTALS output.
import { describe, it, expect, vi } from "vitest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";

const MULTI = {
  _id: new mongoose.Types.ObjectId(),
  bookingRef: "MB-LEGS-0001",
  status: "CONFIRMED",
  type: "FLIGHT",
  workspaceId: new mongoose.Types.ObjectId(),
  travelDate: new Date("2026-10-15T00:00:00Z"),
  returnDate: new Date("2026-10-20T00:00:00Z"),
  passengers: [{ name: "Priya Sharma" }],
  itinerary: {
    // The DERIVED flat summary (Piece 1): outbound leg 0 + turnaround city.
    origin: "DEL", destination: "BOM", flightNo: "AI 302", airline: "Air India",
    tripType: "ROUND_TRIP",
    legs: [
      { origin: "DEL", destination: "BOM", flightNo: "AI 302", airline: "Air India", departDate: new Date("2026-10-15T00:00:00Z") },
      { origin: "BOM", destination: "DEL", flightNo: "AI 303", airline: "Air India", departDate: new Date("2026-10-20T00:00:00Z") },
    ],
  },
  pricing: { quotedPrice: 50000, actualPrice: 42000, diff: 8000, gstAmount: 9000, basePrice: 8000, grandTotal: 59000 },
};
const LEGACY = {
  _id: new mongoose.Types.ObjectId(),
  bookingRef: "MB-LEGS-0002",
  status: "CONFIRMED",
  type: "FLIGHT",
  workspaceId: MULTI.workspaceId,
  travelDate: new Date("2026-03-01T00:00:00Z"),
  passengers: [{ name: "Old Row" }],
  itinerary: { origin: "BLR", destination: "HYD", flightNo: "6E 77", airline: "IndiGo" },
  pricing: { quotedPrice: 6000, actualPrice: 5000, diff: 1000, gstAmount: 180, basePrice: 1000, grandTotal: 6180 },
};
const ROWS = [MULTI, LEGACY];

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.permissionScope = "ALL";
    req.permissionAccess = "FULL";
    next();
  },
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../models/ManualBooking.js", async () => {
  const actual: any = await vi.importActual("../models/ManualBooking.js");
  const chain = (): any => {
    const node: any = {
      sort: () => node, skip: () => node, limit: () => node, populate: () => node,
      lean: () => Promise.resolve(ROWS.map((r) => ({ ...r }))),
      then: (r: any, j: any) => Promise.resolve(ROWS.map((x) => ({ ...x }))).then(r, j),
    };
    return node;
  };
  return {
    MANUAL_BOOKING_TYPES: actual.MANUAL_BOOKING_TYPES,
    ALL_SUB_STATUSES: actual.ALL_SUB_STATUSES,
    ATTACHMENT_REQUIRED_TYPES: [],
    isNewModelLineItems: () => true,
    default: { find: () => chain(), countDocuments: () => Promise.resolve(ROWS.length), aggregate: () => Promise.resolve([]) },
  };
});
vi.mock("../models/Invoice.js", () => ({ default: { find: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) } }));
vi.mock("../models/Customer.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }), lean: () => Promise.resolve(null) }) },
}));
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: { findOne: () => ({ lean: () => Promise.resolve(null) }), findById: () => ({ lean: () => Promise.resolve(null) }) },
}));
vi.mock("../models/CustomerMember.js", () => ({ default: { find: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) } }));
vi.mock("../models/User.js", () => ({ default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) } }));
vi.mock("../models/SBTBooking.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));
vi.mock("../models/SBTHotelBooking.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));
vi.mock("../models/ExtractedDocument.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));

import express from "express";
import request from "supertest";
import router from "./manualBookings.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(new mongoose.Types.ObjectId()), roles: ["SUPERADMIN"] };
    next();
  });
  app.use("/", router);
  return app;
}

// Minimal CSV line parser for the export's own csvRow() quoting (fields
// wrapped in double quotes, inner quotes doubled).
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const COLS = 49;
const MONEY_1BASED = [17, 18, 19, 20, 21, 22];

describe("staff export — three appended multi-leg columns", () => {
  it("CSV: header ends with the 3 new columns; a multi-leg row fills them, a legacy row leaves them blank; old columns unchanged", async () => {
    const res = await request(makeApp()).get("/export?format=csv");
    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n").map((l) => parseCsvLine(l.replace(/\r$/, "")));
    const header = lines[0];
    expect(header).toHaveLength(COLS);
    expect(header.slice(-3)).toEqual(["Trip Type", "Route (all legs)", "Legs"]);
    expect(header[13]).toBe("Sector");
    expect(header[31]).toBe("Flight / Train No");
    expect(header[32]).toBe("Airline");

    // One data row per booking, never one per leg.
    expect(lines).toHaveLength(1 + ROWS.length);

    const multi = lines[1];
    expect(multi).toHaveLength(COLS);
    expect(multi[13]).toBe("DEL-BOM");          // Sector = flat outbound-turnaround, unchanged
    expect(multi[31]).toBe("AI 302");           // Flight No = leg 0, not joined
    expect(multi[32]).toBe("Air India");
    expect(multi[14]).toBe("15/10/2026");       // Travel Date
    expect(multi[15]).toBe("20/10/2026");       // Arrival Date = return departure (Piece 1)
    expect(multi.slice(-3)).toEqual([
      "ROUND_TRIP",
      "DEL→BOM→DEL",
      "1. DEL→BOM AI 302 Air India 15/10/2026 | 2. BOM→DEL AI 303 Air India 20/10/2026",
    ]);

    const legacy = lines[2];
    expect(legacy).toHaveLength(COLS);
    expect(legacy[13]).toBe("BLR-HYD");
    expect(legacy[31]).toBe("6E 77");
    expect(legacy.slice(-3)).toEqual(["", "", ""]);
  });

  it("XLSX: same 49 columns; MONEY_COLS positions untouched; TOTALS row sums one row per booking (no double-count)", async () => {
    const res = await request(makeApp()).get("/export?format=xlsx").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    const sheet = wb.worksheets[0];
    const header = sheet.getRow(1).values as any[]; // 1-based
    expect(header.length - 1).toBe(COLS);
    expect(header.slice(-3)).toEqual(["Trip Type", "Route (all legs)", "Legs"]);
    expect(header[17]).toBe("Quoted Price");
    expect(header[22]).toBe("Grand Total");

    // header + 2 bookings + TOTALS
    expect(sheet.rowCount).toBe(1 + ROWS.length + 1);
    const totals = sheet.getRow(sheet.rowCount).values as any[];
    expect(totals[1]).toBe("TOTALS");
    const expected: Record<number, number> = {
      17: 50000 + 6000, 18: 42000 + 5000, 19: 8000 + 1000, 20: 9000 + 180, 21: 8000 + 1000, 22: 59000 + 6180,
    };
    for (const ci of MONEY_1BASED) expect(totals[ci], `money col ${ci}`).toBe(expected[ci]);
    // Nothing summed into the appended columns.
    expect([totals[47], totals[48], totals[49]].map((v) => v ?? "")).toEqual(["", "", ""]);

    const multi = sheet.getRow(2).values as any[];
    expect(multi[47]).toBe("ROUND_TRIP");
    expect(multi[48]).toBe("DEL→BOM→DEL");
    expect(multi[49]).toMatch(/^1\. DEL→BOM AI 302 .* \| 2\. BOM→DEL AI 303 /);
    expect(sheet.getColumn(49).width).toBe(60);
  });
});
