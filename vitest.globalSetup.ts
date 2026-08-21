// apps/backend/vitest.globalSetup.ts
//
// ══════════════════════════════════════════════════════════════════════
// KEEP TEST SCRATCH OFF THE SYSTEM DRIVE (Windows only).
//
// mongodb-memory-server puts each server's data directory under
// os.tmpdir(). On Windows that is %TEMP%, which lives on C:. A suite that
// spins up a mongod therefore writes its whole database to the system
// drive no matter where the repo is checked out — and mongod refuses to
// start at all when the volume has less than 500 MB free:
//
//   MongoServerError: available disk space of 325398528 bytes is less
//   than required minimum of 524288000
//
// That is not a hypothetical. It took out the backend suites on this
// machine, and the failure looks like a broken test rather than a full
// disk, which is what makes it worth preventing rather than remembering.
//
// ── WHAT THIS DOES ───────────────────────────────────────────────────
// Points TEMP/TMP/TMPDIR at a scratch directory on the SAME DRIVE THE
// REPO IS CHECKED OUT ON, for the duration of the test run only. It is
// process-scoped: it mutates this process's environment, which the test
// workers inherit when they spawn. It never touches the system TEMP
// setting, never touches the user's environment, and is gone when the run
// ends.
//
// ── WHY IT IS SAFE EVERYWHERE ELSE ───────────────────────────────────
// Three gates, and failing any of them makes this a no-op that leaves the
// default tmpdir exactly as it was:
//
//   1. Windows only. macOS and Linux put /tmp on the same filesystem as
//      everything else, so there is no second drive to move to and
//      nothing to fix.
//   2. The repo must not already be on the system drive. If it is, there
//      is no better volume to pick and redirecting would just move the
//      problem a few directories sideways.
//   3. The directory must be creatable and writable. If it is not — a
//      read-only volume, a permissions problem, a drive that vanished —
//      we fall through and use the default.
//
// The path is DERIVED from this file's own location, never hardcoded, so
// a fresh clone on any drive letter works and CI (Linux) skips it at gate
// 1 without ever touching the filesystem.
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  // Gate 1 — Windows is the only platform with a separate system drive to
  // get off.
  if (process.platform !== "win32") return;

  // The volume this checkout lives on: "D:\" for D:\plumtrips-hrms\...,
  // "C:\" for a checkout on C:. Derived from this file, so it follows the
  // repo wherever it is cloned.
  const repoVolume = path.parse(path.dirname(fileURLToPath(import.meta.url))).root;
  // The volume the default tmpdir is on — the one we are trying to spare.
  const tmpVolume = path.parse(os.tmpdir()).root;

  // Gate 2 — nothing to gain if they are the same volume.
  if (repoVolume.toLowerCase() === tmpVolume.toLowerCase()) return;

  const scratch = path.join(repoVolume, "dev-cache", "test-tmp");

  // Gate 3 — prove we can actually write there before redirecting to it.
  // Redirecting to a directory we cannot write would turn a disk-space
  // failure into a permissions failure, which is not an improvement.
  try {
    fs.mkdirSync(scratch, { recursive: true });
    fs.accessSync(scratch, fs.constants.W_OK);
  } catch {
    return;
  }

  // os.tmpdir() on Windows reads TEMP, then TMP, then USERPROFILE — and it
  // re-reads them on every call, so setting them here is enough. TMPDIR is
  // set too for any library that reaches for the POSIX name directly.
  process.env.TEMP = scratch;
  process.env.TMP = scratch;
  process.env.TMPDIR = scratch;

  // ── THE mongod BINARY, NOT JUST THE DATA ───────────────────────────
  // The 74 MB mongod download is a separate problem from the data
  // directory and lands somewhere else: mongodb-memory-server's default
  // "homeCache", ~/.cache/mongodb-binaries, which is on the system drive
  // regardless of TEMP.
  //
  // There is a MONGOMS_DOWNLOAD_DIR user environment variable that also
  // solves this, and it is set on at least one machine — but a user-level
  // variable is invisible to every shell that was already open when it was
  // set, which is exactly how the binary quietly reappeared on C: after
  // being deleted. Setting it HERE makes the redirect a property of the
  // test run rather than of the machine: it works on a fresh clone, in an
  // old terminal, and for anyone who never ran the setup step.
  //
  // Deliberately does not override an explicit value — if someone has
  // pointed this somewhere on purpose, that wins.
  if (!process.env.MONGOMS_DOWNLOAD_DIR) {
    const binaries = path.join(repoVolume, "dev-cache", "mongodb-binaries");
    try {
      fs.mkdirSync(binaries, { recursive: true });
      fs.accessSync(binaries, fs.constants.W_OK);
      process.env.MONGOMS_DOWNLOAD_DIR = binaries;
    } catch {
      // Leave it unset — mongodb-memory-server falls back to its own
      // default, which is the behaviour we had before this file existed.
    }
  }
}
