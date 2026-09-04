// apps/backend/src/routes/consumer.applicationListCounts.test.ts
//
// THE HALF OF THE REJECTION FIX THAT WAS LEFT ON THE FLOOR.
//
// consumer.applicationChecklist.test.ts pins the DETAIL route: a rejected
// document is not an attached one, joined on the stored object rather
// than on docCode. That fix landed on the detail route only.
//
// The LIST route counts the same thing for its "still needs N documents"
// pill, and it counted straight off ConsumerDocument — a collection with
// no review fields at all. So a refused file went on counting as
// attached, and the card said "still needs 1 document" while the page it
// opened said 2. The list route's own header promises those two can
// never disagree; it was the only read path that could break the promise.
//
// satisfiedDocCode() is the rule, extracted so both halves of it are
// testable without a database, and so a future edit to one read path has
// a failing test rather than a silent divergence.
import { describe, it, expect } from "vitest";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.CONSUMER_JWT_SECRET ||= "consumer-test-secret";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/list-counts-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { satisfiedDocCode } = await import("./consumer.applications.js");

/** A consumer locker row, as the LIST route now projects it. */
function locker(docCode: string, storageKey: string) {
  return { docCode, storageKey };
}

/** The rejection index the route builds off one batched $in query. */
function rejected(...pairs: Array<[applicationId: string, s3Key: string]>) {
  return new Set(pairs.map(([a, k]) => `${a}|${k}`));
}

const APP = "app-1";

describe("satisfiedDocCode — a rejected file does not satisfy a requirement", () => {
  it("an attached, un-reviewed file satisfies", () => {
    expect(satisfiedDocCode(APP, locker("PASSPORT_ORIGINAL", "key-1"), rejected())).toBe(true);
  });

  it("no file at all does not satisfy", () => {
    expect(satisfiedDocCode(APP, undefined, rejected())).toBe(false);
  });

  it("THE BUG: a REJECTED file no longer counts as attached", () => {
    // This is the whole of it. Before the join, the list saw a
    // ConsumerDocument row and stopped — the requirement read as met and
    // the "still needs N" pill under-counted by exactly the number of
    // documents ops had refused.
    expect(satisfiedDocCode(APP, locker("PASSPORT_ORIGINAL", "key-1"), rejected([APP, "key-1"]))).toBe(
      false,
    );
  });
});

describe("satisfiedDocCode — the join is per FILE and per CASE", () => {
  it("a rejection on a DIFFERENT file leaves this one satisfied", () => {
    /* The docCode-keyed join this replaces would have failed here: 103 of
     * 259 published corridors repeat a docTypeCode across groups, so a
     * code join smears one rejection over every requirement sharing the
     * code — and on a COUNTING surface that inflates the figure rather
     * than merely mislabelling a row. */
    expect(
      satisfiedDocCode(APP, locker("PASSPORT_ORIGINAL", "key-1"), rejected([APP, "key-2"])),
    ).toBe(true);
  });

  it("a rejection on ANOTHER application does not fail this one", () => {
    /* A locker document can be linked to two applications and refused on
     * only one of them — different corridor, different concierge,
     * different call. Keying the index on the file alone would fail the
     * innocent case for the guilty one's rejection, which is why the key
     * is `${applicationId}|${s3Key}` and not `${s3Key}`. */
    expect(
      satisfiedDocCode(APP, locker("PASSPORT_ORIGINAL", "key-1"), rejected(["app-2", "key-1"])),
    ).toBe(true);
    // ...and the other case genuinely does fail.
    expect(
      satisfiedDocCode("app-2", locker("PASSPORT_ORIGINAL", "key-1"), rejected(["app-2", "key-1"])),
    ).toBe(false);
  });

  it("an unjoinable row is not assumed refused", () => {
    /* A locker row with no storageKey has nothing to match a mirror on.
     * The document IS present; what is missing is the join, and treating
     * a missing join as a rejection would invent an outstanding
     * requirement out of an absent field. */
    expect(satisfiedDocCode(APP, { docCode: "PASSPORT_ORIGINAL" }, rejected([APP, "key-1"]))).toBe(
      true,
    );
  });
});

describe("the outstanding COUNT, end to end", () => {
  /* The route's own arithmetic, reproduced over the extracted rule so the
   * number the pill renders is pinned and not just the predicate. */
  function outstanding(
    required: string[],
    docs: Array<{ docCode: string; storageKey: string }>,
    rejectedSet: Set<string>,
  ) {
    const byCode = new Map<string, any>();
    for (const d of docs) {
      const code = d.docCode.toUpperCase();
      if (!byCode.has(code)) byCode.set(code, d);
    }
    return required.filter((c) => !satisfiedDocCode(APP, byCode.get(c), rejectedSet)).length;
  }

  const REQUIRED = ["PASSPORT_ORIGINAL", "PHOTOGRAPH", "BANK_STATEMENT"];

  it("counts a missing document, as it always did", () => {
    expect(
      outstanding(
        REQUIRED,
        [locker("PASSPORT_ORIGINAL", "key-1"), locker("PHOTOGRAPH", "key-2")],
        rejected(),
      ),
    ).toBe(1);
  });

  it("THE UNDER-COUNT: a rejection now moves the number", () => {
    // All three uploaded, one refused. The old count said 0 ("nothing to
    // do") on a case whose detail page was showing a rejection notice.
    const docs = [
      locker("PASSPORT_ORIGINAL", "key-1"),
      locker("PHOTOGRAPH", "key-2"),
      locker("BANK_STATEMENT", "key-3"),
    ];
    expect(outstanding(REQUIRED, docs, rejected())).toBe(0);
    expect(outstanding(REQUIRED, docs, rejected([APP, "key-2"]))).toBe(1);
    expect(outstanding(REQUIRED, docs, rejected([APP, "key-2"], [APP, "key-3"]))).toBe(2);
  });

  it("a missing document and a rejected one both count, and count once each", () => {
    expect(
      outstanding(
        REQUIRED,
        [locker("PASSPORT_ORIGINAL", "key-1"), locker("PHOTOGRAPH", "key-2")],
        rejected([APP, "key-1"]),
      ),
    ).toBe(2);
  });
});
