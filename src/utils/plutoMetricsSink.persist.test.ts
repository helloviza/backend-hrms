import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("../models/PlutoMetricEvent.js", () => ({ default: { create: createMock } }));

import { emitMetric } from "./plutoMetricsSink.js";

const WS = "656565656565656565656565"; // valid ObjectId string

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue({ _id: "x" });
});

describe("plutoMetricsSink persistence", () => {
  it("inserts a durable event on emit (tenant-scoped)", async () => {
    await emitMetric({
      type: "pluto.policy.evaluated",
      severity: "info",
      timestamp: "t",
      workspaceId: WS,
      requestId: "req1",
      metadata: { inPolicyCount: 2, totalCount: 5 },
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const doc = createMock.mock.calls[0][0];
    expect(doc.type).toBe("pluto.policy.evaluated");
    expect(doc.requestId).toBe("req1");
    expect(String(doc.workspaceId)).toBe(WS);
    expect(doc.payload).toMatchObject({ inPolicyCount: 2, totalCount: 5 });
  });

  it("skips persistence (no throw) when workspaceId is missing/invalid", async () => {
    await emitMetric({ type: "pluto.ai.error", severity: "error", timestamp: "t", workspaceId: "not-an-objectid" });
    await emitMetric({ type: "pluto.ai.error", severity: "error", timestamp: "t" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("a rejected insert never fails the emit (fire-and-forget)", async () => {
    createMock.mockRejectedValue(new Error("mongo down"));
    // Must resolve, not throw.
    await expect(
      emitMetric({ type: "pluto.search.error", severity: "error", timestamp: "t", workspaceId: WS }),
    ).resolves.toBeUndefined();
  });
});
