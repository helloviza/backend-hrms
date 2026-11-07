// P2: how the migration classifies each company's GSTIN copies. Pure — the
// apply path goes through services/gstRegistrations.ts (tested there).
import { describe, it, expect } from "vitest";
import { classify } from "./migrate-gst-registrations.js";

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function gstin(state: string, pan: string): string {
  const body = `${state}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return body + CHARS[(36 - (sum % 36)) % 36];
}
const PAN = "AAHCM7777M";
const DL = gstin("07", PAN);
const HR = gstin("06", PAN);

describe("classify", () => {
  it("all copies agree → CREATE_DEFAULT", () => {
    const r = classify(
      { gstNumber: DL, panNumber: PAN, gstStatus: "REGISTERED", gstRegisteredState: "Delhi", onboardingSnapshot: { gstNumber: DL } },
      { gstNumber: DL.toLowerCase() },
      { gstin: DL },
    );
    expect(r).toMatchObject({ action: "CREATE_DEFAULT", gstin: DL, gstinState: "Delhi", candidates: [DL] });
    expect(r.notes).toEqual([]);
  });

  it("notes PAN derived, state filled, status set, partial copies", () => {
    const r = classify({ gstNumber: DL }, null, null);
    expect(r.action).toBe("CREATE_DEFAULT");
    expect(r.notes).toEqual(["PAN_DERIVED", "STATE_FILLED", "STATUS_SET_REGISTERED", "PARTIAL_COPIES"]);
  });

  it("two different GSTINs → CONFLICT (no auto-pick)", () => {
    expect(classify({ gstNumber: DL }, { gstNumber: HR }, null).action).toBe("CONFLICT");
  });

  it("effective invoice state differs from the GSTIN's → TAX_STATE_DIFFERS (gstRegisteredState, then address, then the workspace address)", () => {
    expect(classify({ gstNumber: DL, gstRegisteredState: "Haryana" }, null, null).action).toBe("TAX_STATE_DIFFERS");
    expect(classify({ gstNumber: DL, address: { state: "Haryana" } }, null, null).action).toBe("TAX_STATE_DIFFERS");
    expect(classify({ gstNumber: DL }, { gstNumber: DL, address: { state: "Haryana" } }, null).action).toBe("TAX_STATE_DIFFERS");
    expect(classify({ gstNumber: DL, address: { state: "delhi " } }, null, null).action).toBe("CREATE_DEFAULT");
  });

  it("PAN on record ≠ GSTIN PAN → PAN_MISMATCH", () => {
    expect(classify({ gstNumber: DL, panNumber: "AABCK1234Q" }, null, null).action).toBe("PAN_MISMATCH");
  });

  it("bad check digit → BAD_GSTIN; unknown state code → STATE_CODE_UNKNOWN", () => {
    expect(classify({ gstNumber: DL.slice(0, 14) + (DL[14] === "A" ? "B" : "A") }, null, null).action).toBe("BAD_GSTIN");
    expect(classify({ gstNumber: gstin("25", PAN) }, null, null).action).toBe("STATE_CODE_UNKNOWN");
  });

  it("Unregistered with a GSTIN somewhere → UNREGISTERED_WITH_GSTIN; no GSTIN → NO_GSTIN; registrations → ALREADY", () => {
    expect(classify({ gstStatus: "UNREGISTERED" }, { gstNumber: DL }, null).action).toBe("UNREGISTERED_WITH_GSTIN");
    expect(classify({ gstStatus: "NOT_SET" }, null, null).action).toBe("NO_GSTIN");
    expect(classify({ gstNumber: DL, gstRegistrations: [{ gstin: DL }] }, null, null).action).toBe("ALREADY");
  });
});
