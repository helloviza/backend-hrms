import { describe, it, expect } from "vitest";
import PlutoMetricEvent from "./PlutoMetricEvent.js";

describe("PlutoMetricEvent model", () => {
  it("has a 90-day TTL index on createdAt", () => {
    const ttl = PlutoMetricEvent.schema.indexes().find(
      ([fields]: any) => fields.createdAt !== undefined,
    );
    expect(ttl).toBeDefined();
    const [, options] = ttl as any;
    expect(options.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
  });

  it("is workspace-scoped (workspaceId path exists and is required)", () => {
    const path: any = PlutoMetricEvent.schema.path("workspaceId");
    expect(path).toBeDefined();
    expect(path.isRequired).toBe(true);
  });
});
