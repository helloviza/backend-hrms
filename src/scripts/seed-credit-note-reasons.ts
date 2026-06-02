/**
 * Seed the CreditNoteReason master.
 * Idempotent — safe to re-run. Upserts by `code`. On each run it updates
 * reason / category / gstReasonCode / gstReasonText / displayOrder so the master
 * can be edited by changing this file and re-running. It does NOT touch
 * `isActive` on existing records, so soft-deletes made from the UI survive
 * re-seeds.
 *
 * Run: pnpm -C apps/backend tsx src/scripts/seed-credit-note-reasons.ts
 */

import { connectDb } from "../config/db.js";
import CreditNoteReason from "../models/CreditNoteReason.js";

const REASONS: Array<{
  category: string;
  reason: string;
  code: string;
  gstReasonCode: "01" | "02" | "03" | "04" | "05" | "06" | "07";
  gstReasonText: string;
  displayOrder: number;
}> = [
  // FLIGHT
  { category: "FLIGHT", code: "FLT-001", reason: "Flight Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "FLIGHT", code: "FLT-002", reason: "Partial Flight Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 2 },
  { category: "FLIGHT", code: "FLT-003", reason: "Airline Refund Received", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 3 },
  { category: "FLIGHT", code: "FLT-004", reason: "Schedule Change Refund", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 4 },
  { category: "FLIGHT", code: "FLT-005", reason: "Flight Downgrade Compensation", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 5 },
  { category: "FLIGHT", code: "FLT-006", reason: "Ancillary Refund (Seat/Baggage/Meal)", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 6 },
  { category: "FLIGHT", code: "FLT-007", reason: "Fare Difference Adjustment", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 7 },
  { category: "FLIGHT", code: "FLT-008", reason: "Duplicate Ticket Issued", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 8 },
  { category: "FLIGHT", code: "FLT-009", reason: "Ticket Void/Reversal", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 9 },
  { category: "FLIGHT", code: "FLT-010", reason: "Flight Service Not Utilized", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 10 },

  // HOTEL
  { category: "HOTEL", code: "HTL-001", reason: "Hotel Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "HOTEL", code: "HTL-002", reason: "Partial Hotel Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 2 },
  { category: "HOTEL", code: "HTL-003", reason: "Early Checkout Refund", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 3 },
  { category: "HOTEL", code: "HTL-004", reason: "Hotel Downgrade Adjustment", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 4 },
  { category: "HOTEL", code: "HTL-005", reason: "Hotel Overbilling Correction", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 5 },
  { category: "HOTEL", code: "HTL-006", reason: "Hotel No-Show Refund", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 6 },
  { category: "HOTEL", code: "HTL-007", reason: "Hotel Service Not Delivered", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 7 },
  { category: "HOTEL", code: "HTL-008", reason: "Supplier Refund Received", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 8 },

  // VISA
  { category: "VISA", code: "VIS-001", reason: "Visa Application Withdrawn", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "VISA", code: "VIS-002", reason: "Visa Service Not Utilized", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 2 },
  { category: "VISA", code: "VIS-003", reason: "Visa Fee Adjustment", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 3 },
  { category: "VISA", code: "VIS-004", reason: "Duplicate Visa Billing", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 4 },
  { category: "VISA", code: "VIS-005", reason: "Visa Refund Received", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 5 },
  { category: "VISA", code: "VIS-006", reason: "Documentation Error Adjustment", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 6 },

  // CAB
  { category: "CAB", code: "CAB-001", reason: "Cab Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "CAB", code: "CAB-002", reason: "Cab No-Show Adjustment", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 2 },
  { category: "CAB", code: "CAB-003", reason: "Cab Service Not Utilized", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 3 },
  { category: "CAB", code: "CAB-004", reason: "Fare Difference Adjustment", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 4 },
  { category: "CAB", code: "CAB-005", reason: "Driver Unavailability Compensation", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 5 },

  // TRANSFER
  { category: "TRANSFER", code: "TRF-001", reason: "Airport Transfer Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "TRANSFER", code: "TRF-002", reason: "Transfer Service Not Utilized", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 2 },
  { category: "TRANSFER", code: "TRF-003", reason: "Transfer Supplier Refund", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 3 },
  { category: "TRANSFER", code: "TRF-004", reason: "Transfer Service Failure Compensation", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 4 },

  // HOLIDAY_PACKAGE
  { category: "HOLIDAY_PACKAGE", code: "PKG-001", reason: "Package Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "HOLIDAY_PACKAGE", code: "PKG-002", reason: "Partial Package Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 2 },
  { category: "HOLIDAY_PACKAGE", code: "PKG-003", reason: "Activity Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 3 },
  { category: "HOLIDAY_PACKAGE", code: "PKG-004", reason: "Sightseeing Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 4 },
  { category: "HOLIDAY_PACKAGE", code: "PKG-005", reason: "Package Cost Adjustment", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 5 },
  { category: "HOLIDAY_PACKAGE", code: "PKG-006", reason: "Package Downgrade", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 6 },
  { category: "HOLIDAY_PACKAGE", code: "PKG-007", reason: "Service Not Delivered", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 7 },

  // FOREX
  { category: "FOREX", code: "FRX-001", reason: "Forex Order Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "FOREX", code: "FRX-002", reason: "Forex Rate Difference Adjustment", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 2 },
  { category: "FOREX", code: "FRX-003", reason: "Excess Forex Charged", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 3 },
  { category: "FOREX", code: "FRX-004", reason: "Forex Delivery Failure", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 4 },

  // ESIM
  { category: "ESIM", code: "ESM-001", reason: "eSIM Not Activated", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 1 },
  { category: "ESIM", code: "ESM-002", reason: "eSIM Activation Failure", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 2 },
  { category: "ESIM", code: "ESM-003", reason: "eSIM Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 3 },
  { category: "ESIM", code: "ESM-004", reason: "Duplicate eSIM Billing", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 4 },

  // EVENTS_MICE
  { category: "EVENTS_MICE", code: "EVT-001", reason: "Event Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "EVENTS_MICE", code: "EVT-002", reason: "Delegate Reduction", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 2 },
  { category: "EVENTS_MICE", code: "EVT-003", reason: "Venue Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 3 },
  { category: "EVENTS_MICE", code: "EVT-004", reason: "Event Service Reduction", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 4 },
  { category: "EVENTS_MICE", code: "EVT-005", reason: "AV Setup Reduction", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 5 },
  { category: "EVENTS_MICE", code: "EVT-006", reason: "Sponsorship Adjustment", gstReasonCode: "02", gstReasonText: "Post-Supply Discount", displayOrder: 6 },
  { category: "EVENTS_MICE", code: "EVT-007", reason: "Event Refund Received", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 7 },

  // TROPHY
  { category: "TROPHY", code: "TRP-001", reason: "Order Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "TROPHY", code: "TRP-002", reason: "Quantity Reduction", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 2 },
  { category: "TROPHY", code: "TRP-003", reason: "Damaged Item Return", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 3 },
  { category: "TROPHY", code: "TRP-004", reason: "Incorrect Billing", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 4 },
  { category: "TROPHY", code: "TRP-005", reason: "Quality Issue Compensation", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 5 },

  // GIFT_ITEMS
  { category: "GIFT_ITEMS", code: "GFT-001", reason: "Gift Order Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "GIFT_ITEMS", code: "GFT-002", reason: "Returned Goods", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 2 },
  { category: "GIFT_ITEMS", code: "GFT-003", reason: "Quantity Reduction", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 3 },
  { category: "GIFT_ITEMS", code: "GFT-004", reason: "Pricing Error Correction", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 4 },
  { category: "GIFT_ITEMS", code: "GFT-005", reason: "Damaged Goods Return", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 5 },

  // STATIONERY
  { category: "STATIONERY", code: "STN-001", reason: "Order Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "STATIONERY", code: "STN-002", reason: "Returned Stationery", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 2 },
  { category: "STATIONERY", code: "STN-003", reason: "Quantity Adjustment", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 3 },
  { category: "STATIONERY", code: "STN-004", reason: "Wrong Item Billed", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 4 },
  { category: "STATIONERY", code: "STN-005", reason: "Pricing Correction", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 5 },

  // TRAIN
  { category: "TRAIN", code: "TRN-001", reason: "Train Ticket Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "TRAIN", code: "TRN-002", reason: "Railway Refund Received", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 2 },
  { category: "TRAIN", code: "TRN-003", reason: "Train Schedule Change Refund", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 3 },
  { category: "TRAIN", code: "TRN-004", reason: "Duplicate Booking", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 4 },
  { category: "TRAIN", code: "TRN-005", reason: "Service Not Utilized", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 5 },

  // CRUISE
  { category: "CRUISE", code: "CRS-001", reason: "Cruise Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 1 },
  { category: "CRUISE", code: "CRS-002", reason: "Partial Cruise Cancellation", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 2 },
  { category: "CRUISE", code: "CRS-003", reason: "Cruise Downgrade", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 3 },
  { category: "CRUISE", code: "CRS-004", reason: "Cruise Supplier Refund", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 4 },
  { category: "CRUISE", code: "CRS-005", reason: "Cruise Service Not Delivered", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 5 },

  // GENERAL
  { category: "GENERAL", code: "GEN-001", reason: "Duplicate Invoice", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 1 },
  { category: "GENERAL", code: "GEN-002", reason: "Wrong Customer Billed", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 2 },
  { category: "GENERAL", code: "GEN-003", reason: "Wrong GST Applied", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 3 },
  { category: "GENERAL", code: "GEN-004", reason: "Pricing Error", gstReasonCode: "04", gstReasonText: "Correction in Invoice", displayOrder: 4 },
  { category: "GENERAL", code: "GEN-005", reason: "Commercial Discount Approved", gstReasonCode: "02", gstReasonText: "Post-Supply Discount", displayOrder: 5 },
  { category: "GENERAL", code: "GEN-006", reason: "Corporate Rebate", gstReasonCode: "02", gstReasonText: "Post-Supply Discount", displayOrder: 6 },
  { category: "GENERAL", code: "GEN-007", reason: "Goodwill Compensation", gstReasonCode: "02", gstReasonText: "Post-Supply Discount", displayOrder: 7 },
  { category: "GENERAL", code: "GEN-008", reason: "Service Failure Compensation", gstReasonCode: "03", gstReasonText: "Deficiency in Service", displayOrder: 8 },
  { category: "GENERAL", code: "GEN-009", reason: "Customer Complaint Resolution", gstReasonCode: "07", gstReasonText: "Others", displayOrder: 9 },
  { category: "GENERAL", code: "GEN-010", reason: "Partial Refund Approved", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 10 },
  { category: "GENERAL", code: "GEN-011", reason: "Full Refund Approved", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 11 },
  { category: "GENERAL", code: "GEN-012", reason: "Credit Adjustment Against Future Booking", gstReasonCode: "02", gstReasonText: "Post-Supply Discount", displayOrder: 12 },
  { category: "GENERAL", code: "GEN-013", reason: "Contractual Adjustment", gstReasonCode: "02", gstReasonText: "Post-Supply Discount", displayOrder: 13 },
  { category: "GENERAL", code: "GEN-014", reason: "Sales Return", gstReasonCode: "01", gstReasonText: "Sales Return", displayOrder: 14 },
  { category: "GENERAL", code: "GEN-015", reason: "Other Approved Adjustment", gstReasonCode: "07", gstReasonText: "Others", displayOrder: 15 },
];

async function main() {
  await connectDb();

  let created = 0, updated = 0, unchanged = 0;

  for (const r of REASONS) {
    const existing = await CreditNoteReason.findOne({ code: r.code });
    if (!existing) {
      await CreditNoteReason.create(r);
      console.log(`✓ created ${r.code} — ${r.category} / ${r.reason}`);
      created++;
    } else {
      const needsUpdate =
        existing.reason !== r.reason ||
        existing.category !== r.category ||
        existing.gstReasonCode !== r.gstReasonCode ||
        existing.gstReasonText !== r.gstReasonText ||
        existing.displayOrder !== r.displayOrder;

      if (needsUpdate) {
        existing.reason = r.reason;
        existing.category = r.category;
        existing.gstReasonCode = r.gstReasonCode;
        existing.gstReasonText = r.gstReasonText;
        existing.displayOrder = r.displayOrder;
        // NOTE: do NOT touch isActive — preserves any soft-deletes
        await existing.save();
        console.log(`↻ updated ${r.code} — ${r.category} / ${r.reason}`);
        updated++;
      } else {
        console.log(`= unchanged ${r.code} — ${r.category} / ${r.reason}`);
        unchanged++;
      }
    }
  }

  console.log(`\nSummary: ${created} created, ${updated} updated, ${unchanged} unchanged, ${REASONS.length} total`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
