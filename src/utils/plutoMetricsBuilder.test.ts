import { describe, it, expect } from "vitest";
import {
  searchError,
  aiFallback,
  aiError,
  aiFallbackInvalid,
  multicityDowngraded,
} from "./plutoMetricsBuilder.js";

const args = { workspaceId: "ws1", requestId: "req1", reason: "boom", conversationId: "c1" };

describe("pluto failure metric builders", () => {
  it("searchError → type + error severity + passthrough fields", () => {
    const e = searchError(args);
    expect(e.type).toBe("pluto.search.error");
    expect(e.severity).toBe("error");
    expect(e.workspaceId).toBe("ws1");
    expect(e.requestId).toBe("req1");
    expect(e.reason).toBe("boom");
    expect(e.conversationId).toBe("c1");
    expect(typeof e.timestamp).toBe("string");
  });

  it("aiFallback → warn severity", () => {
    const e = aiFallback(args);
    expect(e.type).toBe("pluto.ai.fallback");
    expect(e.severity).toBe("warn");
  });

  it("aiError → error severity", () => {
    const e = aiError(args);
    expect(e.type).toBe("pluto.ai.error");
    expect(e.severity).toBe("error");
  });

  it("aiFallbackInvalid → error severity", () => {
    const e = aiFallbackInvalid(args);
    expect(e.type).toBe("pluto.ai.fallback_invalid");
    expect(e.severity).toBe("error");
  });

  it("multicityDowngraded → warn severity", () => {
    const e = multicityDowngraded({ workspaceId: "ws1", requestId: "req1", reason: "first_leg" });
    expect(e.type).toBe("pluto.multicity.downgraded");
    expect(e.severity).toBe("warn");
    expect(e.workspaceId).toBe("ws1");
  });
});
