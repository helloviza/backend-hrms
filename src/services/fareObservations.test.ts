import { describe, it, expect, vi, beforeEach } from "vitest";

const { insertManyMock, emitMetricMock } = vi.hoisted(() => ({
  insertManyMock: vi.fn(),
  emitMetricMock: vi.fn(),
}));
vi.mock("../models/FareObservation.js", () => ({ default: { insertMany: insertManyMock } }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: emitMetricMock }));

import { recordFareObservations } from "./fareObservations.js";

const WS = "656565656565656565656565";

function rawRow(over: Record<string, any> = {}) {
  return {
    IsLCC: true,
    IsRefundable: true,
    Fare: { OfferedFare: 4800, PublishedFare: 5000 },
    Segments: [[{ CabinClass: 2, Airline: { AirlineCode: "6E", FlightNumber: "2582" } }]],
    ...over,
  };
}

const base = { workspaceObjectId: WS, origin: "DEL", destination: "BOM", departDate: "2026-05-20", requestId: "r1" };
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  insertManyMock.mockReset();
  emitMetricMock.mockReset();
  insertManyMock.mockResolvedValue([]);
});

describe("recordFareObservations", () => {
  it("inserts observation docs with the right shape on a successful search", async () => {
    recordFareObservations({ ...base, rawRows: [rawRow()] });
    expect(insertManyMock).toHaveBeenCalledTimes(1);
    const [docs, opts] = insertManyMock.mock.calls[0];
    expect(opts).toEqual({ ordered: false });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      workspaceId: WS,
      origin: "DEL",
      destination: "BOM",
      departDate: "2026-05-20",
      cabinClass: 2,
      airline: "6E",
      flightNo: "6E-2582",
      fareINR: 4800,
      fareType: "RETAIL",
      isLCC: true,
      isRefundable: true,
      source: "TBO_SEARCH",
    });
    expect(docs[0].observedAt).toBeInstanceOf(Date);
  });

  it("no insert when there are no rows or no workspace scope", () => {
    recordFareObservations({ ...base, rawRows: [] });
    recordFareObservations({ ...base, workspaceObjectId: null, rawRows: [rawRow()] });
    expect(insertManyMock).not.toHaveBeenCalled();
  });

  it("caps at 30 rows per search", () => {
    const rows = Array.from({ length: 40 }, (_, i) => rawRow({ Fare: { OfferedFare: 1000 + i } }));
    recordFareObservations({ ...base, rawRows: rows });
    expect(insertManyMock.mock.calls[0][0]).toHaveLength(30);
  });

  it("skips rows without a usable fare", () => {
    recordFareObservations({ ...base, rawRows: [rawRow({ Fare: {} }), rawRow()] });
    expect(insertManyMock.mock.calls[0][0]).toHaveLength(1);
  });

  it("a rejected insert never throws and emits pluto.fareobs.write_failed", async () => {
    insertManyMock.mockRejectedValue(new Error("mongo down"));
    // Must not throw synchronously (fire-and-forget).
    expect(() => recordFareObservations({ ...base, rawRows: [rawRow()] })).not.toThrow();
    await tick();
    const types = emitMetricMock.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain("pluto.fareobs.write_failed");
  });
});
