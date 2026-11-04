// apps/backend/src/utils/cstepTourProposalPdf.test.ts
//
// The Tour Proposal / approval-form PDF's office sign-off: the Travel Desk
// line signs with the latest SETTLE, the Accounts line with the latest
// FINANCE_SETTLE — two different trail entries, never the same one twice.
// Pure renderer: no database, no S3 (generateCstepTourProposalPdf only
// builds the buffer).

import { describe, it, expect, vi } from "vitest";
import PDFDocument from "pdfkit";
import type { CstepApprovalTrailEntry } from "./cstepTourProposalPdf.js";

// config/env.ts validates at import time; nothing here touches Mongo or S3.
process.env.NODE_ENV = "test";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:1/cstep_tour_pdf_unused";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";

const { generateCstepTourProposalPdf, tourOfficeSignatures, TRAVEL_DESK_SIGNATURE_CAPTION, ACCOUNTS_SIGNATURE_CAPTION } = await import(
  "./cstepTourProposalPdf.js"
);

const request: any = {
  _id: "64b000000000000000000001",
  workspaceId: "64b000000000000000000002",
  formType: "TOUR_PROPOSAL",
  type: "DOMESTIC",
  status: "REIMBURSED",
  purpose: "Field visit",
  project: "Energy",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  countries: [],
  departureDate: "2026-10-01",
  returnDate: "2026-10-04",
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
};
const traveller = { name: "Asha Rao", gender: "F", travelerId: "CSTEP-0001" };
const settlement = {
  buckets: { airRailBus: 9000, perDiem: 1500, boardingLodging: 0, cab: 0, other: 0 },
  totalCostOfTour: 10500,
  amountClaimed: 1500,
};

const BASE: CstepApprovalTrailEntry[] = [
  { action: "SUBMIT", actorName: "Asha Rao", at: "2026-09-20T05:00:00.000Z" },
  { action: "APPROVE", actorName: "Prof. Menon", at: "2026-09-21T05:00:00.000Z" },
  { action: "MARK_ARRANGED", actorName: "Lalitha Desk", at: "2026-09-25T05:00:00.000Z" },
];
const settled = (who: string, at: string): CstepApprovalTrailEntry => ({ action: "SETTLE", actorName: who, at });
const paid = (who: string, at: string): CstepApprovalTrailEntry => ({ action: "FINANCE_SETTLE", actorName: who, at });

type Drawn = { text: string; x: number };

// Every string the renderer draws, with its x position.
async function drawn(trail: CstepApprovalTrailEntry[]): Promise<Drawn[]> {
  const spy = vi.spyOn(PDFDocument.prototype as any, "text");
  try {
    const buf = await generateCstepTourProposalPdf(request, traveller, trail, settlement);
    expect(buf.length).toBeGreaterThan(1000);
    return spy.mock.calls.map((a: any[]) => ({ text: String(a[0]), x: Number(a[1]) }));
  } finally {
    spy.mockRestore();
  }
}

/** The name printed on a caption's ruled line: the signature-name draw at
 * the caption's x, between the previous caption pair and this one. */
function signerAbove(t: Drawn[], caption: string): string | null {
  const capIdx = t.findIndex((d) => d.text === caption);
  expect(capIdx).toBeGreaterThan(-1);
  const x = t[capIdx].x;
  // The office pair is the last signature pair: its names are drawn after
  // the Office expense table, i.e. after the last "Total cost of tour"-style
  // row — bound the search to the draws since the PI caption.
  const piIdx = t.findIndex((d) => d.text === "Signature of PI (in case of Project) or Director");
  const window = t.slice(piIdx + 1, capIdx);
  const names = window.filter((d) => d.x === x && !d.text.startsWith("Digitally signed") && !d.text.startsWith("Date:"));
  // Inside the window the only draw at a signature column x, other than the
  // digital-date line, is the signer's name — the office table's cells sit
  // at their own column positions.
  const signerNames = names.map((d) => d.text).filter((s) => KNOWN.has(s));
  return signerNames.length ? signerNames[signerNames.length - 1] : null;
}
const KNOWN = new Set(["Lalitha Desk", "Ravi Desk", "Meera Finance", "Karan Finance", "Asha Rao", "Prof. Menon"]);

