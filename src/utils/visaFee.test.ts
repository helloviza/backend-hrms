// Unit coverage for the server-derived visa fee block (routes/visa.ts's
// GET /rules). No DB, no fixtures beyond plain objects — computeVisaFeeBlock
// is a pure function of the four fee inputs.
import { describe, it, expect } from "vitest";
import { computeVisaFeeBlock, VISA_FEE_DISCLAIMER } from "./visaFee.js";

describe("computeVisaFeeBlock", () => {
  it("derives ITEMISED when any of the three fee components is populated", () => {
    expect(computeVisaFeeBlock({ embassyFeeInr: 5000 }).displayMode).toBe("ITEMISED");
    expect(computeVisaFeeBlock({ vfsFeeInr: 1500 }).displayMode).toBe("ITEMISED");
    expect(computeVisaFeeBlock({ plumtripsServiceFeeInr: 2000 }).displayMode).toBe("ITEMISED");
  });

  it("derives INDICATIVE when none of the three fee components is populated", () => {
    const block = computeVisaFeeBlock({ indicativeVisaCostInr: 9000 });
    expect(block.displayMode).toBe("INDICATIVE");
  });

  it("derives INDICATIVE for the visa-free / zero-fee case (indicativeVisaCostInr explicit 0)", () => {
    const block = computeVisaFeeBlock({ indicativeVisaCostInr: 0 });
    expect(block.displayMode).toBe("INDICATIVE");
    expect(block.totalInr).toBe(0);
  });

  it("computes GST as 18% of the service fee ONLY — never embassy or VFS", () => {
    const block = computeVisaFeeBlock({
      embassyFeeInr: 5000,
      vfsFeeInr: 1500,
      plumtripsServiceFeeInr: 2000,
    });
    expect(block.displayMode).toBe("ITEMISED");

    const gstLine = block.lineItems.find((l) => l.code === "GST");
    expect(gstLine?.amountInr).toBe(360); // 18% of 2000, not of 6500 or 7500
    // The caption is interpolated from VISA_GST_RATE rather than written
    // out (2026-08-08). Pinned verbatim here because it is customer-facing
    // and because the whole point of interpolating it is that it can never
    // disagree with the amount on the same line.
    expect(gstLine?.label).toBe("GST (18% on service fee)");

    const embassyLine = block.lineItems.find((l) => l.code === "EMBASSY_FEE");
    const vfsLine = block.lineItems.find((l) => l.code === "VFS_FEE");
    expect(embassyLine?.amountInr).toBe(5000);
    expect(vfsLine?.amountInr).toBe(1500);

    // total = embassy + vfs + service fee + GST-on-service-fee-only
    expect(block.totalInr).toBe(5000 + 1500 + 2000 + 360);
  });

  it("omits the GST line entirely when the service fee is not populated (embassy/VFS-only itemised rule)", () => {
    const block = computeVisaFeeBlock({ embassyFeeInr: 5000, vfsFeeInr: 1500 });
    expect(block.displayMode).toBe("ITEMISED");
    expect(block.lineItems.find((l) => l.code === "GST")).toBeUndefined();
    expect(block.totalInr).toBe(6500);
  });

  it("charges GST even on a zero explicit service fee, since the field is populated", () => {
    const block = computeVisaFeeBlock({ embassyFeeInr: 5000, plumtripsServiceFeeInr: 0 });
    const gstLine = block.lineItems.find((l) => l.code === "GST");
    expect(gstLine?.amountInr).toBe(0);
    expect(block.totalInr).toBe(5000);
  });

  it("returns a single indicative line for INDICATIVE mode", () => {
    const block = computeVisaFeeBlock({ indicativeVisaCostInr: 12000 });
    expect(block.lineItems).toEqual([
      { code: "INDICATIVE", label: "Indicative Visa Cost", amountInr: 12000 },
    ]);
    expect(block.totalInr).toBe(12000);
  });

  it("always includes the disclaimer, in both ITEMISED and INDICATIVE modes", () => {
    const itemised = computeVisaFeeBlock({ embassyFeeInr: 5000 });
    const indicative = computeVisaFeeBlock({ indicativeVisaCostInr: 5000 });
    expect(itemised.disclaimer).toBe(VISA_FEE_DISCLAIMER);
    expect(indicative.disclaimer).toBe(VISA_FEE_DISCLAIMER);
    expect(itemised.disclaimer.length).toBeGreaterThan(0);
  });

  it("includes priceNote only when the rule carries one", () => {
    const withNote = computeVisaFeeBlock({ indicativeVisaCostInr: 5000, priceNote: "Subject to embassy revision" });
    const withoutNote = computeVisaFeeBlock({ indicativeVisaCostInr: 5000 });
    expect(withNote.priceNote).toBe("Subject to embassy revision");
    expect(withoutNote.priceNote).toBeUndefined();
  });

  it("omits the disclaimer entirely for VISA_FREE rules — no embassy/VFS charges exist to be 'recovered at actual'", () => {
    const block = computeVisaFeeBlock({
      indicativeVisaCostInr: 0,
      priceNote: "No visa required for Indian passport holders — entry is free of charge.",
      visaCategory: "VISA_FREE",
    });
    expect(block.disclaimer).toBeUndefined();
    // priceNote (the actually-true "free of charge" line) is unaffected.
    expect(block.priceNote).toBe("No visa required for Indian passport holders — entry is free of charge.");
    expect(block.totalInr).toBe(0);
  });

  it("keeps the disclaimer for a non-VISA_FREE rule even in INDICATIVE mode", () => {
    const block = computeVisaFeeBlock({ indicativeVisaCostInr: 5000, visaCategory: "E_VISA" });
    expect(block.disclaimer).toBe(VISA_FEE_DISCLAIMER);
  });

  it("keeps the disclaimer when visaCategory is absent (existing callers unaffected)", () => {
    const block = computeVisaFeeBlock({ embassyFeeInr: 5000 });
    expect(block.disclaimer).toBe(VISA_FEE_DISCLAIMER);
  });
});
