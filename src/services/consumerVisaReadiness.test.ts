// apps/backend/src/services/consumerVisaReadiness.test.ts
//
// THE READINESS MATRIX.
//
// A pure function over a profile shape, so these are pure tests — no
// Mongo, no router, no clock. `now` is INJECTED into every case that
// touches a date: a suite whose passport-validity assertions depend on
// the wall clock is a suite that starts failing six months after it was
// written, and the failure would look like a code regression.
//
// The properties under test are the ones the gauge's honesty rests on:
//   • an item is true ONLY when a real stored signal says so
//   • a passport inside the six-month window fails VALIDITY while still
//     passing PASSPORT — they are two items because they are two facts
//   • readiness is NOT completion, and the same profile can score
//     differently on each
import { describe, it, expect } from "vitest";

import {
  computeVisaReadiness,
  PASSPORT_VALIDITY_WINDOW_MS,
  READINESS_BANK_STATEMENT_DOC_CODE,
  READINESS_PERSONAL_TAB_KEY,
  READINESS_PHOTO_DOC_CODE,
} from "./consumerVisaReadiness.js";
import { computeProfileCompletion } from "./consumerProfileCompletion.js";

/** A fixed "today", so no assertion below depends on when it is run. */
const NOW = new Date("2026-08-22T00:00:00.000Z");

const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

/** Reads one item's verdict by key, and fails loudly if the key is gone. */
function ready(result: ReturnType<typeof computeVisaReadiness>, key: string): boolean {
  const item = result.items.find((i) => i.key === key);
  if (!item) throw new Error(`no readiness item "${key}" — the contract changed`);
  return item.ready;
}

/** Everything present. The 6/6 baseline every other case degrades from. */
function fullyReadyProfile() {
  return {
    personal: {
      firstName: "Aditi",
      lastName: "Rao",
      dateOfBirth: new Date("1994-03-11T00:00:00.000Z"),
      nationality: "Indian",
    },
    passports: [
      {
        number: "Z1234567",
        expiryDate: daysFromNow(400),
        isPrimary: true,
      },
    ],
    contact: {},
    travel: {
      travelHistory: [{ country: "Thailand", travelDate: new Date("2025-01-04T00:00:00.000Z") }],
    },
    coTravellers: [],
  } as any;
}

const FULL_DOCS = [
  { docCode: READINESS_PHOTO_DOC_CODE },
  { docCode: READINESS_BANK_STATEMENT_DOC_CODE },
];

describe("computeVisaReadiness — the six items", () => {
  it("scores 6/6 at 100% when every signal is present", () => {
    const result = computeVisaReadiness(fullyReadyProfile(), FULL_DOCS, NOW);

    expect(result.readyCount).toBe(6);
    expect(result.total).toBe(6);
    expect(result.percent).toBe(100);
    expect(result.items.every((i) => i.ready)).toBe(true);
    expect(result.items.map((i) => i.key)).toEqual([
      "passport",
      "passportValidity",
      "photograph",
      "personalDetails",
      "travelHistory",
      "bankStatement",
    ]);
  });

  it("scores 0/6 at 0% for an empty profile with an empty locker", () => {
    const result = computeVisaReadiness(
      { personal: {}, passports: [], contact: {}, travel: {}, coTravellers: [] } as any,
      [],
      NOW,
    );

    expect(result.readyCount).toBe(0);
    expect(result.percent).toBe(0);
    expect(result.items.every((i) => !i.ready)).toBe(true);
  });

  it("returns 0/6 — not a crash — for a profile with nothing on it at all", () => {
    // Every array path on ConsumerProfile defaults to [], but a partially
    // projected document (or a `.select()` that omitted a section) reaches
    // this function with the keys simply absent. Reporting zero is the
    // honest answer; throwing would take the whole profile response down.
    const result = computeVisaReadiness({} as any, [], NOW);
    expect(result.readyCount).toBe(0);
    expect(result.percent).toBe(0);
  });
});

