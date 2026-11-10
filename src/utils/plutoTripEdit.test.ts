import { describe, it, expect } from "vitest";
import {
  stripFiller,
  parseTripEdit,
  tripEditBranch,
  parseStayAnswer,
  resolveStayWindow,
  resolveDateToken,
  roomsFor,
  nearLabel,
  stayLabel,
  dayLabel,
} from "./plutoTripEdit.js";

// 2026-11-09 10:00 IST — the QC day.
const NOW = new Date("2026-11-09T04:30:00Z");
const edit = (p: string, start: string | null = "2026-11-20") => parseTripEdit(p, { start, now: NOW });

describe("stripFiller (S2 a)", () => {
  it.each([
    ["ok leave flights for now", "leave flights for now"],
    ["okay, leave flights for now!", "leave flights for now"],
    ["[QC3] ok leave flights for now", "leave flights for now"],
    ["[QC3] bengaluru to mumbai on 20 nov", "bengaluru to mumbai on 20 nov"],
    ["hi Pluto, bengaluru to mumbai on 20 nov 🙂", "bengaluru to mumbai on 20 nov"],
    ["hey, skip hotels thanks", "skip hotels"],
    ["pls 3 nights thank you!!", "3 nights"],
    ["Pluto: back to flights please 🙏", "back to flights"],
    ["…change to 21 Nov.", "change to 21 Nov"],
  ])("%s", (p, want) => expect(stripFiller(p)).toBe(want));

  it("leaves the middle alone and keeps a trailing k on a fare", () => {
    expect(stripFiller("skip hotels, show me flights to Goa")).toBe("skip hotels, show me flights to Goa");
    expect(stripFiller("under 12 k")).toBe("under 12 k");
    expect(stripFiller("flights to Delhi")).toBe("flights to Delhi");
  });
});

describe("resolveDateToken", () => {
  it("full dates use the nearest future; a bare day uses the reference month, rolling past the floor", () => {
    expect(resolveDateToken("21 Nov", { now: NOW })).toBe("2026-11-21");
    expect(resolveDateToken("21st", { ref: "2026-11-20", now: NOW })).toBe("2026-11-21");
    // "back on the 2nd" after a 22 Nov start → 2 Dec (design §5 G-F 4)
    expect(resolveDateToken("2nd", { ref: "2026-11-22", after: "2026-11-23", now: NOW })).toBe("2026-12-02");
    expect(resolveDateToken("21/11", { now: NOW })).toBe("2026-11-21");
    expect(resolveDateToken("5/1", { now: NOW })).toBe("2027-01-05");
  });
});

describe("parseTripEdit (design §3.3)", () => {
  it.each<[string, Record<string, unknown>]>([
    ["change to 21 Nov", { start: "2026-11-21" }],
    ["move it to the 21st", { start: "2026-11-21" }],
    ["make it 21/11", { start: "2026-11-21" }],
    ["okay change to 21 Nov please", { start: "2026-11-21" }],
    ["a day later", { shiftDays: 1 }],
    ["one day earlier", { shiftDays: -1 }],
    ["push it by 2 days", { shiftDays: 2 }],
    ["round trip back on 22nd", { returnDate: "2026-11-22" }],
    ["return on the 22nd", { returnDate: "2026-11-22" }],
    ["coming back 24 Nov", { returnDate: "2026-11-24" }],
    ["one way", { oneWay: true }],
    ["make it one way please", { oneWay: true }],
    ["3 nights", { nights: 3 }],
    ["stay 2 more nights", { nightsDelta: 2 }],
    ["for 2 people", { adults: 2 }],
    ["2 of us, business class", { adults: 2, cabin: "Business" }],
    ["add my colleague", { adultsDelta: 1 }],
    ["just me", { adults: 1 }],
    ["business class instead", { cabin: "Business" }],
    ["economy is fine", { cabin: "Economy" }],
    ["premium economy", { cabin: "Premium Economy" }],
    ["separate rooms", { separateRooms: true }],
  ])("%s", (p, want) => expect(edit(p)).toEqual(want));

  it("round trip relative to the current start: 'back on the 2nd' after 22 Nov is 2 Dec", () => {
    expect(edit("round trip back on the 2nd", "2026-11-22")).toEqual({ returnDate: "2026-12-02" });
  });

  it.each([
    "flights from Bengaluru to Mumbai on 20 Nov",
    "change to Goa",
    "flights for 2 adults from DEL to BOM on 5 Dec",
    "business trip to Pune",
    "hotels in Dubai for 3 nights",
    "what's the baggage allowance?",
    "only non-stop",
    "cheaper option?",
    "ok leave flights for now",
    "make it for 3 nights in Goa",
  ])("not a pure edit: %s", (p) => expect(edit(p)).toBeNull());

  it("a count is never a date: 'make it 3 nights' is nights, not the 3rd", () => {
    expect(edit("make it 3 nights")).toEqual({ nights: 3 });
  });

  it("names the branch", () => {
    expect(tripEditBranch({ start: "2026-11-21" })).toBe("change_dates");
    expect(tripEditBranch({ returnDate: "2026-11-22" })).toBe("add_return");
    expect(tripEditBranch({ adults: 2, cabin: "Business" })).toBe("change_travellers");
    expect(tripEditBranch({ cabin: "Business" })).toBe("change_cabin");
    expect(tripEditBranch({ nights: 3 })).toBe("change_nights");
  });
});