describe("Tour Proposal PDF — office sign-off", () => {
  it("relabels the left block Travel Desk, keeps the Accounts label", async () => {
    const t = await drawn(BASE);
    const texts = t.map((d) => d.text);
    expect(texts).toContain(TRAVEL_DESK_SIGNATURE_CAPTION);
    expect(TRAVEL_DESK_SIGNATURE_CAPTION).toBe("Travel Desk signature and date upon verification");
    expect(texts).toContain("Accounts signature and date upon verification");
    expect(texts).not.toContain("Admin signature and date upon verification");
  });

  it("different settler and payer → Travel Desk shows the settler, Accounts the Finance payer", async () => {
    const trail = [...BASE, settled("Lalitha Desk", "2026-10-06T05:00:00.000Z"), paid("Meera Finance", "2026-10-08T05:00:00.000Z")];
    const sig = tourOfficeSignatures(trail);
    expect(sig.travelDesk?.name).toBe("Lalitha Desk");
    expect(sig.accounts?.name).toBe("Meera Finance");

    const t = await drawn(trail);
    expect(signerAbove(t, TRAVEL_DESK_SIGNATURE_CAPTION)).toBe("Lalitha Desk");
    expect(signerAbove(t, ACCOUNTS_SIGNATURE_CAPTION)).toBe("Meera Finance");
    // Each name printed once in the office pair — not the same entry twice.
    expect(t.filter((d) => d.text === "Lalitha Desk").length).toBe(1);
    expect(t.filter((d) => d.text === "Meera Finance").length).toBe(1);
  });

  it("settled, not yet paid → Travel Desk signed, Accounts blank", async () => {
    const trail = [...BASE, settled("Lalitha Desk", "2026-10-06T05:00:00.000Z")];
    const sig = tourOfficeSignatures(trail);
    expect(sig.travelDesk?.name).toBe("Lalitha Desk");
    expect(sig.accounts).toBeNull();

    const t = await drawn(trail);
    expect(signerAbove(t, TRAVEL_DESK_SIGNATURE_CAPTION)).toBe("Lalitha Desk");
    expect(signerAbove(t, ACCOUNTS_SIGNATURE_CAPTION)).toBeNull();
  });

  it("nothing settled → both office lines blank", async () => {
    expect(tourOfficeSignatures(BASE)).toEqual({ travelDesk: null, accounts: null });
    const t = await drawn(BASE);
    expect(signerAbove(t, TRAVEL_DESK_SIGNATURE_CAPTION)).toBeNull();
    expect(signerAbove(t, ACCOUNTS_SIGNATURE_CAPTION)).toBeNull();
  });

  it("returned and re-settled → the latest of each signs", async () => {
    // Desk settles, Finance returns it (RETURN_TO_OFFICIAL), a different
    // Desk user re-settles, then a different Finance user pays. The trail
    // arrives sorted by `at`, but the pick must not depend on order.
    const trail = [
      ...BASE,
      settled("Lalitha Desk", "2026-10-06T05:00:00.000Z"),
      { action: "RETURN_TO_OFFICIAL", actorName: "Meera Finance", at: "2026-10-07T05:00:00.000Z" },
      settled("Ravi Desk", "2026-10-09T05:00:00.000Z"),
      paid("Karan Finance", "2026-10-10T05:00:00.000Z"),
    ];
    const shuffled = [trail[5], trail[3], trail[0], trail[6], trail[1], trail[4], trail[2]];
    for (const tr of [trail, shuffled]) {
      const sig = tourOfficeSignatures(tr);
      expect(sig.travelDesk).toEqual({ name: "Ravi Desk", date: "09 Oct 2026" });
      expect(sig.accounts).toEqual({ name: "Karan Finance", date: "10 Oct 2026" });
    }

    const t = await drawn(trail);
    expect(signerAbove(t, TRAVEL_DESK_SIGNATURE_CAPTION)).toBe("Ravi Desk");
    expect(signerAbove(t, ACCOUNTS_SIGNATURE_CAPTION)).toBe("Karan Finance");
    expect(t.map((d) => d.text)).not.toContain("Lalitha Desk");
  });

  it("re-paid after a return → Accounts shows the latest payer", () => {
    const sig = tourOfficeSignatures([
      ...BASE,
      settled("Lalitha Desk", "2026-10-06T05:00:00.000Z"),
      paid("Meera Finance", "2026-10-08T05:00:00.000Z"),
      paid("Karan Finance", "2026-10-12T05:00:00.000Z"),
    ]);
    expect(sig.accounts?.name).toBe("Karan Finance");
  });
});
