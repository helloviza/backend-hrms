// The rubric, tested as the pure function it is — no database, no express.
//
// The point of these tests is not that the arithmetic works. It is that the
// two honesty properties hold: difficulty is never a number, and a percentage
// can only come from SOURCED_APPROVAL.
import { describe, it, expect } from "vitest";
import {
  DIFFICULTY_BANDS,
  KNOWN_BIOMETRIC_OR_INTERVIEW,
  KNOWN_HIGH_FRICTION,
  SCHENGEN_MEMBERS,
  SOURCED_APPROVAL,
  approvalChancesFor,
  difficultyFor,
} from "./visaDifficulty.js";

describe("difficultyFor — the category floor", () => {
  it("floors VISA_FREE and VOA at Easy", () => {
    expect(difficultyFor("TH", "VISA_FREE")).toBe("Easy");
    expect(difficultyFor("MV", "VOA")).toBe("Easy");
  });

  it("floors E_VISA at Moderate", () => {
    expect(difficultyFor("VN", "E_VISA")).toBe("Moderate");
  });

  it("floors STICKER at Hard", () => {
    expect(difficultyFor("AE", "STICKER")).toBe("Hard");
    expect(difficultyFor("SG", "STICKER")).toBe("Hard");
  });
});

describe("difficultyFor — the escalated set", () => {
  it("escalates the US to Very Hard on its sourced 22% refusal rate", () => {
    expect(SOURCED_APPROVAL.US.refusalRatePct).toBeGreaterThan(20);
    expect(difficultyFor("US", "STICKER")).toBe("Very Hard");
  });

  it("escalates China to Very Hard on known friction, with no invented rate", () => {
    expect(KNOWN_HIGH_FRICTION).toContain("CN");
    expect(SOURCED_APPROVAL.CN).toBeUndefined();
    expect(difficultyFor("CN", "STICKER")).toBe("Very Hard");
  });

  it("leaves the UK at Hard — a 93% approval rate is not Very Hard", () => {
    expect(SOURCED_APPROVAL.GB.refusalRatePct).toBeLessThan(20);
    expect(difficultyFor("GB", "STICKER")).toBe("Hard");
  });

  it("leaves every Schengen member at Hard — ~15% refusal is under the bar", () => {
    for (const iso2 of SCHENGEN_MEMBERS) {
      expect(difficultyFor(iso2, "STICKER")).toBe("Hard");
    }
  });

  it("caps at Very Hard when both escalations fire", () => {
    // US is in KNOWN_HIGH_FRICTION *and* over the refusal bar.
    expect(KNOWN_HIGH_FRICTION).toContain("US");
    expect(difficultyFor("US", "STICKER")).toBe("Very Hard");
    expect(DIFFICULTY_BANDS[DIFFICULTY_BANDS.length - 1]).toBe("Very Hard");
  });
});

describe("difficultyFor — biometrics does not double-count a sticker visa", () => {
  /* See utils/visaDifficulty.ts and the design note §4(a). STICKER already
   * means "apply in advance, usually in person", so the biometric rule must
   * not push it higher — otherwise all 29 Schengen members plus GB land in the
   * top band alongside the US. */
  it("does NOT escalate a country already at the STICKER floor", () => {
    expect(KNOWN_BIOMETRIC_OR_INTERVIEW).toContain("FR");
    expect(difficultyFor("FR", "STICKER")).toBe("Hard");
  });

  it("DOES escalate below that floor — the rule is live, not dead", () => {
    // FR is not an e-visa destination; this exercises the RULE, and says so.
    expect(difficultyFor("FR", "E_VISA")).toBe("Hard"); // Moderate + 1
    expect(difficultyFor("GB", "VOA")).toBe("Moderate"); // Easy + 1
  });

  it("escalates nothing today, because every member is STICKER in the seed", async () => {
    // Documents the known-dormant state so a future reader sees it was
    // measured, not overlooked.
    const { listSeedCountries } = await import("../config/visaCountrySeed.js");
    const seed = new Map(listSeedCountries().map((c) => [c.iso2, c.visaCategory]));
    for (const iso2 of KNOWN_BIOMETRIC_OR_INTERVIEW) {
      expect(seed.get(iso2)).toBe("STICKER");
    }
  });
});

describe("approvalChancesFor — never a fabricated number", () => {
  it("says a visa-free country needs nothing", () => {
    expect(approvalChancesFor("TH", "VISA_FREE")).toBe("Not required");
  });

  it("says Very High for e-visa and visa-on-arrival", () => {
    expect(approvalChancesFor("VN", "E_VISA")).toBe("Very High");
    expect(approvalChancesFor("MV", "VOA")).toBe("Very High");
  });

  it("returns the sourced figure for the three sourced regimes", () => {
    expect(approvalChancesFor("US", "STICKER")).toBe("~78% (India, FY25)");
    expect(approvalChancesFor("GB", "STICKER")).toBe("~93% (India)");
    expect(approvalChancesFor("FR", "STICKER")).toBe("~85% (India, 2024)");
  });

  it('says "Varies by profile" for a sticker country with no sourced rate', () => {
    expect(approvalChancesFor("CN", "STICKER")).toBe("Varies by profile");
    expect(approvalChancesFor("AE", "STICKER")).toBe("Varies by profile");
  });

  it("NEVER returns a digit for an iso2 outside SOURCED_APPROVAL", () => {
    const sourced = new Set(Object.keys(SOURCED_APPROVAL));
    // Every two-letter code, against every category the seed can hold.
    for (let a = 65; a <= 90; a += 1) {
      for (let b = 65; b <= 90; b += 1) {
        const iso2 = String.fromCharCode(a, b);
        if (sourced.has(iso2)) continue;
        for (const category of ["VISA_FREE", "E_VISA", "VOA", "STICKER"] as const) {
          expect(approvalChancesFor(iso2, category)).not.toMatch(/\d/);
        }
      }
    }
  });

  it("carries a citation for every sourced figure — a number can't travel without one", () => {
    for (const [iso2, entry] of Object.entries(SOURCED_APPROVAL)) {
      expect(entry.citation, iso2).toBeTruthy();
      expect(entry.citation.length, iso2).toBeGreaterThan(20);
      expect(typeof entry.refusalRatePct, iso2).toBe("number");
    }
  });

  it("covers exactly US, GB and the 29 Schengen members — nothing spread elsewhere", () => {
    expect(SCHENGEN_MEMBERS).toHaveLength(29);
    expect(Object.keys(SOURCED_APPROVAL).sort()).toEqual(
      ["US", "GB", ...SCHENGEN_MEMBERS].sort(),
    );
    // Cyprus and Ireland are EU but NOT Schengen.
    expect(SOURCED_APPROVAL.CY).toBeUndefined();
    expect(SOURCED_APPROVAL.IE).toBeUndefined();
  });
});
