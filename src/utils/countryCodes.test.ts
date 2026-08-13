// Coverage for normaliseToIso2()'s three non-obvious input shapes it has to
// reconcile on VisaApplication: ISO2 passthrough, ISO3 (passport MRZ), and
// demonym (TravellerProfile.nationality free text, e.g. OCR output).
import { describe, it, expect } from "vitest";
import { normaliseToIso2, getCountryByIso2, VISA_COUNTRY_REGIONS } from "./countryCodes.js";
// Coverage checklist, not source data — {name, iso2, tier} only. Every
// entry here must resolve via normaliseToIso2(); countryCodes.ts owns the
// iso3/demonym/alias data behind that resolution. It lives beside this test
// rather than under docs/ because apps/backend is deployed as a git subtree:
// anything above this directory simply does not exist in the build.
import visaCountryChecklist from "./visa-country-codes-required.json" with { type: "json" };

describe("normaliseToIso2", () => {
  it("passes through a valid ISO2 code, case-insensitively", () => {
    expect(normaliseToIso2("IN")).toBe("IN");
    expect(normaliseToIso2("in")).toBe("IN");
    expect(normaliseToIso2(" de ")).toBe("DE");
  });

  it("resolves ISO3 / passport MRZ issuing-state codes", () => {
    expect(normaliseToIso2("IND")).toBe("IN");
    expect(normaliseToIso2("DEU")).toBe("DE");
    expect(normaliseToIso2("ARE")).toBe("AE");
    expect(normaliseToIso2("USA")).toBe("US");
    expect(normaliseToIso2("KHM")).toBe("KH");
    expect(normaliseToIso2("NPL")).toBe("NP");
    expect(normaliseToIso2("gbr")).toBe("GB");
  });

  it("resolves demonyms — the TravellerProfile.nationality free-text case", () => {
    expect(normaliseToIso2("INDIAN")).toBe("IN");
    expect(normaliseToIso2("Indian")).toBe("IN");
    expect(normaliseToIso2("Emirati")).toBe("AE");
    expect(normaliseToIso2("American")).toBe("US");
    expect(normaliseToIso2("Cambodian")).toBe("KH");
    // Nepal has two commonly used demonyms — both must resolve.
    expect(normaliseToIso2("Nepali")).toBe("NP");
    expect(normaliseToIso2("Nepalese")).toBe("NP");
  });

  it("resolves common names, including multi-word names", () => {
    expect(normaliseToIso2("Germany")).toBe("DE");
    expect(normaliseToIso2("United Arab Emirates")).toBe("AE");
    expect(normaliseToIso2("United States")).toBe("US");
  });

  it("resolves common aliases and abbreviations", () => {
    expect(normaliseToIso2("UAE")).toBe("AE");
    expect(normaliseToIso2("USA")).toBe("US");
    expect(normaliseToIso2("UK")).toBe("GB");
    expect(normaliseToIso2("Turkey")).toBe("TR");
    expect(normaliseToIso2("Burma")).toBe("MM");
  });

  it("is whitespace-tolerant and strips periods (U.A.E., U.S.A.)", () => {
    expect(normaliseToIso2("  india  ")).toBe("IN");
    expect(normaliseToIso2("United  Arab   Emirates")).toBe("AE");
    expect(normaliseToIso2("U.A.E.")).toBe("AE");
    expect(normaliseToIso2("U.S.A.")).toBe("US");
  });

  it("strips a parenthetical qualifier before lookup (checklist PDFs suffix the covering emirate/city)", () => {
    expect(normaliseToIso2("United Arab Emirates(Dubai)")).toBe("AE");
    expect(normaliseToIso2("United Arab Emirates (Dubai)")).toBe("AE");
    expect(normaliseToIso2("United Kingdom (London)")).toBe("GB");
  });

  it("returns null for unrecognised or empty input, never throws", () => {
    expect(normaliseToIso2("Narnia")).toBeNull();
    expect(normaliseToIso2("")).toBeNull();
    expect(normaliseToIso2(null)).toBeNull();
    expect(normaliseToIso2(undefined)).toBeNull();
  });

  it("resolves the aliases required by the source price data", () => {
    expect(normaliseToIso2("Dubai")).toBe("AE");
    expect(normaliseToIso2("Algerian")).toBe("DZ");
    expect(normaliseToIso2("Hong Kong SAR")).toBe("HK");
    expect(normaliseToIso2("Türkiye")).toBe("TR");
    expect(normaliseToIso2("Turkiye")).toBe("TR");
  });
});

describe("visa country coverage checklist", () => {
  it("resolves every entry in visa-country-codes-required.json", () => {
    const unresolved: string[] = [];
    for (const entry of visaCountryChecklist as Array<{ name: string; iso2: string; tier: string }>) {
      const resolved = normaliseToIso2(entry.name);
      if (resolved !== entry.iso2) {
        unresolved.push(`${entry.name} (${entry.tier}): expected ${entry.iso2}, got ${resolved}`);
      }
    }
    expect(unresolved).toEqual([]);
    expect((visaCountryChecklist as unknown[]).length).toBe(115);
  });

  it("gives every checklist entry a valid region via getCountryByIso2", () => {
    const invalid: string[] = [];
    for (const entry of visaCountryChecklist as Array<{ name: string; iso2: string }>) {
      const country = getCountryByIso2(entry.iso2);
      if (!country || !(VISA_COUNTRY_REGIONS as readonly string[]).includes(country.region)) {
        invalid.push(`${entry.name} (${entry.iso2}): region=${country?.region}`);
      }
    }
    expect(invalid).toEqual([]);
  });

  it("keeps GULF to the six GCC states only", () => {
    for (const iso2 of ["AE", "SA", "QA", "KW", "BH", "OM"]) {
      expect(getCountryByIso2(iso2)?.region).toBe("GULF");
    }
  });

  it("puts non-GCC Middle East countries in MIDDLE_EAST, not GULF", () => {
    for (const iso2 of ["IL", "JO", "LB", "IR", "IQ"]) {
      expect(getCountryByIso2(iso2)?.region).toBe("MIDDLE_EAST");
    }
  });

  it("assigns Türkiye to EUROPE and Egypt to AFRICA, per docs/design/visa-flow/'s dataset", () => {
    expect(getCountryByIso2("TR")?.region).toBe("EUROPE");
    expect(getCountryByIso2("EG")?.region).toBe("AFRICA");
  });
});

describe("getCountryByIso2", () => {
  it("returns the full entry for a known ISO2 code", () => {
    expect(getCountryByIso2("NP")).toMatchObject({ iso3: "NPL", name: "Nepal", demonym: "Nepali" });
  });

  it("returns undefined for an unknown code", () => {
    expect(getCountryByIso2("ZZ")).toBeUndefined();
  });
});
