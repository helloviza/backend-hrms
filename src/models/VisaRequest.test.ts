// Unit coverage for VisaRequest.ts's two exported functions.
// Counter and VisaApplication (recomputeRequestStatus's dynamic import) are
// mocked; VisaRequest itself is the real Model object with its own static
// methods spied — no DB connection needed for either.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const visaApplicationFindMock = vi.fn();
vi.mock("./VisaApplication.js", () => ({
  default: { find: (...args: any[]) => ({ select: () => ({ lean: () => visaApplicationFindMock(...args) }) }) },
}));

const counterFindByIdAndUpdateMock = vi.fn();
vi.mock("./Counter.js", () => ({
  default: { findByIdAndUpdate: (...args: any[]) => counterFindByIdAndUpdateMock(...args) },
}));

import VisaRequest, { recomputeRequestStatus, mintVisaRequestReferenceNumber } from "./VisaRequest.js";

function chainWithLean(value: any) {
  return { select: () => ({ lean: () => Promise.resolve(value) }) };
}

describe("mintVisaRequestReferenceNumber", () => {
  beforeEach(() => counterFindByIdAndUpdateMock.mockReset());

  it("is HV-prefixed with a 2-digit year and 6-digit zero-padded sequence", async () => {
    counterFindByIdAndUpdateMock.mockResolvedValue({ seq: 7 });
    const ref = await mintVisaRequestReferenceNumber(new Date("2026-03-15"));
    expect(ref).toBe("HV26-000007");
  });

  it("never PT-prefixed", async () => {
    counterFindByIdAndUpdateMock.mockResolvedValue({ seq: 1 });
    const ref = await mintVisaRequestReferenceNumber(new Date("2026-01-01"));
    expect(ref.startsWith("PT")).toBe(false);
    expect(ref.startsWith("HV")).toBe(true);
  });

  it("keys the counter as visaRequestHV:<YY> — a fresh namespace, not an old PT-era key", async () => {
    counterFindByIdAndUpdateMock.mockResolvedValue({ seq: 1 });
    await mintVisaRequestReferenceNumber(new Date("2026-01-01"));
    expect(counterFindByIdAndUpdateMock).toHaveBeenCalledWith(
      "visaRequestHV:26",
      { $inc: { seq: 1 } },
      { upsert: true, new: true },
    );
  });

  it("does not touch any counter key containing 'visaRequest:' (the old, unprefixed key)", async () => {
    counterFindByIdAndUpdateMock.mockResolvedValue({ seq: 1 });
    await mintVisaRequestReferenceNumber(new Date("2026-01-01"));
    const [key] = counterFindByIdAndUpdateMock.mock.calls[0];
    expect(key).not.toBe("visaRequest:26");
  });

  it("pads a large sequence without truncating — no digit loss above 999999", async () => {
    counterFindByIdAndUpdateMock.mockResolvedValue({ seq: 1234567 });
    const ref = await mintVisaRequestReferenceNumber(new Date("2026-01-01"));
    expect(ref).toBe("HV26-1234567");
  });
});

describe("recomputeRequestStatus", () => {
  const requestId = new mongoose.Types.ObjectId();
  let updateSpy: any;

  beforeEach(() => {
    visaApplicationFindMock.mockReset();
    updateSpy = vi
      .spyOn(VisaRequest, "findByIdAndUpdate")
      .mockImplementation((_id: any, update: any) => ({ select: () => Promise.resolve({ status: update.$set.status }) }) as any);
  });

  it("is cancelled when cancelledAt is set, regardless of application states", async () => {
    vi.spyOn(VisaRequest, "findById").mockReturnValue(chainWithLean({ cancelledAt: new Date() }) as any);
    const status = await recomputeRequestStatus(requestId);
    expect(status).toBe("cancelled");
    expect(updateSpy).toHaveBeenCalledWith(requestId, { $set: { status: "cancelled" } }, { new: true });
    // Cancellation short-circuits before ever looking at applications.
    expect(visaApplicationFindMock).not.toHaveBeenCalled();
  });

  it("is draft when there are no applications yet", async () => {
    vi.spyOn(VisaRequest, "findById").mockReturnValue(chainWithLean({ cancelledAt: null }) as any);
    visaApplicationFindMock.mockResolvedValue([]);
    expect(await recomputeRequestStatus(requestId)).toBe("draft");
  });

  it("is draft when every application is still draft", async () => {
    vi.spyOn(VisaRequest, "findById").mockReturnValue(chainWithLean({ cancelledAt: null }) as any);
    visaApplicationFindMock.mockResolvedValue([{ status: "draft" }, { status: "draft" }]);
    expect(await recomputeRequestStatus(requestId)).toBe("draft");
  });

  it("is active when at least one application has progressed but not all are closed", async () => {
    vi.spyOn(VisaRequest, "findById").mockReturnValue(chainWithLean({ cancelledAt: null }) as any);
    visaApplicationFindMock.mockResolvedValue([{ status: "draft" }, { status: "submitted" }]);
    expect(await recomputeRequestStatus(requestId)).toBe("active");
  });

  it("is completed when every application is closed with a non-WITHDRAWN outcome", async () => {
    vi.spyOn(VisaRequest, "findById").mockReturnValue(chainWithLean({ cancelledAt: null }) as any);
    visaApplicationFindMock.mockResolvedValue([
      { status: "closed", outcome: "APPROVED" },
      { status: "closed", outcome: "REJECTED" },
    ]);
    expect(await recomputeRequestStatus(requestId)).toBe("completed");
  });

  it("is cancelled when every application is closed and every outcome is WITHDRAWN", async () => {
    vi.spyOn(VisaRequest, "findById").mockReturnValue(chainWithLean({ cancelledAt: null }) as any);
    visaApplicationFindMock.mockResolvedValue([
      { status: "closed", outcome: "WITHDRAWN" },
      { status: "closed", outcome: "WITHDRAWN" },
    ]);
    expect(await recomputeRequestStatus(requestId)).toBe("cancelled");
  });

  it("returns null when the request doesn't resolve — never throws, nothing to update", async () => {
    vi.spyOn(VisaRequest, "findById").mockReturnValue(chainWithLean(null) as any);
    expect(await recomputeRequestStatus(requestId)).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
