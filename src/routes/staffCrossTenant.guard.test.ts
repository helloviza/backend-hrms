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
    // Staff by id, held to their Admin Queue scope (queueCaseScope); everyone else in their own workspace.
    expect(a).toMatch(/function requestFilterFor\([^)]*\)\s*\{\s*if \(!hasQueueView\(req\)\) return \{ _id: id, workspaceId: req\.workspaceObjectId \};\s*const scope = queueCaseScope\(req\);\s*if \(!Object\.keys\(scope\)\.length\) return \{ _id: id \};/);
    expect(a).toMatch(/function queueCaseFilter\([^)]*\)\s*\{\s*return hasQueueView\(req\) \? \{ _id: id, \.\.\.queueCaseScope\(req\) \} : \{ _id: id, workspaceId: req\.workspaceObjectId \};/);
    // Every /admin route looks a case up through the scoped filter, never the unscoped one.
    const admin = routeBlocks(a).filter((b) => b.path.startsWith("/admin/") && /:id/.test(b.path));
    expect(admin.filter((b) => /requestFilterFor\(/.test(b.text)).map((b) => `${b.method} ${b.path}`), "an /admin route skips the queue scope").toEqual([]);
    expect(admin.filter((b) => !/queueCaseFilter\(/.test(b.text)).map((b) => `${b.method} ${b.path}`), "an /admin case route has no scoped lookup").toEqual([]);
    const p = src("proposals.ts");
    expect(p).toMatch(/function staffWorkspaceScope\([^)]*\)[^{]*\{\s*return hasQueueView\(req\) \? undefined : \(req as any\)\.workspaceObjectId;/);
    expect(p).toMatch(/function byIdFor\([^)]*\)\s*\{\s*const ws = staffWorkspaceScope\(req\);\s*return ws \? \{ _id: id, workspaceId: ws \} : \{ _id: id \};/);
  });
});

/* ── Follow-ups (fix/staff-scope-followups): the same bug class elsewhere ── */

const block = (file: string, method: string, p: string) => {
  const b = routeBlocks(src(file)).find((x) => x.method === method && x.path === p);
  if (!b) throw new Error(`${file}: ${method} ${p} not found — update this guard`);
  return b.text;
};

