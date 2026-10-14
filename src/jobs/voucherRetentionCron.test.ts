// The daily retention run against a real (in-memory) Mongo, S3 stubbed: what
// gets deleted, what gets stamped, and that nothing happens while disabled.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const deleted: string[] = [];
const failKeys = new Set<string>();
vi.mock("../utils/s3Upload.js", () => ({
  deleteAllObjectVersions: async (key: string) => {
    if (failKeys.has(key)) throw new Error("AccessDenied");
    deleted.push(key);
  },
}));

const { runVoucherRetention } = await import("./voucherRetentionCron.js");
const { default: VoucherExtraction } = await import("../models/VoucherExtraction.js");

let mongod: MongoMemoryServer;
const WS = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const UPLOAD = new Date("2026-09-01T10:00:00Z");

function make(over: Record<string, any> = {}) {
  return VoucherExtraction.create({
    workspaceId: WS,
    createdBy: USER,
    s3: { bucket: "b", key: `src-${new mongoose.Types.ObjectId()}.pdf`, url: "u" },
    file: { originalName: "v.pdf", mime: "application/pdf", size: 10 },
    docType: "hotel",
    status: "SUCCESS",
    renderedS3: { bucket: "b", key: `pdf-${new mongoose.Types.ObjectId()}.pdf`, url: "u" },
    rawModelResponse: { raw_candidate: { policies: { is_non_refundable: null } }, raw_text: "Asha Rao, passport …" },
    errorDetails: { stage: "RENDER_PDF_FAILED", debugStages: { gemini: { rawSnippet: "PII" } } },
    extractedJson: {
      booking_info: { booking_date: "2026-09-01" },
      stay_details: { check_in_date: "2026-09-10", check_out_date: "2026-09-12" },
      guest_details: { primary_guest: "Asha Rao" },
      policies: { is_non_refundable: false, important_notes: [] },
    },
    ...over,
  });
}
const raw = async (id: any) => (await mongoose.connection.db!.collection("voucherextractions").findOne({ _id: id })) as any;
// createdAt is set by timestamps on create; back-date it directly.
const backdate = (id: any, d: Date) => mongoose.connection.db!.collection("voucherextractions").updateOne({ _id: id }, { $set: { createdAt: d } });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("voucher-retention-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  deleted.length = 0;
  failKeys.clear();
  process.env.VOUCHER_RETENTION_ENABLED = "true";
});

describe("runVoucherRetention", () => {
  it("disabled (the shipped default): scans nothing, deletes nothing", async () => {
    delete process.env.VOUCHER_RETENTION_ENABLED;
    const r = await make();
    await backdate(r._id, new Date("2020-01-01"));
    const sum = await runVoucherRetention(new Date("2026-12-01"));
    expect(sum).toMatchObject({ enabled: false, scanned: 0 });
    expect(deleted).toEqual([]);
    expect(await raw(r._id)).not.toBeNull();
  });

  it("raw purge: errorDetails slimmed to its stage, refundability frozen, stamp set", async () => {
    const r = await make({ renderedS3: undefined });
    await backdate(r._id, UPLOAD);
    const now = new Date("2026-09-04T00:00:00Z");
    await runVoucherRetention(now);
    const row = await raw(r._id);
    expect(row.rawModelResponse).toBeUndefined();
    expect(row.errorDetails).toEqual({ stage: "RENDER_PDF_FAILED" });
    expect(row.extractedJson.policies.is_non_refundable).toBeNull(); // the raw said "not stated"
    expect(row.rawPurgedAt).toEqual(now);
    expect(row.sourceDeletedAt).toBeUndefined();
    expect(deleted).toEqual([]);
  });

  it("files after the trip: source + PDF deleted, renderedS3 cleared, s3 pointer kept, stamps set", async () => {
    const r = await make();
    await backdate(r._id, UPLOAD);
    const now = new Date("2026-09-25T00:00:00Z");
    const sum = await runVoucherRetention(now);
    const row = await raw(r._id);
    expect(deleted.sort()).toEqual([r.s3.key, r.renderedS3!.key].sort());
    expect(row.sourceDeletedAt).toEqual(now);
    expect(row.renderDeletedAt).toEqual(now);
    expect(row.renderedS3).toBeUndefined();
    expect(row.s3.key).toBe(r.s3.key);
    expect(sum).toMatchObject({ sourcesDeleted: 1, rendersDeleted: 1, rawPurged: 1, s3Failures: 0 });

    // a second run finds nothing more to delete
    deleted.length = 0;
    await runVoucherRetention(new Date("2026-09-26T00:00:00Z"));
    expect(deleted).toEqual([]);
  });

  it("an S3 failure leaves that file unstamped for the next run", async () => {
    const r = await make();
    await backdate(r._id, UPLOAD);
    failKeys.add(r.s3.key);
    const sum = await runVoucherRetention(new Date("2026-09-25T00:00:00Z"));
    const row = await raw(r._id);
    expect(row.sourceDeletedAt).toBeUndefined();
    expect(row.renderDeletedAt).toBeDefined();
    expect(sum.s3Failures).toBe(1);
  });

  it("superseded PDFs are deleted and marked, the current one is kept", async () => {
    // Uploaded just now for a stay that hasn't happened yet: only rule 3 is due.
    const r = await make({
      supersededRenders: [{ bucket: "b", key: "old-1.pdf", supersededAt: UPLOAD }],
      extractedJson: {
        booking_info: { booking_date: "2026-09-01" },
        stay_details: { check_in_date: "2099-01-10", check_out_date: "2099-01-12" },
        policies: { is_non_refundable: false, important_notes: [] },
      },
    });
    await runVoucherRetention(new Date(Date.now() + 60_000));
    const row = await raw(r._id);
    expect(deleted).toEqual(["old-1.pdf"]);
    expect(row.supersededRenders[0].deletedAt).toBeInstanceOf(Date);
    expect(row.renderedS3.key).toBe(r.renderedS3!.key);
  });

  it("12 months: the record and all its files go; a record PROCESSING at the start of the run is timed out but not deleted in that run", async () => {
    const old = await make({ supersededRenders: [{ bucket: "b", key: "old-2.pdf", supersededAt: UPLOAD }] });
    const stuck = await make({ status: "PROCESSING" });
    await backdate(old._id, new Date("2025-09-01T00:00:00Z"));
    await backdate(stuck._id, new Date("2025-09-01T00:00:00Z"));
    const sum = await runVoucherRetention(new Date("2026-09-02T00:00:00Z"));
    expect(await raw(old._id)).toBeNull();
    expect(deleted.sort()).toEqual([old.s3.key, old.renderedS3!.key, "old-2.pdf"].sort());
    const s = await raw(stuck._id);
    expect(s.status).toBe("FAILED"); // F-05 timed it out…
    expect(s.rawModelResponse).toBeDefined(); // …and retention left it for the next run
    expect(s.sourceDeletedAt).toBeUndefined();
    expect(sum).toMatchObject({ recordsDeleted: 1, timedOut: 1 });
  });

  it("a record whose files can't all be deleted is kept for the next run", async () => {
    const old = await make();
    await backdate(old._id, new Date("2025-09-01T00:00:00Z"));
    failKeys.add(old.renderedS3!.key);
    await runVoucherRetention(new Date("2026-09-02T00:00:00Z"));
    expect(await raw(old._id)).not.toBeNull();
  });
});

