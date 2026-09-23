// The shared Learning Hub progress block (the `PT` helper) is copied into the
// hub, every deck and both deck generators. These pin that the copies stay
// identical, and — by RUNNING the real block in a sandbox — that write() keeps
// saving to localStorage and, only when embedded in the app, also posts
// {type:"pt-progress"} to the host page (pages/learning/LearningHub.tsx →
// PUT /api/training/progress/:module).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COPIES = [
  path.join(backend, "src/training/learning-hub.html"),
  path.join(backend, "src/training/crm-walkthrough.html"),
  path.join(backend, "src/training/spendbox-walkthrough.html"),
  // The generators live in the monorepo's docs/ — absent from the backend
  // subtree App Runner builds, so a missing copy there is skipped, not failed.
  ...["crm-walkthrough", "spendbox-walkthrough"]
    .map((d) => path.resolve(backend, "../../docs/training", d, "tools/build-deck.mjs"))
    .filter((p) => fs.existsSync(p)),
];

function block(file: string): string {
  const rel = path.relative(backend, file);
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf("/* ── Plumtrips Learning · shared progress storage");
  expect(start, `${rel} has the shared block`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n})();", start);
  expect(end, `${rel} block terminator`).toBeGreaterThan(start);
  return text.slice(start, end + "\n})();".length);
}

/** Run the block the way a page would; returns the PT helper + what it touched. */
function run(opts: { embedded: boolean }) {
  const store = new Map<string, string>();
  const posted: Array<{ msg: any; origin: string }> = [];
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
  };
  const ctx: any = { localStorage, URLSearchParams, location: { search: "", origin: "https://plumbox.example" } };
  ctx.window = ctx;
  if (opts.embedded) {
    ctx.PT_IDENTITY = { uid: "650000000000000000000001", name: "Priya Sharma", embedded: true };
    ctx.parent = { postMessage: (msg: any, origin: string) => posted.push({ msg, origin }) };
  } else {
    ctx.parent = ctx; // a standalone file: no host page
  }
  vm.runInNewContext(`${block(COPIES[0])}\nthis.PT = PT;`, ctx);
  return { PT: ctx.PT, store, posted };
}

describe("shared PT block", () => {
  it("is identical in the hub, both decks and both deck generators", () => {
    const [first, ...rest] = COPIES.map(block);
    rest.forEach((b, i) => expect(b, COPIES[i + 1]).toBe(first));
  });

  it("embedded: write() saves to localStorage AND posts pt-progress to the host, same-origin only", () => {
    const { PT, store, posted } = run({ embedded: true });
    const record = { module: "crm", total: 63, maxSlide: 7, lastSlide: 7, viewed: 2, completed: false };
    PT.write("crm", record);
    expect(JSON.parse(store.get("plumtrips.learning.progress.650000000000000000000001.crm")!)).toEqual(record);
    expect(posted).toHaveLength(1);
    expect(posted[0].origin).toBe("https://plumbox.example");
    expect(posted[0].msg).toEqual({ type: "pt-progress", module: "crm", record });
  });

  it("standalone file: write() still saves locally and sends nothing", () => {
    const { PT, store, posted } = run({ embedded: false });
    PT.setName("Priya Sharma");
    PT.write("crm", { module: "crm", total: 63, maxSlide: 1 });
    expect(store.get("plumtrips.learning.progress.priya-sharma.crm")).toBeTruthy();
    expect(posted).toHaveLength(0);
  });
});