describe("follow-up routes keep acting on the customer's record for staff", () => {
  it("proposals: the staff travel-mode gate checks the CUSTOMER's flow (requireTravelModeFor), not the caller's", () => {
    for (const [method, p] of [["POST", "/by-request/:requestId/draft"], ["POST", "/:id/submit"], ["POST", "/:id/record-decision"]] as const) {
      const head = block("proposals.ts", method, p).slice(0, 300);
      expect(head, `${method} ${p}: caller-based requireTravelMode is back`).not.toMatch(/requireTravelMode\(/);
      expect(head, `${method} ${p}`).toMatch(/requireFlow2For(Request|Proposal)/);
    }
    const guard = readFileSync(path.join(here, "../middleware/travelModeGuard.ts"), "utf8");
    expect(guard).toMatch(/export function requireTravelModeFor/);
    expect(guard).toMatch(/if \(!opts\.isStaff\(req\)\) return forCaller\(req, res, next\);/);
    expect(guard).toMatch(/opts\.resolveWorkspaceId\(req\)/);
  });

  it("customers: Account Team editor and the staff lists treat HOUSE staff as platform-wide", () => {
    const c = src("customers.ts");
    expect(c).toMatch(/function isPlumtripsStaff\(req: any\): boolean \{\s*return isSuperAdmin\(req\) \|\| String\(req\.workspaceId \|\| req\.workspaceObjectId \|\| ""\) === PLUMTRIPS_HOUSE_WORKSPACE_ID;/);
    expect(block("customers.ts", "GET", "/")).toMatch(/isPlumtripsStaff\(_req\) \? \{\} :/);
    expect(block("customers.ts", "GET", "/admin/all")).toMatch(/isPlumtripsStaff\(_req\) \? \{\} :/);
    expect(block("customers.ts", "PATCH", "/:id/account-team")).toMatch(/if \(!isPlumtripsStaff\(req\) && req\.workspaceObjectId\) acctQuery\.workspaceId/);
  });

  it("sbt hotels: staff mark-failed finds the booking by id", () => {
    const b = block("sbt.hotels.ts", "POST", "/bookings/:id/mark-failed");
    expect(b, WHY).toMatch(/isPlumtripsStaffCaller\(req\)\s*\?\s*await SBTHotelBooking\.findById\(req\.params\.id\)/);
    expect(src("sbt.hotels.ts")).toMatch(/function isPlumtripsStaffCaller\(req: any\): boolean \{\s*return isSuperAdmin\(req\) \|\| String\(req\.workspaceId \|\| req\.workspaceObjectId \|\| ""\) === MARK_FAILED_HOUSE_WORKSPACE_ID;/);
  });

  it("carbon: tenants are scoped in Customer id space; Plumtrips staff get an explicit {}", () => {
    const c = src("admin.carbon.ts");
    expect(c).toMatch(/if \(isPlumtripsStaff\(req\)\) return \{\};/);
    expect(c).toMatch(/const customerId = String\(req\.workspace\?\.customerId \|\| ""\);/);
    // The bug was returning the CustomerWorkspace id as the CarbonRecord scope.
    expect(c, "tenantScope returns the workspace id again (CarbonRecord.workspaceId is a Customer id)").not.toMatch(/return ws;/);
  });
});

/* ── Queue access = the Access Console "Admin Queue" grant (fix/travel-desk-access-permission) ── */

describe("ops queue access comes from the Admin Queue grant, never from roles alone", () => {
  it("the queue gates resolve adminQueueAccess (grant via readCapability; HOUSE only; ADMIN/SUPERADMIN oversight; scope)", () => {
    const sec = src("approvals.security.ts");
    expect(sec).toMatch(/const grant = await readCapability\(req, "adminQueue"\);/);
    expect(sec).toMatch(/hasAccess\(grant\.access, "READ"\)/);
    expect(sec).toMatch(/work: hasAccess\(grant\.access, "WRITE"\)/);
    expect(sec).toMatch(/scope: grant\.scope === "OWN" \? "own" : "all"/);
    expect(sec).toMatch(/=== PLUMTRIPS_HOUSE_WORKSPACE_ID\)/);
    expect(sec, "read gate").toMatch(/if \(\(await adminQueueAccess\(req\)\)\.view\) return next\(\);/);
    expect(sec, "write gate").toMatch(/if \(!\(await adminQueueAccess\(req\)\)\.work\) \{/);
    expect(sec, "lists are scoped").toMatch(/if \(hasQueueView\(req\)\) \{\s*const scope = queueCaseScope\(req\);/);
    const prop = src("proposals.ts");
    expect(prop, "proposals requireStaff").toMatch(/const a = await adminQueueAccess\(req\);\s*if \(!\(req\.method === "GET" \? a\.view : a\.work\)\) \{/);
    expect(prop, "proposals requireStaff scope").toMatch(/if \(await requestInQueueScope\(req, requestId\)\) return next\(\);/);
  });

  it("no role-based staff test is left in the queue code (approvals, proposals, Travel Desk)", () => {
    for (const f of ["approvals.ts", "proposals.ts", "approvals.travelDesk.ts", "../services/travelDesk.ts"]) {
      expect(src(f), f).not.toMatch(/isStaffAdmin\s*\(/);
    }
  });

  it("the Travel Desk pool is the grant (WRITE+), with no role filter", () => {
    const td = src("../services/travelDesk.ts");
    expect(td).toMatch(/"modules\.adminQueue\.access": \{ \$in: AGENT_ACCESS \}/);
    expect(td).toMatch(/const AGENT_ACCESS = \["WRITE", "FULL"\];/);
    expect(td).not.toMatch(/roles: STAFF_ROLE_RE|hrmsAccessRole: STAFF_ROLE_RE/);
  });
});
