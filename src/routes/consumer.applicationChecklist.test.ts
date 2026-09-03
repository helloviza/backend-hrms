// apps/backend/src/routes/consumer.applicationChecklist.test.ts
//
// THE REJECTION-VISIBILITY FIX, pinned.
//
// Reported symptom: ops rejects a document in the admin console and the
// customer's application page shows nothing — no status change, no reason,
// and the refused document still carrying a green "✓ Attached".
//
// Cause: the rejection is written on the VisaDocument MIRROR
// (reviewStatus / rejectionReason), while this read path loaded only the
// consumer's ConsumerDocument locker row — a collection with no review
// fields at all. `attached: Boolean(doc)` therefore stayed true forever.
//
// Two properties are asserted here because both are cheap to regress:
//
//   1. THE JOIN IS ON THE STORED OBJECT, not on docCode. 103 of 259
//      published corridors repeat a docTypeCode across groups; a
//      code-keyed join would paint one rejection across every row sharing
//      that code. The mirror's `s3Key` IS the locker row's `storageKey` —
//      one file, one row each side.
//   2. A REJECTED DOCUMENT IS NOT ATTACHED. The requirement is
//      outstanding again, and the row has to say so.
import { describe, it, expect } from "vitest";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.CONSUMER_JWT_SECRET ||= "consumer-test-secret";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/checklist-rows-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { checklistRows } = await import("./consumer.applications.js");

/** A corridor whose checklist is frozen on the application at submit. */
function application(groups: Array<{ key: string; label: string; docTypeCodes: string[] }>) {
  return { ruleSnapshot: { documentGroups: groups.map((g) => ({ ...g, requirement: "REQUIRED" })) } };
}

/** A consumer locker row, as the read path selects it. */
function locker(docCode: string, storageKey: string, filename = `${storageKey}.pdf`) {
  return { docCode, storageKey, originalFilename: filename, label: null };
}

/** The ops mirror row for the same stored object. */
function mirror(id: string, docCode: string, s3Key: string, reviewStatus: string, rejectionReason?: string) {
  return { _id: id, docCode, s3Key, reviewStatus, rejectionReason: rejectionReason ?? undefined };
}

const PASSPORT_ONLY = application([
  { key: "g-passport", label: "Passport", docTypeCodes: ["PASSPORT_ORIGINAL"] },
]);

/* Armenia as actually stored — the photo group carries the passport code,
 * so BOTH rows resolve to the same locker file. This is the corridor a
 * docCode-keyed rejection join would smear across. */
const DUPLICATE_CODE = application([
  { key: "g-passport", label: "Passport", docTypeCodes: ["PASSPORT_ORIGINAL"] },
  { key: "g-photo", label: "Photograph", docTypeCodes: ["PASSPORT_ORIGINAL"] },
]);

describe("a rejected document is no longer reported as satisfied", () => {
  it("marks it rejected, not attached, and carries the reason", () => {
    const rows = checklistRows(
      PASSPORT_ONLY,
      [locker("PASSPORT_ORIGINAL", "key-1")],
      [mirror("vd-1", "PASSPORT_ORIGINAL", "key-1", "REJECTED", "Photo page is blurry")],
    );

    const doc = rows[0].docs[0];
    expect(doc.reviewStatus).toBe("REJECTED");
    expect(doc.attached).toBe(false); // the bug: this used to be true
    expect(doc.rejectionReason).toBe("Photo page is blurry");
    expect(doc.reviewDocumentId).toBe("vd-1");
  });

  it("a VERIFIED document stays attached and carries no reason", () => {
    const rows = checklistRows(
      PASSPORT_ONLY,
      [locker("PASSPORT_ORIGINAL", "key-1")],
      [mirror("vd-1", "PASSPORT_ORIGINAL", "key-1", "VERIFIED")],
    );
    const doc = rows[0].docs[0];
    expect(doc.attached).toBe(true);
    expect(doc.reviewStatus).toBe("VERIFIED");
    expect(doc.rejectionReason).toBeNull();
  });

  it("PENDING is attached but is not silently 'fine' — the status travels", () => {
    const rows = checklistRows(
      PASSPORT_ONLY,
      [locker("PASSPORT_ORIGINAL", "key-1")],
      [mirror("vd-1", "PASSPORT_ORIGINAL", "key-1", "PENDING")],
    );
    expect(rows[0].docs[0].attached).toBe(true);
    expect(rows[0].docs[0].reviewStatus).toBe("PENDING");
  });

  it("no mirror row yet (pre-submit) reads as attached with a null status", () => {
    const rows = checklistRows(PASSPORT_ONLY, [locker("PASSPORT_ORIGINAL", "key-1")], []);
    expect(rows[0].docs[0].attached).toBe(true);
    expect(rows[0].docs[0].reviewStatus).toBeNull();
  });

  it("a requirement with nothing uploaded is untouched by any of this", () => {
    const rows = checklistRows(PASSPORT_ONLY, [], [mirror("vd-1", "PASSPORT_ORIGINAL", "key-1", "REJECTED", "x")]);
    const doc = rows[0].docs[0];
    expect(doc.attached).toBe(false);
    expect(doc.reviewStatus).toBeNull(); // no file on the row, nothing to review
    expect(doc.rejectionReason).toBeNull();
  });
});

describe("the join survives a corridor that repeats a docCode", () => {
  it("shows the rejection on the row holding that FILE, not on every row sharing the code", () => {
    /* Two DIFFERENT files, both legitimately carrying PASSPORT_ORIGINAL
     * because the corridor's data is wrong. Ops rejected only the second.
     *
     * byCode keeps the first locker row per code, so both requirement rows
     * resolve to file key-1 — and key-1 was NOT rejected. A docCode-keyed
     * join would have found the key-2 rejection by code and reported both
     * rows as refused. */
    const rows = checklistRows(
      DUPLICATE_CODE,
      [locker("PASSPORT_ORIGINAL", "key-1"), locker("PASSPORT_ORIGINAL", "key-2")],
      [mirror("vd-2", "PASSPORT_ORIGINAL", "key-2", "REJECTED", "Wrong document")],
    );

    for (const g of rows) {
      for (const d of g.docs) {
        expect(d.reviewStatus).toBeNull();
        expect(d.attached).toBe(true);
      }
    }
  });

  it("and when the SHOWN file is the rejected one, every row showing it says so", () => {
    /* The mirror of failure: here the rejected file IS the one both rows
     * resolve to. Both must report it — anything else would show a tick
     * against a refused file. The duplicate-code data defect is repaired
     * separately; this asserts the join reports the truth about the file
     * it is actually displaying. */
    const rows = checklistRows(
      DUPLICATE_CODE,
      [locker("PASSPORT_ORIGINAL", "key-1")],
      [mirror("vd-1", "PASSPORT_ORIGINAL", "key-1", "REJECTED", "Blurry")],
    );

    for (const g of rows) {
      expect(g.docs[0].reviewStatus).toBe("REJECTED");
      expect(g.docs[0].attached).toBe(false);
    }
  });

  it("a mirror row whose file is not on this checklist is ignored", () => {
    const rows = checklistRows(
      PASSPORT_ONLY,
      [locker("PASSPORT_ORIGINAL", "key-1")],
      [mirror("vd-9", "BANK_STATEMENT", "key-other", "REJECTED", "not this one")],
    );
    expect(rows[0].docs[0].reviewStatus).toBeNull();
    expect(rows[0].docs[0].attached).toBe(true);
  });
});
