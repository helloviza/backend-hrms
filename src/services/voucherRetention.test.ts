// The retention planner: what a run at `now` deletes, rule by rule.
import { describe, it, expect } from "vitest";
import { planRecord, planRules, TRIP_DATE_UNKNOWN_WARNING, voucherTripEnd } from "./voucherRetention.js";

const H = 3_600_000;
const D = 24 * H;
const UPLOAD = new Date("2026-09-01T10:00:00Z");
const at = (ms: number) => new Date(UPLOAD.getTime() + ms);

function hotel(over: Record<string, any> = {}) {
  return {
    _id: "6a0000000000000000000001",
    status: "SUCCESS",
    docType: "hotel",
    workspaceId: "69679a7628330a58d29f2254",
    createdAt: UPLOAD,
    s3: { bucket: "b", key: "hrms/vouchers/c/u/src.pdf" },
    renderedS3: { bucket: "b", key: "hrms/vouchers/c/u/pdf.pdf" },
    rawModelResponse: { raw_candidate: { policies: { is_non_refundable: true } } },
    extractedJson: {
      booking_info: { booking_date: "2026-09-01" },
      stay_details: { check_in_date: "2026-09-10", check_out_date: "2026-09-12" },
      guest_details: { primary_guest: "Asha Rao" },
      policies: { is_non_refundable: true, important_notes: [] },
    },
    ...over,
  };
}

describe("rule 1 — raw model response and error details", () => {
  it("SUCCESS: kept for 48h after upload, purged after", () => {
    expect(planRecord(hotel(), at(47 * H))).toBeNull();
    const p = planRecord(hotel(), at(49 * H))!;
    expect(p.purgeRaw).toEqual({ keepStage: null });
    expect(planRules(p)).toEqual(["raw"]);
  });

  it("FAILED: kept 30 days for debugging", () => {
    const failed = hotel({ status: "FAILED", extractedJson: undefined, renderedS3: undefined, errorDetails: { stage: "VALIDATE", debugStages: {} } });
    expect(planRecord(failed, at(29 * D))?.purgeRaw ?? null).toBeNull();
    expect(planRecord(failed, at(31 * D))!.purgeRaw).toEqual({ keepStage: "VALIDATE" });
  });

  it("keeps only errorDetails.stage (the Needs-review render-failed reason reads it)", () => {
    const p = planRecord(hotel({ errorDetails: { stage: "RENDER_PDF_FAILED", message: "x", debugStages: { gemini: { rawSnippet: "PII" } } } }), at(3 * D))!;
    expect(p.purgeRaw!.keepStage).toBe("RENDER_PDF_FAILED");
    // already slim and no raw left → nothing more to purge
    expect(planRecord(hotel({ rawModelResponse: undefined, errorDetails: { stage: "RENDER_PDF_FAILED" } }), at(3 * D))).toBeNull();
  });

  it("an older record whose collapsed false really meant 'not stated' is frozen to null before the raw text goes", () => {
    const old = hotel({
      rawModelResponse: { raw_candidate: { policies: { is_non_refundable: null } } },
      extractedJson: { ...hotel().extractedJson, policies: { is_non_refundable: false, important_notes: [] } },
    });
    expect(planRecord(old, at(3 * D))!.purgeRaw).toEqual({ keepStage: null, refundability: null });
    // a stated value already in the JSON needs no freeze
    expect(planRecord(hotel(), at(3 * D))!.purgeRaw!.refundability).toBeUndefined();
  });
});

