// Step 3 — ensurePlutoIndexes: builds every Pluto model's indexes; one failure
// is logged and swallowed, the rest still build (never crashes boot).
import { describe, it, expect, vi } from "vitest";
import { ensurePlutoIndexes } from "./ensurePlutoIndexes.js";

const model = (name: string, throws = false) => [name, { createIndexes: vi.fn(async () => { if (throws) throw new Error(`${name} index conflict`); }) }] as [string, any];

describe("ensurePlutoIndexes", () => {
  it("calls createIndexes on every model", async () => {
    const models = [model("A"), model("B"), model("C")];
    const log = { warn: vi.fn(), log: vi.fn() };
    const res = await ensurePlutoIndexes(models, log);
    for (const [, m] of models) expect(m.createIndexes).toHaveBeenCalledTimes(1);
    expect(res.ok).toEqual(["A", "B", "C"]);
    expect(res.failed).toEqual([]);
  });

  it("a failing build is LOUDLY warned + swallowed; others still build", async () => {
    const models = [model("A"), model("B", true), model("C")];
    const log = { warn: vi.fn(), log: vi.fn() };
    const res = await ensurePlutoIndexes(models, log);
    expect(res.ok).toEqual(["A", "C"]);
    expect(res.failed).toEqual(["B"]);
    expect(models[2][1].createIndexes).toHaveBeenCalled(); // C still built after B failed
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][0])).toContain("createIndexes FAILED for B");
  });
});
