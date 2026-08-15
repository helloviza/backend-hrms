// Channel coverage for computeVisaFeeBlock — Phase 1b.
//
// DELIBERATELY A SEPARATE FILE from utils/visaFee.test.ts. That file is left
// COMPLETELY UNMODIFIED so it stays a clean regression witness: if the
// channel parameter's "B2B" default ever stops being byte-identical, that
// file fails on its own, without anyone having to trust a diff.
import { describe, it, expect } from "vitest";
import { computeVisaFeeBlock, VISA_GST_PERCENT } from "./visaFee.js";

// Both service fees populated and DIFFERENT, so any test that silently read
// the wrong one produces a visibly wrong number rather than a coincidence.
const BOTH_CHANNELS = {
  embassyFeeInr: 8000,
  vfsFeeInr: 1500,
  plumtripsServiceFeeInr: 2000, // B2B
  d2cServiceFeeInr: 3000, // D2C
};

const amountOf = (block: ReturnType<typeof computeVisaFeeBlock>, code: string) =>
  block.lineItems.find((li) => li.code === code)?.amountInr ?? null;

describe('the "B2B" default — byte-identical', () => {
  it("omitting the channel is deep-equal to passing it explicitly", () => {
    expect(computeVisaFeeBlock(BOTH_CHANNELS)).toEqual(computeVisaFeeBlock(BOTH_CHANNELS, "B2B"));
  });

  it("the default ignores d2cServiceFeeInr entirely", () => {
    // Same rule with and without a D2C fee must produce the SAME B2B block.
    const withoutD2C = { ...BOTH_CHANNELS, d2cServiceFeeInr: undefined };
    expect(computeVisaFeeBlock(BOTH_CHANNELS)).toEqual(computeVisaFeeBlock(withoutD2C));
  });

  it("prices B2B off plumtripsServiceFeeInr", () => {
    const block = computeVisaFeeBlock(BOTH_CHANNELS);
    expect(amountOf(block, "SERVICE_FEE")).toBe(2000);
    expect(amountOf(block, "GST")).toBe(360); // 18% of 2000
    expect(block.totalInr).toBe(8000 + 1500 + 2000 + 360);
    expect(block.displayMode).toBe("ITEMISED");
  });
});

describe('channel "D2C"', () => {
  it("prices off d2cServiceFeeInr, not the B2B fee", () => {
    const block = computeVisaFeeBlock(BOTH_CHANNELS, "D2C");
    expect(amountOf(block, "SERVICE_FEE")).toBe(3000);
    expect(block.displayMode).toBe("ITEMISED");
  });

  it("computes GST on the SELECTED fee", () => {
    const block = computeVisaFeeBlock(BOTH_CHANNELS, "D2C");
    expect(amountOf(block, "GST")).toBe(540); // 18% of 3000, NOT of 2000
    expect(block.lineItems.find((li) => li.code === "GST")?.label).toBe(
      `GST (${VISA_GST_PERCENT}% on service fee)`,
    );
  });

  it("totals embassy + VFS + D2C service + GST-on-D2C", () => {
    const block = computeVisaFeeBlock(BOTH_CHANNELS, "D2C");
    expect(block.totalInr).toBe(8000 + 1500 + 3000 + 540);
  });

  it("differs from the B2B total by exactly the fee delta plus its GST", () => {
    const b2b = computeVisaFeeBlock(BOTH_CHANNELS, "B2B");
    const d2c = computeVisaFeeBlock(BOTH_CHANNELS, "D2C");
    // (3000 - 2000) + (540 - 360)
    expect(d2c.totalInr - b2b.totalInr).toBe(1180);
  });
});

describe("embassy and VFS are channel-independent pass-throughs", () => {
  it("are identical under both channels", () => {
    const b2b = computeVisaFeeBlock(BOTH_CHANNELS, "B2B");
    const d2c = computeVisaFeeBlock(BOTH_CHANNELS, "D2C");
    expect(amountOf(b2b, "EMBASSY_FEE")).toBe(amountOf(d2c, "EMBASSY_FEE"));
    expect(amountOf(b2b, "VFS_FEE")).toBe(amountOf(d2c, "VFS_FEE"));
  });

  it("never enter the GST base under either channel", () => {
    // GST must be 18% of the service fee alone — if embassy/VFS leaked in,
    // these numbers would be ₹2,070 and ₹2,250 respectively.
    expect(amountOf(computeVisaFeeBlock(BOTH_CHANNELS, "B2B"), "GST")).toBe(360);
    expect(amountOf(computeVisaFeeBlock(BOTH_CHANNELS, "D2C"), "GST")).toBe(540);
  });
});