describe("rule 2 — source file and rendered PDF", () => {
  it("hotel: due 7 days after the check-out day ends", () => {
    const r = hotel({ rawModelResponse: undefined });
    expect(voucherTripEnd(r)!.toISOString().slice(0, 10)).toBe("2026-09-12");
    expect(planRecord(r, new Date("2026-09-19T23:59:00Z"))).toBeNull();
    const p = planRecord(r, new Date("2026-09-20T00:00:00Z"))!;
    expect(p.deleteSource?.key).toBe("hrms/vouchers/c/u/src.pdf");
    expect(p.deleteRender?.key).toBe("hrms/vouchers/c/u/pdf.pdf");
  });

  it("flight: the trip ends with the last leg's arrival", () => {
    const f = hotel({
      docType: "flight",
      rawModelResponse: undefined,
      extractedJson: {
        booking_info: { booking_date: "2026-09-01" },
        passengers: [{ name: "Mr A" }],
        flight_details: {
          segments: [
            { origin: { date: "2026-09-10" }, destination: { date: "2026-09-10" } },
            { origin: { date: "2026-09-14" }, destination: { date: "15 Sep" } },
          ],
        },
        policies: {},
      },
    });
    expect(voucherTripEnd(f)!.toISOString().slice(0, 10)).toBe("2026-09-15");
    expect(planRecord(f, new Date("2026-09-22T12:00:00Z"))).toBeNull();
    expect(planRecord(f, new Date("2026-09-23T00:00:00Z"))!.deleteSource).not.toBeNull();
  });

  it("no readable trip date: files are never deleted on a guess — kept and flagged for review", () => {
    const r = hotel({ rawModelResponse: undefined, extractedJson: { policies: {} } });
    expect(voucherTripEnd(r)).toBeNull();
    const p = planRecord(r, at(200 * D))!;
    expect(p.filesDueAt).toBeNull();
    expect(p.deleteSource).toBeNull();
    expect(p.deleteRender).toBeNull();
    expect(p.flagTripUnknown).toBe(true);
    expect(planRules(p)).toEqual(["flag"]);
    // already flagged → nothing to do; the 12-month rule still applies
    const flagged = { ...r, meta: { renderWarnings: [TRIP_DATE_UNKNOWN_WARNING] } };
    expect(planRecord(flagged, at(200 * D))).toBeNull();
    expect(planRecord(flagged, new Date("2027-09-01T10:00:00Z"))!.deleteRecord).not.toBeNull();
  });

  it("a FAILED record (no extraction, no trip date) keeps its source and isn't flagged — it is in Needs review already", () => {
    const failed = hotel({ status: "FAILED", extractedJson: undefined, renderedS3: undefined, rawModelResponse: undefined });
    expect(planRecord(failed, at(200 * D))).toBeNull();
  });

  it("a deleted source is not deleted twice; a PDF regenerated afterwards is deleted again", () => {
    const r = hotel({ rawModelResponse: undefined, sourceDeletedAt: new Date("2026-09-20"), renderDeletedAt: new Date("2026-09-20") });
    const p = planRecord(r, new Date("2026-10-01"))!;
    expect(p.deleteSource).toBeNull();
    expect(p.deleteRender?.key).toBe("hrms/vouchers/c/u/pdf.pdf");
    expect(planRecord({ ...r, renderedS3: undefined }, new Date("2026-10-01"))).toBeNull();
  });
});

describe("rule 3 — superseded PDFs", () => {
  it("deleted in every run, whatever the record's age; deleted ones are skipped", () => {
    const r = hotel({
      rawModelResponse: undefined,
      supersededRenders: [
        { bucket: "b", key: "old1.pdf", supersededAt: UPLOAD },
        { bucket: "b", key: "old0.pdf", supersededAt: UPLOAD, deletedAt: UPLOAD },
      ],
    });
    const p = planRecord(r, at(H))!;
    expect(p.deleteSuperseded.map((s) => s.key)).toEqual(["old1.pdf"]);
    expect(planRules(p)).toEqual(["superseded"]);
  });
});

describe("rule 4 — the whole record", () => {
  it("12 months after upload: the record and every file it points to, nothing else planned", () => {
    const r = hotel({ supersededRenders: [{ bucket: "b", key: "old1.pdf", supersededAt: UPLOAD }] });
    expect(planRecord(r, new Date("2027-09-01T09:59:00Z"))!.deleteRecord).toBeNull();
    const p = planRecord(r, new Date("2027-09-01T10:00:00Z"))!;
    expect(p.deleteRecord!.files.map((f) => f.key)).toEqual(["hrms/vouchers/c/u/src.pdf", "hrms/vouchers/c/u/pdf.pdf", "old1.pdf"]);
    expect(planRules(p)).toEqual(["record"]);
    expect(p.purgeRaw).toBeNull();
  });
});

describe("PROCESSING", () => {
  it("is never touched by any rule", () => {
    expect(planRecord(hotel({ status: "PROCESSING" }), new Date("2028-01-01"))).toBeNull();
  });
});