describe("stuck PROCESSING (F-05)", () => {
  it("runs even with retention disabled: 15+ minutes → FAILED 'Timed out'; a fresh one is left alone", async () => {
    delete process.env.VOUCHER_RETENTION_ENABLED;
    const now = new Date("2026-10-15T10:00:00Z");
    const stuck = await make({ status: "PROCESSING", renderedS3: undefined, extractedJson: undefined });
    const fresh = await make({ status: "PROCESSING", renderedS3: undefined, extractedJson: undefined });
    await backdate(stuck._id, new Date(now.getTime() - 16 * 60_000));
    await backdate(fresh._id, new Date(now.getTime() - 14 * 60_000));
    const sum = await runVoucherRetention(now);
    expect(sum).toMatchObject({ timedOut: 1, enabled: false, scanned: 0 });
    const s = await raw(stuck._id);
    expect(s).toMatchObject({ status: "FAILED", error: "Timed out", errorDetails: { stage: "TIMED_OUT" } });
    expect(s.timedOutAt).toEqual(now);
    expect((await raw(fresh._id)).status).toBe("PROCESSING");
    expect(deleted).toEqual([]);
  });
});

describe("no trip date (retention fix 3)", () => {
  it("files are kept and the record is flagged once, into Needs review", async () => {
    const r = await make({ extractedJson: { booking_info: {}, policies: { important_notes: [] } }, rawModelResponse: undefined, errorDetails: undefined });
    await backdate(r._id, new Date("2026-01-01T00:00:00Z"));
    const sum = await runVoucherRetention(new Date("2026-09-02T00:00:00Z"));
    expect(sum.flaggedTripUnknown).toBe(1);
    expect(deleted).toEqual([]);
    const row = await raw(r._id);
    expect(row.meta.renderWarnings).toEqual(["Trip date unknown — files kept until reviewed"]);
    expect(row.sourceDeletedAt).toBeUndefined();
    await runVoucherRetention(new Date("2026-09-03T00:00:00Z"));
    expect((await raw(r._id)).meta.renderWarnings).toHaveLength(1);
  });
});

describe("F-05 sweep under concurrency", () => {
  it("two runs at once time a stuck record out exactly once (one conditional update each)", async () => {
    delete process.env.VOUCHER_RETENTION_ENABLED;
    const now = new Date("2026-10-15T10:00:00Z");
    const stuck = await make({ status: "PROCESSING", renderedS3: undefined, extractedJson: undefined });
    await backdate(stuck._id, new Date(now.getTime() - 20 * 60_000));
    const [a, b] = await Promise.all([runVoucherRetention(now), runVoucherRetention(now)]);
    expect(a.timedOut + b.timedOut).toBe(1);
    expect((await raw(stuck._id)).status).toBe("FAILED");
  });

  it("never touches a record that has already left PROCESSING", async () => {
    const now = new Date("2026-10-15T10:00:00Z");
    const done = await make({ status: "SUCCESS" });
    await backdate(done._id, new Date(now.getTime() - 20 * 60_000));
    await runVoucherRetention(now);
    expect((await raw(done._id)).status).toBe("SUCCESS");
  });
});
