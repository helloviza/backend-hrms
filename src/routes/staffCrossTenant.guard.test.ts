// apps/backend/src/routes/staffCrossTenant.guard.test.ts
//
// GUARD — keeps Plumtrips staff able to act on customers' approval requests
// and proposals.
//
// Staff log in with the HOUSE workspace in their token. Their ops actions work
// on CUSTOMER records (a customer's workspaceId), so any lookup scoped to the
// caller's own workspace (`req.workspaceObjectId`, `scopedFindById(..., req
// .workspaceObjectId)`) 404s for staff on every customer request. This broke
// twice: 7ea09c05 fixed it, 9d16b4e5 silently re-scoped it, and prod ran
// without working ops actions until requestFilterFor() / byIdFor().
//
// This test reads the route source and fails if a staff route reaches for the
// caller's workspace again. Use requestFilterFor(req, id) in approvals.ts and
// byIdFor(req, id) / staffWorkspaceScope(req) in proposals.ts instead (staff
// by id; everyone else inside their own workspace). The behavioural side is in
// approvals.travellers.test.ts ("staff work every tenant's requests") and
// approvals.flow2Journey.test.ts ("Plumtrips staff (HOUSE login) work a
// customer's proposal").
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(path.join(here, f), "utf8");

type Block = { method: string; path: string; text: string };

/** Each `router.<method>(` call with everything up to the next one. */
function routeBlocks(code: string): Block[] {
  const re = /router\.(get|put|post|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  const hits: Array<{ i: number; method: string; path: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) hits.push({ i: m.index, method: m[1].toUpperCase(), path: m[2] });
  return hits.map((h, k) => ({ method: h.method, path: h.path, text: code.slice(h.i, k + 1 < hits.length ? hits[k + 1].i : code.length) }));
}

const SELF_SCOPE = [/workspaceObjectId/, /scopedFindById\s*\(/, /req\.workspaceId\b/, /req\.workspace\b/];

function offenders(blocks: Block[]) {
  return blocks
    .map((b) => ({ b, hit: SELF_SCOPE.find((re) => re.test(b.text)) }))
    .filter((x) => x.hit)
    .map((x) => `${x.b.method} ${x.b.path}  (matches ${x.hit})`);
}

const WHY =
  "A staff route is scoped to the staff member's own (HOUSE) workspace again — it will 404 on every customer record. " +
  "Use requestFilterFor (approvals.ts) / byIdFor or staffWorkspaceScope (proposals.ts). See the header of this test.";

describe("staff ops actions are never scoped to the staff member's own workspace", () => {
  it("approvals.ts: every /admin route", () => {
    const blocks = routeBlocks(src("approvals.ts")).filter((b) => b.path.startsWith("/admin"));
    expect(blocks.length, "scanner found too few /admin routes — update this guard").toBeGreaterThanOrEqual(14);
    expect(offenders(blocks), WHY).toEqual([]);
  });

  it("proposals.ts: every staff-only (requireStaff) route", () => {
    const blocks = routeBlocks(src("proposals.ts")).filter((b) => /\brequireStaff\b/.test(b.text.slice(0, 400)));
    expect(blocks.length, "scanner found too few staff proposal routes — update this guard").toBeGreaterThanOrEqual(12);
    expect(offenders(blocks), WHY).toEqual([]);
  });

  it("approvals.travelDesk.ts: never touches the caller's workspace", () => {
    expect(SELF_SCOPE.some((re) => re.test(src("approvals.travelDesk.ts"))), WHY).toBe(false);
  });

  it("the helpers keep their staff branch (staff by id, everyone else in their own workspace)", () => {
    const a = src("approvals.ts");
    expect(a).toMatch(/function requestFilterFor\([^)]*\)\s*\{\s*return isStaffAdmin\(req\.user\) \? \{ _id: id \} : \{ _id: id, workspaceId: req\.workspaceObjectId \};/);
    const p = src("proposals.ts");
    expect(p).toMatch(/function staffWorkspaceScope\([^)]*\)[^{]*\{\s*return isStaffAdmin\(\(req as AuthedReq\)\.user\) \? undefined : \(req as any\)\.workspaceObjectId;/);
    expect(p).toMatch(/function byIdFor\([^)]*\)\s*\{\s*const ws = staffWorkspaceScope\(req\);\s*return ws \? \{ _id: id, workspaceId: ws \} : \{ _id: id \};/);
  });
});
