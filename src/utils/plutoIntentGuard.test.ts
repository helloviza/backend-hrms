// Pluto Hotfix A (F-23) — the HR redirect: stemmed, on follow-ups too, and it
// points at the HRMS page that answers the question.
import { describe, it, expect } from "vitest";
import { isOffDomainQuery, buildOffDomainRedirect, hrTopicsOf } from "./plutoIntentGuard.js";

describe("isOffDomainQuery — stemmed HR matching", () => {
  it.each([
    "how many leaves do I have",
    "[QC] how many leaves do I have",
    "what's my leave balance",
    "apply for sick leave on Friday",
    "can I take leave tomorrow",
    "show my payslips",
    "download my payslip for October",
    "when is salary credited",
    "check my attendance",
    "fill my timesheet",
  ])("first turn: %s → redirected", (p) => {
    expect(isOffDomainQuery(p)).toBe(true);
  });

  it.each([
    "how many leaves do I have",
    "leave balance?",
    "my payslip please",
    "salary slip for last month",
    "mark my attendance",
  ])("follow-up: %s → redirected (was never checked on follow-ups)", (p) => {
    expect(isOffDomainQuery(p, { followUp: true })).toBe(true);
  });

  it.each([
    "ok leave flights for now",
    "leave it for now",
    "we leave at 6",
    "is this within policy?",
    "send it for approval",
    "when should I leave for the airport",
  ])("follow-up: %s → NOT redirected (ordinary trip chat)", (p) => {
    expect(isOffDomainQuery(p, { followUp: true })).toBe(false);
  });

  it.each([
    "when should I leave for the airport",
    "baggage policy for Emirates",
    "trip approval status",
    "apply for leave and book a flight to Goa",
  ])("travel signal wins on the first turn too: %s", (p) => {
    expect(isOffDomainQuery(p)).toBe(false);
  });

  it.each([
    "need to be in Mumbai on 20 Nov for a client meeting in BKC",
    "flights BLR to DEL to BOM",
    "what's the weather in Dubai next week",
  ])("the other QC first messages are not HR: %s", (p) => {
    expect(isOffDomainQuery(p)).toBe(false);
  });

  it("broad admin words still redirect on the first turn only", () => {
    expect(isOffDomainQuery("who is my HR admin")).toBe(true);
    expect(isOffDomainQuery("who is my HR admin", { followUp: true })).toBe(false);
  });
});

describe("buildOffDomainRedirect — links to the right HRMS page", () => {
  it("leave question → Leaves link only", () => {
    const r = buildOffDomainRedirect("how many leaves do I have");
    expect(r.links).toEqual([{ label: "Open Leaves", href: "/leaves/my" }]);
    expect(r.context).toMatch(/leave balance/i);
  });

  it("payslip question → Payslips link", () => {
    expect(buildOffDomainRedirect("download my payslip").links).toEqual([
      { label: "Open Payslips", href: "/payroll/my-payslips" },
    ]);
  });

  it("attendance question → Attendance link", () => {
    expect(buildOffDomainRedirect("check my attendance").links).toEqual([
      { label: "Open Attendance", href: "/attendance/reports" },
    ]);
  });

  it("two topics → both links, in a stable order", () => {
    expect(hrTopicsOf("salary and leave balance")).toEqual(["leave", "pay"]);
    expect(buildOffDomainRedirect("salary and leave balance").links!.map((l) => l.href)).toEqual([
      "/leaves/my",
      "/payroll/my-payslips",
    ]);
  });

  it("a broad-word redirect with no specific topic offers all three", () => {
    expect(buildOffDomainRedirect("who is my HR admin").links).toHaveLength(3);
  });

  it("every link is an internal path", () => {
    for (const p of ["leaves", "payslip", "attendance", "hr admin"]) {
      for (const l of buildOffDomainRedirect(p).links!) expect(l.href.startsWith("/")).toBe(true);
    }
  });
});
