import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitMetric } from "./plutoMetricsSink.js";
import { searchError, aiFallback, conversationStarted } from "./plutoMetricsBuilder.js";

// PLUTO_METRICS is unset in the test env, so METRICS_ENABLED is false. This
// verifies error/warn severity events STILL surface (operational visibility does
// not depend on the analytics flag), while info events stay gated.

let errorSpy: any;
let warnSpy: any;
let logSpy: any;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("emitMetric severity routing (PLUTO_METRICS disabled)", () => {
  it("error-severity event → console.error, regardless of the analytics flag", async () => {
    await emitMetric(searchError({ workspaceId: "ws", requestId: "r", reason: "TBO_ERROR" }));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = String(errorSpy.mock.calls[0][1]);
    expect(payload).toContain("pluto.search.error");
    expect(payload).toContain("TBO_ERROR");
  });

  it("warn-severity event → console.warn, regardless of the analytics flag", async () => {
    await emitMetric(aiFallback({ workspaceId: "ws", requestId: "r", reason: "openai_error" }));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][1])).toContain("pluto.ai.fallback");
  });

  it("info-severity event → suppressed when PLUTO_METRICS is off", async () => {
    await emitMetric(conversationStarted("c1"));
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
