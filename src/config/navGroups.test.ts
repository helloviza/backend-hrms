// apps/backend/src/config/navGroups.test.ts
//
// Per-user visible Header groups: validation, frontend parity, and the
// "display only" guarantee (no permission code reads the field).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { NAV_GROUP_KEYS, parseVisibleNavGroups, normalizeStoredNavGroups } from "./navGroups.js";
import { parseArgs, mongoHosts } from "../scripts/set-visible-nav-groups.js";
import { checksFor } from "../scripts/check-nav-demo-account.js";

const SRC = resolve(__dirname, "..");

describe("parseVisibleNavGroups", () => {
  it("null / undefined / [] clear", () => {
    for (const v of [null, undefined, []]) expect(parseVisibleNavGroups(v)).toEqual({ ok: true, value: null });
  });
  it("keeps order, drops duplicates, trims", () => {
    expect(parseVisibleNavGroups([" travelbox", "travelAnalytics", "travelbox"])).toEqual({ ok: true, value: ["travelbox", "travelAnalytics"] });
  });
  it("rejects unknown keys, non-arrays and non-strings", () => {
    const bad = parseVisibleNavGroups(["travelbox", "root", "superpowers"]);
    expect(bad).toMatchObject({ ok: false, unknown: ["root", "superpowers"] });
    expect(parseVisibleNavGroups("travelbox").ok).toBe(false);
    expect(parseVisibleNavGroups({ 0: "travelbox" }).ok).toBe(false);
    expect(parseVisibleNavGroups([1]).ok).toBe(false);
  });
  it("normalizeStoredNavGroups: [] and missing read as null", () => {
    expect(normalizeStoredNavGroups(undefined)).toBeNull();
    expect(normalizeStoredNavGroups([])).toBeNull();
    expect(normalizeStoredNavGroups(["crm"])).toEqual(["crm"]);
  });
});

describe("frontend parity", () => {
  it("the frontend key list is identical, in the same order", () => {
    const fe = readFileSync(resolve(SRC, "../../frontend/src/components/layout/navVisibleGroups.ts"), "utf8");
    const block = fe.slice(fe.indexOf("export const NAV_GROUP_KEYS = ["), fe.indexOf("] as const;"));
    const keys = [...block.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual([...NAV_GROUP_KEYS]);
  });
});

describe("display only — no backend permission code reads it", () => {
  // The only backend files allowed to mention the field. Anything else (a
  // middleware, a route gate, a permission service) would turn a display
  // preference into a security control.
  const ALLOWED = new Set([
    "config/navGroups.ts",
    "models/User.ts",
    "models/NavPreferenceAudit.ts",
    "services/navPreference.service.ts",
    "routes/adminNavPreferences.ts",
    "routes/employees.ts", // the strip in PUT /:id
    "scripts/set-visible-nav-groups.ts",
    "scripts/check-nav-demo-account.ts", // read-only plan checker
    "scripts/seed-profile-role-local.ts", // local QC persona
  ]);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  it("only the allow-listed files mention visibleNavGroups", () => {
    const hits = walk(SRC)
      .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))
      .filter((p) => /visibleNavGroups|NavPreferenceAudit|navPreference\.service/.test(readFileSync(p, "utf8")))
      .map((p) => relative(SRC, p).replace(/\\/g, "/"))
      .filter((p) => p !== "server.ts"); // the router mount line
    for (const h of hits) expect(ALLOWED.has(h), `unexpected reader: ${h}`).toBe(true);
    for (const dir of ["middleware/"]) expect(hits.some((h) => h.startsWith(dir))).toBe(false);
  });
});

describe("script args", () => {
  it("dry run unless --apply; exactly one of --groups / --clear; actor required", () => {
    const ok = parseArgs(["--email=PlumBox@plumtrips.com", "--groups=travelAnalytics, travelbox", "--actor=sa@plumtrips.com"]);
    expect(ok).toEqual({
      ok: true,
      args: { email: "plumbox@plumtrips.com", actor: "sa@plumtrips.com", groups: ["travelAnalytics", "travelbox"], clear: false, apply: false, confirmHost: null },
    });
    expect(parseArgs(["--email=a@b.c", "--clear", "--actor=x@y.z", "--apply"])).toMatchObject({ ok: true, args: { groups: null, clear: true, apply: true } });
    expect(parseArgs(["--email=a@b.c", "--groups=crm", "--clear", "--actor=x@y.z"]).ok).toBe(false);
    expect(parseArgs(["--email=a@b.c", "--actor=x@y.z"]).ok).toBe(false);
    expect(parseArgs(["--email=a@b.c", "--groups=crm"]).ok).toBe(false);
    expect(parseArgs(["--email=a@b.c", "--groups=", "--actor=x@y.z"]).ok).toBe(false);
  });
  it("mongoHosts never includes credentials", () => {
    expect(mongoHosts("mongodb+srv://user:p%40ss@cluster0.abc.mongodb.net/db?x=1")).toEqual(["cluster0.abc.mongodb.net"]);
    expect(mongoHosts("mongodb://127.0.0.1:27027,localhost:27028/db")).toEqual(["127.0.0.1", "localhost"]);
  });
});

describe("plumbox plan checker (read-only)", () => {
  const HOUSE = "69679a7628330a58d29f2254";
  const PLUMBOX = ["travelAnalytics", "travelbox", "spendbox", "helloviza"];
  const base = { perm: null, employee: { _id: "e1" }, houseTravelMode: "SBT", audits: 0 };
  const pass = (c: any[]) => c.every((x) => x.ok);
  it("absent: passes only with no user, and flags an APPROVAL_FLOW HOUSE", () => {
    expect(pass(checksFor("absent", { ...base, users: [] }))).toBe(true);
    expect(pass(checksFor("absent", { ...base, users: [{ _id: "u" }] }))).toBe(false);
    expect(pass(checksFor("absent", { ...base, users: [], houseTravelMode: "APPROVAL_FLOW" }))).toBe(false);
  });
  it("created → granted → done", () => {
    const u = { _id: "u", workspaceId: HOUSE, status: "ACTIVE", roles: ["EMPLOYEE"], resetTokenExpiry: new Date() };
    expect(pass(checksFor("created", { ...base, users: [u], perm: { level: { code: "L1" }, tier: 1 } }))).toBe(true);
    const g = { ...u, roles: ["SUPERADMIN"], hrmsAccessRole: "SUPERADMIN" };
    const l8 = { level: { code: "L8" }, tier: 3, status: "active" };
    expect(pass(checksFor("granted", { ...base, users: [g], perm: l8 }))).toBe(true);
    expect(pass(checksFor("done", { ...base, users: [g], perm: l8 }))).toBe(false);
    expect(pass(checksFor("done", { ...base, users: [{ ...g, visibleNavGroups: PLUMBOX }], perm: l8, audits: 1 }))).toBe(true);
    // a tier-0 / L1 permission must never pass "granted" (that user would hit /pending or lose SA)
    expect(pass(checksFor("granted", { ...base, users: [g], perm: { level: { code: "L1" }, tier: 1 } }))).toBe(false);
  });
});