describe("computeVisaReadiness — passport and its validity are two facts", () => {
  it("PASSPORT passes but VALIDITY fails when the passport expires inside six months", () => {
    // THE PARTIAL CASE. A held, usable, unexpired passport that no mission
    // will accept — the exact state a readiness gauge exists to surface,
    // and the one a profile-completion percentage cannot see at all.
    const profile = fullyReadyProfile();
    profile.passports[0].expiryDate = daysFromNow(120);

    const result = computeVisaReadiness(profile, FULL_DOCS, NOW);

    expect(ready(result, "passport")).toBe(true);
    expect(ready(result, "passportValidity")).toBe(false);
    expect(result.readyCount).toBe(5);
    expect(result.percent).toBe(83);
  });

  it("fails BOTH for an already-expired passport", () => {
    const profile = fullyReadyProfile();
    profile.passports[0].expiryDate = daysFromNow(-30);

    const result = computeVisaReadiness(profile, FULL_DOCS, NOW);

    // `passport` still passes — the row IS usable data (number + a real
    // date). It is validity that fails, and it fails without a dedicated
    // "expired" branch: a negative delta simply never clears the window.
    expect(ready(result, "passport")).toBe(true);
    expect(ready(result, "passportValidity")).toBe(false);
  });

  it("holds the six-month boundary exactly — 183 days is ready, one day less is not", () => {
    const onTheLine = fullyReadyProfile();
    onTheLine.passports[0].expiryDate = new Date(NOW.getTime() + PASSPORT_VALIDITY_WINDOW_MS);
    expect(ready(computeVisaReadiness(onTheLine, FULL_DOCS, NOW), "passportValidity")).toBe(true);

    const justInside = fullyReadyProfile();
    justInside.passports[0].expiryDate = new Date(
      NOW.getTime() + PASSPORT_VALIDITY_WINDOW_MS - DAY_MS,
    );
    expect(ready(computeVisaReadiness(justInside, FULL_DOCS, NOW), "passportValidity")).toBe(false);
  });

  it("fails PASSPORT for a row with an expiry but no number", () => {
    const profile = fullyReadyProfile();
    profile.passports[0].number = "   ";

    const result = computeVisaReadiness(profile, FULL_DOCS, NOW);
    expect(ready(result, "passport")).toBe(false);
    expect(ready(result, "passportValidity")).toBe(false);
  });

  it("fails PASSPORT for a row with a number but an unparseable expiry", () => {
    const profile = fullyReadyProfile();
    profile.passports[0].expiryDate = "not-a-date";

    const result = computeVisaReadiness(profile, FULL_DOCS, NOW);
    expect(ready(result, "passport")).toBe(false);
    expect(ready(result, "passportValidity")).toBe(false);
  });

  it("takes validity from ANY held passport, not just the primary one", () => {
    // A consumer who renewed but never re-flagged the primary is ready to
    // travel. Failing them on a data-entry detail would be the gauge
    // reporting the wrong thing with total confidence.
    const profile = fullyReadyProfile();
    profile.passports = [
      { number: "OLD11111", expiryDate: daysFromNow(20), isPrimary: true },
      { number: "NEW22222", expiryDate: daysFromNow(900), isPrimary: false },
    ];

    expect(ready(computeVisaReadiness(profile, FULL_DOCS, NOW), "passportValidity")).toBe(true);
  });
});

