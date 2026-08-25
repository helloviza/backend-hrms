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
  approvalFiguresFor,
  clampDisplayPct,
  APPROVAL_ESTIMATE_DISCLAIMER,
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
  /* Was: "escalates the US to Very Hard on its sourced 22% refusal rate",
   * asserting refusalRatePct > 20 as the CAUSE. After the display-only
   * decision that is no longer why — difficultyFor does not read the
   * approval data at all. The US still reaches Very Hard, on friction, and
   * the band is unchanged; only the reason moved. Asserting the old cause
   * would now pass by coincidence (its rate is 24%) while testing nothing. */
  it("escalates the US to Very Hard on known friction", () => {
    expect(KNOWN_HIGH_FRICTION).toContain("US");
    expect(difficultyFor("US", "STICKER")).toBe("Very Hard");
  });

  /* THE GUARD THAT REPLACES THE REFUSAL-RATE COUPLING.
   *
   * Difficulty must be a pure function of category + the two named
   * constants, and must not move when the dataset moves.
   *
   * PORTUGAL IS THE LOAD-BEARING CASE: 68% in 2026 is a 32% refusal, well
   * over the bar the old coupling used, so it is one of the 38 countries
   * that DID escalate while the dataset was wired in. If the wiring ever
   * comes back, this is the assertion that fails. AE (98%) is the control
   * — sourced, unescalated either way. */
  it("does NOT read the approval dataset — a sourced country still bands at its floor", () => {
    expect(SOURCED_APPROVAL.AE).toBeTruthy();
    expect(SOURCED_APPROVAL.AE.figures.y2026).toBe(98);
    expect(KNOWN_HIGH_FRICTION).not.toContain("AE");
    expect(KNOWN_BIOMETRIC_OR_INTERVIEW).not.toContain("AE");
    expect(difficultyFor("AE", "STICKER")).toBe("Hard");

    // Portugal: 68% in 2026 -> 32% refusal, comfortably over the old 20%
    // bar. It must still be Hard, because that bar no longer exists.
    expect(SOURCED_APPROVAL.PT.refusalRatePct).toBeGreaterThan(20);
    expect(difficultyFor("PT", "STICKER")).toBe("Hard");
  });

  /* ⚠ THIS TEST'S ORIGINAL GUARANTEE IS GONE — REVIEW BEFORE SHIPPING.
   *
   * It used to assert `SOURCED_APPROVAL.CN` was UNDEFINED, encoding the
   * rule stated in visaDifficulty.ts: "we hold no sourced Chinese approval
   * rate ... inventing a Chinese percentage to make [difficulty and
   * approval] agree is the failure this file is built to prevent."
   *
   * The 194-country dataset supplies one (66/81/88), so CN now HAS a
   * figure and that assertion could not survive. The escalation itself is
   * unchanged and still tested — CN reaches Very Hard on friction alone,
   * which is what this test was really protecting. What is no longer
   * protected is the claim that we print no Chinese number at all. */
  it("escalates China to Very Hard on known friction", () => {
    expect(KNOWN_HIGH_FRICTION).toContain("CN");
    expect(difficultyFor("CN", "STICKER")).toBe("Very Hard");
  });

  it("leaves the UK at Hard — a 93% approval rate is not Very Hard", () => {
    expect(SOURCED_APPROVAL.GB.refusalRatePct).toBeLessThan(20);
    expect(difficultyFor("GB", "STICKER")).toBe("Hard");
  });

  it("leaves every Schengen member at Hard — the approval data does not reach difficulty", () => {
    /* Restored to its HEAD form after the display-only decision.
     *
     * It briefly asserted the opposite — that each member banded on its own
     * 2026 figure, which put 21 of the 29 at Very Hard. That is what feeding
     * the dataset into the escalation did, and it is exactly what was
     * reverted: the figures are DISPLAY-ONLY and difficultyFor no longer
     * reads them. So all 29 sit at the STICKER floor again, together. */
    for (const iso2 of SCHENGEN_MEMBERS) {
      expect(difficultyFor(iso2, "STICKER")).toBe("Hard");
    }
  });

  it("caps at Very Hard rather than running off the end of the band list", () => {
    // Only one escalation can fire now; the cap is still what stops a
    // STICKER floor plus friction from indexing past "Very Hard".
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

  /* "Very High" is now the NO-DATA fallback and nothing else. VN and MV
   * used to stand here and cannot: both hold figures (96% and 100%), so
   * both now show them. CI and HK are the honest fixtures — the dataset
   * has no row for either. */
  it("says Very High for e-visa and visa-on-arrival ONLY where we hold no data", () => {
    expect(SOURCED_APPROVAL.CI).toBeUndefined();
    expect(SOURCED_APPROVAL.HK).toBeUndefined();
    expect(approvalChancesFor("CI", "E_VISA")).toBe("Very High");
    expect(approvalChancesFor("CI", "VOA")).toBe("Very High");
    expect(approvalChancesFor("HK", "TRAVEL_AUTH")).toBe("Very High");

    // With data, the same categories show numbers instead.
    expect(approvalChancesFor("VN", "E_VISA")).toBe("~96% (India, 2026)");
    // MV is 100/100/100 in the data and shows ~99% — the display clamp.
    expect(approvalChancesFor("MV", "VOA")).toBe("~99% (India, 2026)");
  });

  it("returns the sourced figure, derived from that country's own y2026", () => {
    for (const iso2 of ["US", "GB", "FR"]) {
      const sourced = SOURCED_APPROVAL[iso2];
      expect(sourced, iso2).toBeTruthy();
      // Derived, never authored: the string IS y2026 rendered.
      expect(approvalChancesFor(iso2, "STICKER"), iso2).toBe(`~${sourced.figures.y2026}% (India, 2026)`);
    }
    // They are per-country now, not one shared aggregate.
    expect(approvalChancesFor("FR", "STICKER")).not.toBe(approvalChancesFor("PT", "STICKER"));
  });

  it('says "Varies by profile" for a sticker country with no sourced rate', () => {
    // Countries genuinely absent from the dataset. CI/HK/MO are the three
    // the seed carries that it does not cover; IN is null by construction
    // (the data is India-ORIGIN, so India-into-India is not a corridor).
    for (const iso2 of ["CI", "HK", "MO", "IN"]) {
      expect(SOURCED_APPROVAL[iso2], iso2).toBeUndefined();
      expect(approvalChancesFor(iso2, "STICKER"), iso2).toBe("Varies by profile");
    }
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

  /* RETIRED: "carries a citation for every sourced figure — a number can't
   * travel without one". The per-country citation is gone by decision, not
   * by oversight: the dataset is aggregated from many public sources and no
   * single publisher can be named per row, so a per-country credit would be
   * a fabrication. The guarantee moved to the surface — every figure is
   * shown beside APPROVAL_ESTIMATE_DISCLAIMER — and the frontend renders
   * the two from one component so they cannot come apart.
   *
   * What survives here is the half that is still checkable in this module:
   * an entry is well-formed, and the disclaimer that now carries the
   * honesty is present and says what it must. */
  /* ── THE DISPLAY CLAMP ────────────────────────────────────────────
   *
   * 1–99 on the way OUT. A flat 100% reads as "guaranteed" and 0% as
   * "impossible", and neither is a claim an aggregate can support. The
   * dataset is not edited to achieve it — these assertions check both
   * halves of that: what a reader sees is bounded, what we store is not. */
  it("clamps a displayed figure to 1-99, and leaves in-range values alone", () => {
    expect(clampDisplayPct(100)).toBe(99);
    expect(clampDisplayPct(101)).toBe(99);
    expect(clampDisplayPct(0)).toBe(1);
    expect(clampDisplayPct(-5)).toBe(1);
    // Untouched across the whole ordinary range, including both edges.
    for (const v of [1, 2, 3, 50, 82, 98, 99]) expect(clampDisplayPct(v), String(v)).toBe(v);
  });

  it("renders a 100% country as ~99% on all three lines AND on the headline", () => {
    // MV is 100/100/100 in the dataset.
    expect(SOURCED_APPROVAL.MV.figures).toEqual({ avg5: 100, avg3: 100, y2026: 100 });
    // …and every displayed form of it is 99.
    expect(approvalFiguresFor("MV", "VOA")).toEqual({ avg5: 99, avg3: 99, y2026: 99 });
    expect(approvalChancesFor("MV", "VOA")).toBe("~99% (India, 2026)");

    // TH is 99/100/100 — the clamp is per-line, so the 99 stays a 99.
    expect(approvalFiguresFor("TH", "TRAVEL_AUTH")).toEqual({ avg5: 99, avg3: 99, y2026: 99 });
  });

  it("leaves every in-range country byte-identical", () => {
    expect(approvalFiguresFor("RU", "E_VISA")).toEqual({ avg5: 93, avg3: 94, y2026: 95 });
    expect(approvalFiguresFor("FR", "STICKER")).toEqual({ avg5: 79, avg3: 81, y2026: 82 });
    expect(approvalFiguresFor("UA", "E_VISA")).toEqual({ avg5: 3, avg3: 4, y2026: 3 });
    expect(approvalChancesFor("FR", "STICKER")).toBe("~82% (India, 2026)");
  });

  /* DATA, NOT DISPLAY. The stored entry keeps the real number, and so does
   * refusalRatePct — clamping that would silently move a derived value that
   * has nothing to do with rendering. */
  it("does NOT clamp the stored data", () => {
    const hundreds = Object.entries(SOURCED_APPROVAL).filter(
      ([, e]) => e.figures.y2026 >= 100,
    );
    expect(hundreds.length).toBeGreaterThan(0);
    for (const [iso2, e] of hundreds) {
      expect(e.figures.y2026, iso2).toBe(100);
      expect(e.refusalRatePct, iso2).toBe(0);
    }
  });

  it("has one feature-level disclaimer, and it makes no per-country claim", () => {
    expect(APPROVAL_ESTIMATE_DISCLAIMER).toBeTruthy();
    // The two jobs it has to do: describe the data honestly, and refuse
    // the personal reading (rule 2).
    expect(APPROVAL_ESTIMATE_DISCLAIMER).toMatch(/indicative estimates/i);
    expect(APPROVAL_ESTIMATE_DISCLAIMER).toMatch(/individual profile/i);
    // It names no publisher, because no publisher can be named.
    expect(APPROVAL_ESTIMATE_DISCLAIMER).not.toMatch(/TODO|source not yet|State Department|Commission/i);

    for (const [iso2, entry] of Object.entries(SOURCED_APPROVAL)) {
      expect(typeof entry.refusalRatePct, iso2).toBe("number");
      expect(entry.label, iso2).toMatch(/^~\d+% \(India, 2026\)$/);
    }
  });

  /* Was: "covers exactly US, GB and the 29 Schengen members". The dataset
   * replaced that hand-written 31-entry table, so the membership assertion
   * became a coverage assertion. Cyprus and Ireland now DO have their own
   * figures — which is the improvement, not a regression: they were absent
   * before only because neither is Schengen and we had no separate rate. */
  it("covers the whole dataset, and every entry carries all three figures", () => {
    const codes = Object.keys(SOURCED_APPROVAL);
    expect(codes.length).toBeGreaterThan(150);

    for (const [iso2, entry] of Object.entries(SOURCED_APPROVAL)) {
      expect(iso2).toMatch(/^[A-Z]{2}$/);
      for (const k of ["avg5", "avg3", "y2026"] as const) {
        const v = entry.figures[k];
        expect(Number.isInteger(v), `${iso2}.${k}`).toBe(true);
        expect(v, `${iso2}.${k}`).toBeGreaterThanOrEqual(0);
        expect(v, `${iso2}.${k}`).toBeLessThanOrEqual(100);
      }
      // The escalation input is the complement of the live year, always.
      expect(entry.refusalRatePct, iso2).toBe(100 - entry.figures.y2026);
    }
  });

  /* India is the one entry the dataset ships with nulls, because the data
   * is India-ORIGIN. It must not become a row — a row means "a number we
   * may print", and there is no India-into-India number to print. */
  it("builds NO entry for India, whose three figures are null by construction", () => {
    expect(SOURCED_APPROVAL.IN).toBeUndefined();
    expect(approvalChancesFor("IN", "STICKER")).toBe("Varies by profile");
    expect(approvalFiguresFor("IN", "STICKER")).toBeNull();
  });

  /* The category short-circuit still wins over the dataset. A country can
   * hold three figures and still display a fixed string, and when it does
   * the figures must NOT come along — three percentages under the words
   * "Not required" would answer a question the reader was just told does
   * not apply. */
  it("withholds figures ONLY for visa-free, whatever the data says", () => {
    /* VISA_FREE is the one suppression left. AE holds 98/98/98 and still
     * shows nothing under that category, because there is no application to
     * approve — the number would answer a question the reader was just told
     * does not apply. */
    expect(SOURCED_APPROVAL.AE.figures.y2026).toBe(98);
    expect(approvalChancesFor("AE", "VISA_FREE")).toBe("Not required");
    expect(approvalFiguresFor("AE", "VISA_FREE")).toBeNull();

    // Every OTHER category hands the same country's figures over.
    for (const category of ["E_VISA", "VOA", "TRAVEL_AUTH", "STICKER", "RESTRICTED"] as const) {
      expect(approvalChancesFor("AE", category), category).toBe("~98% (India, 2026)");
      expect(approvalFiguresFor("AE", category), category).toEqual({
        avg5: 98,
        avg3: 98,
        y2026: 98,
      });
    }
  });

  /* THE RULE, at both ends of the data and at its absence.
   *
   * There is no threshold any more. A high figure and a low one take the
   * same path, which is the property the 90% version did not have: the card
   * FORMAT no longer moves when the data does. */
  it("shows an e-visa corridor's figures regardless of how high or low they are", () => {
    // Low — the case that killed the unconditional "Very High".
    expect(approvalChancesFor("UA", "E_VISA")).toBe("~3% (India, 2026)");
    expect(approvalFiguresFor("UA", "E_VISA")).toEqual({ avg5: 3, avg3: 4, y2026: 3 });

    // High — the case that survived the threshold version and no longer does.
    expect(approvalChancesFor("RU", "E_VISA")).toBe("~95% (India, 2026)");
    expect(approvalFiguresFor("RU", "E_VISA")).toEqual({ avg5: 93, avg3: 94, y2026: 95 });

    // Absent — "Very High" survives ONLY here, as the fallback it always was.
    expect(SOURCED_APPROVAL.CI).toBeUndefined();
    expect(approvalChancesFor("CI", "E_VISA")).toBe("Very High");
    expect(approvalFiguresFor("CI", "E_VISA")).toBeNull();
  });
});
