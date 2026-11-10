// Time zones and proper names computed in code (design §4.6 T3–T5, QC F-19, F-24).
import { describe, it, expect } from "vitest";
import {
  tzDifference,
  formatTzDifference,
  tzSentence,
  stripTzSentences,
  statesTimeOffset,
  properCityName,
  timeZoneFor,
} from "./plutoPlaces.js";

describe("tzDifference — IANA zones at the trip date (DST-aware)", () => {
  it("T3: London v Bengaluru is -5h30m in November (GMT) and -4h30m in July (BST)", () => {
    expect(formatTzDifference(tzDifference("BLR", "LHR", "2026-11-16") as number)).toBe("-5h30m");
    expect(formatTzDifference(tzDifference("BLR", "LHR", "2026-07-16") as number)).toBe("-4h30m");
  });
  it("T4: Delhi v Bengaluru is 0 → 'Same time as Bengaluru.'", () => {
    expect(tzDifference("BLR", "DEL", "2026-11-16")).toBe(0);
    expect(tzSentence({ name: "Delhi", iata: "DEL" }, { name: "Bengaluru", iata: "BLR" }, "2026-11-16")).toBe("Same time as Bengaluru.");
  });
  it("F-24: Dubai is 1h 30m BEHIND Bengaluru (the model said 1.5 h ahead)", () => {
    expect(tzDifference("BLR", "DXB", "2026-11-16")).toBe(-90);
    expect(tzSentence({ name: "Dubai" }, { name: "Bengaluru" }, "2026-11-16")).toBe("Dubai is 1h 30m behind Bengaluru.");
  });
  it("Singapore is 2h 30m ahead of Bengaluru; no reference → its UTC offset", () => {
    expect(tzSentence({ name: "Singapore" }, { name: "Bengaluru" }, "2026-11-16")).toBe("Singapore is 2h 30m ahead of Bengaluru.");
    expect(tzSentence({ name: "Dubai" }, null, "2026-11-16")).toBe("Dubai is on UTC+4.");
  });
  it("city names resolve to zones too (London → Europe/London)", () => {
    expect(timeZoneFor({ name: "London" })).toBe("Europe/London");
    expect(timeZoneFor({ name: "Bengaluru" })).toMatch(/Asia\/(Calcutta|Kolkata)/);
  });
});

describe("stripTzSentences — the model's own offsets go; nothing else does", () => {
  it("T1: '1.5 hours ahead of Bengaluru' is stripped, the rest kept", () => {
    const r = stripTzSentences("Dubai is 1.5 hours ahead of Bengaluru, so plan calls early. The Metro is excellent.");
    expect(r.stripped).toBe(1);
    expect(r.text).toBe("The Metro is excellent.");
  });
  it("T2: 'London is on GMT+0 (5.5 hours behind India)' is stripped", () => {
    const r = stripTzSentences("London is on GMT+0 (5.5 hours behind India). Pack an umbrella.");
    expect(r.stripped).toBe(1);
    expect(r.text).toBe("Pack an umbrella.");
  });
  it("other phrasings: 'an hour and a half behind', 'UTC+4', 'time difference is 2 hours'", () => {
    expect(statesTimeOffset("Dubai is an hour and a half behind India.")).toBe(true);
    expect(statesTimeOffset("Dubai runs on UTC+4.")).toBe(true);
    expect(statesTimeOffset("The time difference is 2 hours.")).toBe(true);
    expect(statesTimeOffset("Singapore is 2 hours later than India.")).toBe(true);
  });
  it("T5: durations and schedules are NOT stripped", () => {
    for (const s of [
      "The flight is 4 hours.",
      "Check in 2 hours before departure.",
      "Reach the airport 3 hours earlier.",
      "The drive takes 2 hours and 30 minutes.",
      "Plan for a 9-hour day.",
    ]) {
      expect(stripTzSentences(s)).toEqual({ text: s, stripped: 0 });
    }
  });
});

describe("properCityName (F-19)", () => {
  it("fixes the user's casing from the catalogue, never renames", () => {
    expect(properCityName("bengaluru")).toBe("Bengaluru");
    expect(properCityName("mumbai")).toBe("Mumbai");
    expect(properCityName("london")).toBe("London");
    expect(properCityName("BLR")).toBe("Bengaluru"); // a code the catalogue knows → its city
    expect(properCityName("Dubai Marina")).toBe("Dubai Marina");
  });
});