describe("computeVisaReadiness — the locker items", () => {
  it("reads PHOTO and BANK_STATEMENT independently", () => {
    const profile = fullyReadyProfile();

    const photoOnly = computeVisaReadiness(profile, [{ docCode: "PHOTO" }], NOW);
    expect(ready(photoOnly, "photograph")).toBe(true);
    expect(ready(photoOnly, "bankStatement")).toBe(false);

    const bankOnly = computeVisaReadiness(profile, [{ docCode: "BANK_STATEMENT" }], NOW);
    expect(ready(bankOnly, "photograph")).toBe(false);
    expect(ready(bankOnly, "bankStatement")).toBe(true);
  });

  it("normalises case and whitespace on a stored code", () => {
    const result = computeVisaReadiness(
      fullyReadyProfile(),
      [{ docCode: " photo " }, { docCode: "bank_statement" }],
      NOW,
    );
    expect(ready(result, "photograph")).toBe(true);
    expect(ready(result, "bankStatement")).toBe(true);
  });

  it("ignores locker rows with no docCode — an uncoded upload satisfies nothing", () => {
    // The Documents tab uploads into a CATEGORY with no requirement in
    // mind and sends no docCode. Those files are real, but they are not
    // evidence of a photograph, and readiness must not treat them as such.
    const result = computeVisaReadiness(
      fullyReadyProfile(),
      [{ docCode: null }, { docCode: "" }, {}],
      NOW,
    );
    expect(ready(result, "photograph")).toBe(false);
    expect(ready(result, "bankStatement")).toBe(false);
  });

  it("does not accept the OPS catalogue's codes for the locker's", () => {
    // PHOTOGRAPH / APPLICANT_BANK_STATEMENT are the ops taxonomy. If this
    // ever starts passing, someone has pointed readiness at the wrong
    // vocabulary and every consumer will silently gain two items.
    const result = computeVisaReadiness(
      fullyReadyProfile(),
      [{ docCode: "PHOTOGRAPH" }, { docCode: "APPLICANT_BANK_STATEMENT" }],
      NOW,
    );
    expect(ready(result, "photograph")).toBe(false);
    expect(ready(result, "bankStatement")).toBe(false);
  });
});

describe("computeVisaReadiness — travel history", () => {
  it("needs at least one recorded trip", () => {
    const empty = fullyReadyProfile();
    empty.travel = { travelHistory: [] };
    expect(ready(computeVisaReadiness(empty, FULL_DOCS, NOW), "travelHistory")).toBe(false);

    const absent = fullyReadyProfile();
    absent.travel = {};
    expect(ready(computeVisaReadiness(absent, FULL_DOCS, NOW), "travelHistory")).toBe(false);
  });
});

describe("computeVisaReadiness — personal details, delegated to completion", () => {
  it("mirrors the completion tab rather than keeping its own field list", () => {
    const profile = fullyReadyProfile();
    delete profile.personal.nationality;

    const readiness = computeVisaReadiness(profile, FULL_DOCS, NOW);
    const completion = computeProfileCompletion(profile, FULL_DOCS.length);
    const personalTab = completion.tabs.find((t) => t.key === READINESS_PERSONAL_TAB_KEY);

    // THE LINKAGE ASSERTION. If the completion tab is renamed or removed,
    // this fails HERE — rather than readiness silently pinning the item to
    // false for every consumer forever.
    expect(personalTab).toBeDefined();
    expect(ready(readiness, "personalDetails")).toBe(personalTab!.complete);
    expect(ready(readiness, "personalDetails")).toBe(false);
  });
});

describe("readiness is NOT completion", () => {
  it("scores the SAME profile differently — the reason both are sent", () => {
    // Co-travellers and one uncoded document satisfy two COMPLETION tabs.
    // Neither is evidence a mission would accept, so readiness is lower.
    const profile = fullyReadyProfile();
    profile.contact = {
      mobile: "+91 98200 00000",
      currentAddress: { line1: "1 Marine Drive", city: "Mumbai", country: "India" },
    };
    profile.travel.occupation = "Designer";
    profile.travel.employmentType = "SALARIED";
    profile.travel.hasPriorVisaRefusal = false;
    profile.coTravellers = [{ fullName: "R Rao" }];

    const uncodedLocker = [{ docCode: null }];

    const completion = computeProfileCompletion(profile, uncodedLocker.length);
    const readiness = computeVisaReadiness(profile, uncodedLocker, NOW);

    // Every completion tab satisfied...
    expect(completion.percent).toBe(100);
    // ...and still not ready: no photograph, no bank statement on file.
    expect(readiness.percent).toBe(67);
    expect(readiness.readyCount).toBe(4);
    expect(ready(readiness, "photograph")).toBe(false);
    expect(ready(readiness, "bankStatement")).toBe(false);
  });
});
