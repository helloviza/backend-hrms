// apps/backend/scripts/vendor-shared.mjs
//
// Phase 2b — vendors the built @plumtrips/shared package into the backend
// subtree so the App Runner image build (which sees the apps/backend subtree
// ONLY — no pnpm-workspace.yaml, no packages/shared) can resolve it via a
// plain `file:vendor/shared` dependency. No workspace, no registry, no network.
//
// What it does:
//   1. (re)builds packages/shared  → packages/shared/dist
//   2. copies that dist            → apps/backend/vendor/shared/dist
//   3. writes a minimal runtime package.json (name/version/type/exports + the
//      single runtime dep `qrcode`, which the backend already depends on).
//
// Run this whenever packages/shared changes, BEFORE committing + subtree-split
// push. The committed vendor/ folder is what travels into the GitHub mirror.
//
//   node apps/backend/scripts/vendor-shared.mjs
//
// The Phase 2a byte-identity snapshot test guards the templates from drifting;
// this script guards the *vendored copy* from going stale vs packages/shared.

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", ".."); // apps/backend/scripts → repo root
const sharedDir = resolve(repoRoot, "packages", "shared");
const vendorDir = resolve(here, "..", "vendor", "shared"); // apps/backend/vendor/shared

console.log("[vendor-shared] repo root:", repoRoot);
console.log("[vendor-shared] source   :", sharedDir);
console.log("[vendor-shared] target   :", vendorDir);

// 1. Build packages/shared so dist is current.
console.log("[vendor-shared] building @plumtrips/shared …");
execSync("pnpm -C packages/shared build", { cwd: repoRoot, stdio: "inherit" });

// 2. Clean + copy dist.
rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });
cpSync(resolve(sharedDir, "dist"), resolve(vendorDir, "dist"), { recursive: true });

// 3. Write a minimal runtime package.json (strip devDeps/scripts; keep exports
//    + runtime deps verbatim so the file: install resolves identically).
const srcPkg = JSON.parse(readFileSync(resolve(sharedDir, "package.json"), "utf8"));
const vendoredPkg = {
  name: srcPkg.name,
  version: srcPkg.version,
  type: srcPkg.type,
  exports: srcPkg.exports,
  dependencies: srcPkg.dependencies ?? {},
  // Provenance marker — this folder is generated, do not hand-edit.
  _vendoredFrom: "packages/shared",
  _vendoredBy: "apps/backend/scripts/vendor-shared.mjs",
};
writeFileSync(
  resolve(vendorDir, "package.json"),
  JSON.stringify(vendoredPkg, null, 2) + "\n",
);

writeFileSync(
  resolve(vendorDir, "README.md"),
  [
    "# Vendored @plumtrips/shared (generated — do not edit)",
    "",
    "This folder is a build artifact produced by",
    "`apps/backend/scripts/vendor-shared.mjs`. It exists so the apps/backend",
    "subtree (which deploys to App Runner without the monorepo workspace) can",
    "resolve `@plumtrips/shared` via `file:vendor/shared`.",
    "",
    "Source of truth: `packages/shared`. Re-run the script after changing it.",
    "",
  ].join("\n"),
);

console.log("[vendor-shared] done — vendored to apps/backend/vendor/shared");