describe("parseStayAnswer (design §3.7)", () => {
  const IN = "2026-11-16";
  it.each<[string, string | null, { start: string; end: string; nights: number }]>([
    ["3 nights", IN, { start: IN, end: "2026-11-19", nights: 3 }],
    ["3", IN, { start: IN, end: "2026-11-19", nights: 3 }],
    ["pls 3 nights thanks", IN, { start: IN, end: "2026-11-19", nights: 3 }],
    ["2 nights (till Wed 18 Nov)", IN, { start: IN, end: "2026-11-18", nights: 2 }],
    ["till the 22nd", "2026-11-20", { start: "2026-11-20", end: "2026-11-22", nights: 2 }],
    ["until 19 Nov", IN, { start: IN, end: "2026-11-19", nights: 3 }],
    ["16 to 19 nov, same as the flight", IN, { start: IN, end: "2026-11-19", nights: 3 }],
    ["16 to 19 nov", null, { start: IN, end: "2026-11-19", nights: 3 }],
    ["16 Nov for 3 nights", null, { start: IN, end: "2026-11-19", nights: 3 }],
  ])("%s", (p, checkIn, want) => expect(parseStayAnswer(p, checkIn, NOW)).toEqual(want));

  it("not an answer", () => {
    for (const p of ["what's near Burj Khalifa?", "cheaper ones", "Pune"]) expect(parseStayAnswer(p, IN, NOW)).toBeNull();
    expect(parseStayAnswer("3 nights", null, NOW)).toBeNull(); // no check-in to count from
  });
});

describe("resolveStayWindow", () => {
  const L = (dates: any) => ({ dates });
  it("typed range wins over the lock (QC F-07)", () => {
    expect(resolveStayWindow("hotels in dubai 16 to 19 nov", L({ start: "2026-11-20", end: "2026-11-22" }), NOW))
      .toMatchObject({ start: "2026-11-16", end: "2026-11-19", nights: 3, source: "prompt" });
  });
  it("'for 3 nights' counts from the locked start (A7)", () => {
    expect(resolveStayWindow("hotels near Burj Khalifa for 3 nights", L({ start: "2026-11-16" }), NOW))
      .toMatchObject({ start: "2026-11-16", end: "2026-11-19", nights: 3, source: "nights" });
  });
  it("locked nights / end / the flight's return", () => {
    expect(resolveStayWindow("hotels", L({ start: "2026-11-16", nights: 2 }), NOW)).toMatchObject({ end: "2026-11-18", source: "locked" });
    expect(resolveStayWindow("hotels", L({ start: "2026-11-16", end: "2026-11-19" }), NOW)).toMatchObject({ nights: 3, source: "locked" });
    expect(resolveStayWindow("hotels", L({ start: "2026-11-16", returnDate: "2026-11-20" }), NOW)).toMatchObject({ nights: 4, source: "return" });
  });
  it("a start alone is asked about (A7′, B5); nothing at all is null", () => {
    expect(resolveStayWindow("hotels near BKC", L({ start: "2026-11-20" }), NOW)).toEqual({ start: "2026-11-20", end: null, nights: null, source: "start_only" });
    expect(resolveStayWindow("hotels in dubai", {}, NOW)).toBeNull();
  });
});

describe("rooms and labels (Q6)", () => {
  it("two to a room unless separate", () => {
    expect([1, 2, 3, 4, 5].map((n) => roomsFor(n))).toEqual([1, 1, 2, 2, 3]);
    expect(roomsFor(3, true)).toBe(3);
  });
  it("near label, stay and day labels", () => {
    expect(nearLabel("hotels near Burj Khalifa for 3 nights")).toBe("Burj Khalifa");
    expect(nearLabel("hotel near BKC")).toBe("BKC");
    expect(nearLabel("Hotels in London near Soho")).toBe("Soho");
    expect(nearLabel("hotels near me")).toBeNull();
    expect(stayLabel("2026-11-16", "2026-11-19")).toBe("16–19 Nov");
    expect(stayLabel("2026-11-30", "2026-12-02")).toBe("30 Nov–2 Dec");
    expect(dayLabel("2026-11-21")).toBe("Sat 21 Nov");
  });
});