describe("clean paise math on a round D2C fee", () => {
  // The production B2B data carries reverse-derived fractional fees
  // (5919.491525423729 and friends — feasibility audit §1.6). A D2C fee is
  // authored fresh, so a round figure must stay exact through GST and the
  // total: no floating-point dust, no rounding drift.
  it.each([
    [500, 90],
    [1000, 180],
    [1500, 270],
    [2500, 450],
    [3000, 540],
    [10000, 1800],
  ])("₹%i service fee -> ₹%i GST, and an integer total", (fee, expectedGst) => {
    const block = computeVisaFeeBlock(
      { embassyFeeInr: 8000, vfsFeeInr: 1500, d2cServiceFeeInr: fee },
      "D2C",
    );
    expect(amountOf(block, "GST")).toBe(expectedGst);
    expect(block.totalInr).toBe(8000 + 1500 + fee + expectedGst);
    expect(Number.isInteger(block.totalInr)).toBe(true);
    // No accumulated float error — an exact equality, not a closeTo.
    expect(block.totalInr % 1).toBe(0);
  });
});

describe("edge cases", () => {
  it("a zero D2C fee still emits both lines, at zero", () => {
    // 0 != null, so the service line and its GST line both exist — the same
    // behaviour the B2B path has for the 23 production rules priced at ₹0.
    const block = computeVisaFeeBlock({ ...BOTH_CHANNELS, d2cServiceFeeInr: 0 }, "D2C");
    expect(amountOf(block, "SERVICE_FEE")).toBe(0);
    expect(amountOf(block, "GST")).toBe(0);
    expect(block.totalInr).toBe(9500);
  });

  it("no D2C fee authored: itemised on the pass-throughs, with no service or GST line", () => {
    // A corridor not sold D2C yet. The honest computation is embassy + VFS;
    // whether such a rule may be PUBLISHED to consumers is Phase 2's call,
    // not this function's.
    const block = computeVisaFeeBlock(
      { embassyFeeInr: 8000, vfsFeeInr: 1500, plumtripsServiceFeeInr: 2000 },
      "D2C",
    );
    expect(block.displayMode).toBe("ITEMISED");
    expect(amountOf(block, "SERVICE_FEE")).toBeNull();
    expect(amountOf(block, "GST")).toBeNull();
    expect(block.totalInr).toBe(9500);
  });

  it("falls back to INDICATIVE when the channel has nothing itemised at all", () => {
    const block = computeVisaFeeBlock({ indicativeVisaCostInr: 7000 }, "D2C");
    expect(block.displayMode).toBe("INDICATIVE");
    expect(block.totalInr).toBe(7000);
  });

  it("a D2C-only rule is ITEMISED under D2C and INDICATIVE under B2B", () => {
    // The asymmetry the design note calls out, pinned so it is a decision
    // rather than a surprise.
    const d2cOnly = { d2cServiceFeeInr: 2500, indicativeVisaCostInr: 7000 };
    expect(computeVisaFeeBlock(d2cOnly, "D2C").displayMode).toBe("ITEMISED");
    expect(computeVisaFeeBlock(d2cOnly, "B2B").displayMode).toBe("INDICATIVE");
  });

  it("drops the disclaimer for a VISA_FREE rule under both channels", () => {
    const free = { ...BOTH_CHANNELS, visaCategory: "VISA_FREE" as const };
    expect(computeVisaFeeBlock(free, "B2B").disclaimer).toBeUndefined();
    expect(computeVisaFeeBlock(free, "D2C").disclaimer).toBeUndefined();
  });

  it("carries priceNote through under both channels", () => {
    const withNote = { ...BOTH_CHANNELS, priceNote: "Entry is free of charge." };
    expect(computeVisaFeeBlock(withNote, "B2B").priceNote).toBe("Entry is free of charge.");
    expect(computeVisaFeeBlock(withNote, "D2C").priceNote).toBe("Entry is free of charge.");
  });
});
