import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression cover for the watcher's latent instance-selection bug (0.3).
//
// TripWatch has always carried departDate, but runWatchCycle called
// checkStatus(watch.flightNo) with no date. getDelightfulFlightStatus then
// asked AeroAPI for an unbounded window and took flights[0] — the head of a
// NEWEST-FIRST list, i.e. the occurrence ~2 days out. So a watcher watching
// TODAY's flight diffed its stored state against a DIFFERENT day's flight, and
// could alert a traveller about a delay that was not theirs.

const H = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("axios", () => ({
  default: { get: H.get, isAxiosError: () => false },
  isAxiosError: () => false,
}));

process.env.FLIGHTAWARE_API_KEY = "test-key";

const { runWatchCycle } = await import("./tripWatchWorker.js");
const { getFlightOccurrenceForDate } = await import("../services/flightService.js");

function row(dateYMD: string, over: Record<string, any> = {}) {
  return {
    ident: "IGO204",
    flight_number: "204",
    status: "Scheduled",
    scheduled_out: `${dateYMD}T10:00:00Z`,
    scheduled_in: `${dateYMD}T12:30:00Z`,
    origin: { code_iata: "DEL", name: "Delhi", city: "Delhi", timezone: "Asia/Kolkata" },
    destination: { code_iata: "BOM", name: "Mumbai", city: "Mumbai", timezone: "Asia/Kolkata" },
    terminal_origin: "3",
    gate_origin: "A1",
    ...over,
  };
}

const WATCHED_DATE = "2026-08-03";

// Newest first, exactly as AeroAPI returns. The watched day sits at index 2 —
// the position the old flights[0] selection skipped straight past.
const NEWEST_FIRST = [
  row("2026-08-05"),
  row("2026-08-04"),
  // The watched occurrence: departed 45 min late.
  row(WATCHED_DATE, { actual_out: `${WATCHED_DATE}T10:45:00Z`, gate_origin: "A1" }),
  row("2026-08-02", { status: "Arrived / Gate Arrival" }),
];

function claimSource(watches: any[]) {
  const q = [...watches];
  return () => Promise.resolve(q.shift() ?? null);
}

function deps(over: Partial<any> = {}): any {
  return {
    cap: 10,
    metric: vi.fn(),
    claimNext: () => Promise.resolve(null),
    checkStatus: vi.fn().mockResolvedValue({ flight_status: "Scheduled", departure: {} }),
    persistCheck: vi.fn().mockResolvedValue(undefined),
    createAndNotifyAlert: vi.fn().mockResolvedValue(undefined),
    isBookingCancelled: vi.fn().mockResolvedValue(false),
    cancelWatch: vi.fn().mockResolvedValue(undefined),
    handleArrival: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const watch = (over: any = {}) => ({
  _id: "w1",
  workspaceId: "ws1",
  flightNo: "6E-204",
  departDate: new Date(`${WATCHED_DATE}T10:00:00Z`),
  lastKnownState: null,
  ...over,
});

beforeEach(() => {
  H.get.mockReset();
  H.get.mockResolvedValue({ data: { flights: NEWEST_FIRST } });
});

describe("tripWatchWorker — watched-occurrence selection", () => {
  it("passes the watch's departDate to checkStatus (it was being ignored)", async () => {
    const checkStatus = vi.fn().mockResolvedValue({ flight_status: "Scheduled", departure: {} });
    const w = watch();
    await runWatchCycle(deps({ claimNext: claimSource([w]), checkStatus }));
    expect(checkStatus).toHaveBeenCalledTimes(1);
    expect(checkStatus).toHaveBeenCalledWith(w.flightNo, w.departDate);
  });

  it("selects the WATCHED occurrence, not the newest-first window head", async () => {
    const seen: any[] = [];
    await runWatchCycle(
      deps({
        claimNext: claimSource([watch()]),
        // The real lookup, wired exactly as tripWatchWorker wires it.
        checkStatus: (flightNo: string, departDate: any) =>
          getFlightOccurrenceForDate(flightNo, departDate),
        persistCheck: async (_w: any, curr: any) => { seen.push(curr); },
      }),
    );
    expect(seen).toHaveLength(1);
    // Pre-0.3 this would have been the 2026-08-05 occurrence.
    expect(seen[0].depScheduled).toBe(`${WATCHED_DATE}T10:00:00Z`);
    expect(seen[0].depActual).toBe(`${WATCHED_DATE}T10:45:00Z`);
  });

  it("still diffs state correctly and alerts on the watched flight's delay", async () => {
    const createAndNotifyAlert = vi.fn().mockResolvedValue(undefined);
    const r = await runWatchCycle(
      deps({
        claimNext: claimSource([
          watch({
            // Prior snapshot: on time, so the 45-min delay is a NEW transition.
            lastKnownState: {
              status: "Scheduled",
              depScheduled: `${WATCHED_DATE}T10:00:00Z`,
              depActual: null,
              depGate: "A1",
              depTerminal: "3",
            },
          }),
        ]),
        checkStatus: (flightNo: string, departDate: any) =>
          getFlightOccurrenceForDate(flightNo, departDate),
        createAndNotifyAlert,
      }),
    );
    expect(r.alerted).toBe(1);
    expect(createAndNotifyAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "DELAY", detail: "Departure delayed 45 min" }),
    );
  });

  it("records the check without alerting when the watched date has no occurrence", async () => {
    const createAndNotifyAlert = vi.fn().mockResolvedValue(undefined);
    const persistCheck = vi.fn().mockResolvedValue(undefined);
    const r = await runWatchCycle(
      deps({
        claimNext: claimSource([watch({ departDate: new Date("2026-08-09T10:00:00Z") })]),
        checkStatus: (flightNo: string, departDate: any) =>
          getFlightOccurrenceForDate(flightNo, departDate),
        createAndNotifyAlert,
        persistCheck,
      }),
    );
    expect(r.alerted).toBe(0);
    expect(createAndNotifyAlert).not.toHaveBeenCalled();
    expect(persistCheck).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("makes exactly ONE AeroAPI call per watch per cycle", async () => {
    await runWatchCycle(
      deps({
        claimNext: claimSource([watch()]),
        checkStatus: (flightNo: string, departDate: any) =>
          getFlightOccurrenceForDate(flightNo, departDate),
      }),
    );
    expect(H.get).toHaveBeenCalledTimes(1);
  });
});
