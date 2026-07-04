// Phase 4 Step 3 — constrained command resolver.
import { describe, it, expect } from "vitest";
import { resolveCommand, normalizeCommand } from "./arrivalConcierge.js";

const session = (over: any = {}) => ({
  destinationIata: "BOM",
  destinationCity: "Mumbai",
  hotel: { name: "Taj", address: "Apollo Bunder, Colaba", phone: "+912266", checkInDate: "2026-08-12" },
  bookerName: "Asha Rao",
  bookerEmail: "asha@ex.com",
  bookerPhone: "+9199",
  ...over,
});

describe("normalizeCommand", () => {
  it("button ids win", () => {
    expect(normalizeCommand("arr_hotel")).toBe("hotel");
    expect(normalizeCommand("arr_booker")).toBe("booker");
    expect(normalizeCommand("arr_help")).toBe("help");
  });
  it("tolerant text + numeric aliases", () => {
    expect(normalizeCommand("", "Hotel")).toBe("hotel");
    expect(normalizeCommand("", "1")).toBe("hotel");
    expect(normalizeCommand("", "2")).toBe("booker");
    expect(normalizeCommand("", "3")).toBe("help");
    expect(normalizeCommand("", "SOS")).toBe("emergency");
    expect(normalizeCommand("", "stop")).toBe("stop");
    expect(normalizeCommand("", "where's the pool")).toBe("unknown");
  });
});

describe("resolveCommand", () => {
  it("hotel → name, address, phone, check-in, maps link", () => {
    const r = resolveCommand(session(), "arr_hotel");
    expect(r.action).toBe("REPLY");
    expect(r.text).toContain("Taj");
    expect(r.text).toContain("Apollo Bunder");
    expect(r.text).toContain("Check-in: 2026-08-12");
    expect(r.text).toContain("https://www.google.com/maps/search/?api=1&query=");
    expect(r.text).toContain(encodeURIComponent("Apollo Bunder, Colaba"));
  });

  it("hotel with none on file → fallback offering booker", () => {
    const r = resolveCommand(session({ hotel: null }), "arr_hotel");
    expect(r.text).toContain("don't have a hotel on file");
    expect(r.text?.toLowerCase()).toContain("booker");
  });

  it("booker → name + email + phone + HELP nudge", () => {
    const r = resolveCommand(session(), "arr_booker");
    expect(r.text).toContain("Asha Rao");
    expect(r.text).toContain("asha@ex.com");
    expect(r.text).toContain("+9199");
    expect(r.text).toContain("HELP");
  });

  it("emergency → country numbers for a known destination", () => {
    const r = resolveCommand(session(), "", "emergency");
    expect(r.text).toContain("Police: 100"); // India
    expect(r.text).toContain("Ambulance: 108");
  });

  it("emergency → generic 112 fallback for an unknown country", () => {
    const r = resolveCommand(session({ destinationIata: "ZZZ" }), "", "sos");
    expect(r.text).toContain("112");
  });

  it("help → ESCALATE", () => {
    expect(resolveCommand(session(), "arr_help").action).toBe("ESCALATE");
  });

  it("stop → OPT_OUT with confirmation", () => {
    const r = resolveCommand(session(), "", "unsubscribe");
    expect(r.action).toBe("OPT_OUT");
    expect(r.text).toContain("unsubscribed");
  });

  it("unknown → MENU with the 3 arr_ buttons", () => {
    const r = resolveCommand(session(), "", "hmm");
    expect(r.action).toBe("MENU");
    expect(r.buttons?.map((b) => b.id)).toEqual(["arr_hotel", "arr_booker", "arr_help"]);
  });
});
