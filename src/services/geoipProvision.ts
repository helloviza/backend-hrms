// apps/backend/src/services/geoipProvision.ts
//
// Provisions the MaxMind GeoLite2-City database (.mmdb) at BUILD time — the
// same "download a prebuilt artefact once, memoize, self-heal lazily" pattern
// as services/video/ytDlpProvision.ts, for the same reason: the App Runner
// managed nodejs20 runtime has no package manager, so anything that isn't an
// npm dependency has to be fetched by us.
//
// ─────────────────────────────────────────────────────────────────────────
// ATTRIBUTION (REQUIRED BY THE GEOLITE2 EULA — DO NOT REMOVE)
//
//   This product includes GeoLite2 data created by MaxMind, available from
//   https://www.maxmind.com
//
// The GeoLite2 End User Licence requires this notice wherever the data is
// used. Exported as GEOLITE2_ATTRIBUTION below so any surface that ever
// renders a resolved city can carry it without re-deriving the wording.
// ─────────────────────────────────────────────────────────────────────────
//
// WHY NOT AN NPM PACKAGE OF THE DATA: the .mmdb is ~60-80 MB and is
// re-published twice weekly under a licence that forbids redistribution.
// Every package that claims to bundle it is either stale or in breach. The
// only supported route is the authenticated MaxMind download endpoint, which
// is what this module speaks.
//
// WHY PINNED: an unpinned "always latest" download makes every build
// non-reproducible and gives a compromised or mis-published upstream a direct
// path into production. PINNED_BUILD_DATE + PINNED_SHA256 make the artefact
// byte-identical across builds and make tampering a hard failure rather than
// a silent one. See "PINNING" below for how to fill them in the first time.
//
// The npm dependency here is `maxmind` (MIT, pure JS, no native build) — the
// READER only. The data itself is this file's job.

import fs from "fs";
import path from "path";
import https from "https";
import crypto from "crypto";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** REQUIRED BY THE GEOLITE2 EULA wherever this data is surfaced to a user. */
export const GEOLITE2_ATTRIBUTION =
  "This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com";

// dist/services/geoipProvision.js -> apps/backend/bin
// Shares the already-gitignored `bin/` directory with yt-dlp: both are
// build-time-provisioned artefacts that must never enter git (this one is
// ~70 MB and non-redistributable besides).
export const GEOIP_DIR = path.resolve(__dirname, "../../bin");
export const GEOIP_DB_PATH = path.join(GEOIP_DIR, "GeoLite2-City.mmdb");

const EDITION_ID = "GeoLite2-City";

/* ────────────────────────────────────────────────────────────────────────
 * PINNING
 *
 * Both constants start EMPTY because the values cannot be invented — they
 * have to come from a real MaxMind build. Bootstrapping is one build:
 *
 *   1. Set MAXMIND_LICENSE_KEY (free account → Manage License Keys).
 *   2. Run `node dist/services/geoipProvision.js` (or just `pnpm build`).
 *   3. It downloads the LATEST build, verifies it against MaxMind's own
 *      published .sha256 sidecar, and prints a copy-pasteable block:
 *        [geoipProvision] UNPINNED — to pin this exact build, set:
 *          PINNED_BUILD_DATE = "20260804"
 *          PINNED_SHA256     = "9f2c…"
 *   4. Paste those two values in here and commit. From then on the download
 *      is byte-reproducible and any drift is a hard failure.
 *
 * Env vars of the same name override the constants — useful for rolling a
 * pin forward on App Runner without a code deploy, NOT a substitute for
 * committing the pin.
 * ──────────────────────────────────────────────────────────────────────── */

/** MaxMind build date, `YYYYMMDD`. Empty = latest (UNPINNED — see above). */
const PINNED_BUILD_DATE = "";
/** Lowercase hex SHA-256 of the .tar.gz. Empty = unpinned (see above). */
const PINNED_SHA256 = "";

const BUILD_DATE = (process.env.GEOIP_DB_DATE || PINNED_BUILD_DATE).trim();
const EXPECTED_SHA256 = (process.env.GEOIP_DB_SHA256 || PINNED_SHA256).trim().toLowerCase();

/** Free MaxMind account → "Manage License Keys". Absent = provisioning is a no-op. */
const LICENSE_KEY = (process.env.MAXMIND_LICENSE_KEY || "").trim();

function downloadUrl(suffix: "tar.gz" | "tar.gz.sha256"): string {
  const u = new URL("https://download.maxmind.com/app/geoip_download");
  u.searchParams.set("edition_id", EDITION_ID);
  u.searchParams.set("license_key", LICENSE_KEY);
  u.searchParams.set("suffix", suffix);
  if (BUILD_DATE) u.searchParams.set("date", BUILD_DATE);
  return u.toString();
}

/**
 * The licence key stripped out of any URL.
 *
 * EVERY url that reaches a log line or an Error message goes through this.
 * Build output is not a secret store — App Runner keeps it, and a key pasted
 * into a failing build's log is a key that has to be rotated.
 */
function redact(url: string): string {
  return url.replace(/license_key=[^&]*/, "license_key=***");
}

/** Same URL with the key redacted — safe to put in a log line or an error. */
function safeUrl(suffix: "tar.gz" | "tar.gz.sha256"): string {
  return redact(downloadUrl(suffix));
}

function httpGet(url: string, redirectsLeft = 5): Promise<import("http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "plumtrips-hrms-geoip-provision" } }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(httpGet(res.headers.location, redirectsLeft - 1));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          // 401 here is overwhelmingly "bad/absent licence key"; 404 is
          // "that build date was never published or has aged out".
          reject(new Error(`geoip provisioning: HTTP ${status} for ${redact(url)}`));
          return;
        }
        resolve(res);
      })
      .on("error", reject);
  });
}

async function download(url: string): Promise<Buffer> {
  const res = await httpGet(url);
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/* ────────────────────────────────────────────────────────────────────────
 * TAR
 *
 * MaxMind ships a .tar.gz whose single interesting member is
 * `GeoLite2-City_<date>/GeoLite2-City.mmdb`. zlib is a Node built-in; tar is
 * a 512-byte-block format simple enough to walk directly, which keeps this
 * dependency-free in the same spirit as ytDlpProvision.
 * ──────────────────────────────────────────────────────────────────────── */

function tarString(header: Buffer, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("ascii");
}

/**
 * The first regular-file member whose name ends in `.mmdb`, plus its path.
 *
 * Exported because this is the one piece of hand-rolled binary parsing in the
 * module, and a silent off-by-512 here would produce a corrupt database that
 * still writes to disk. geoipProvision.test.ts builds real tar buffers to
 * pin the block arithmetic down.
 */
export function findMmdbInTar(tar: Buffer): { name: string; data: Buffer } | null {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    // Two consecutive zero blocks end the archive; one is enough to stop on.
    if (header.every((b) => b === 0)) break;

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const full = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(tarString(header, 124, 12).trim() || "0", 8) || 0;
    // '0' and NUL both mean "regular file"; 'L'/'x' etc. are metadata members.
    const typeFlag = String.fromCharCode(header[156]);

    const dataStart = off + 512;
    if ((typeFlag === "0" || typeFlag === "\0") && full.endsWith(".mmdb")) {
      return { name: full, data: tar.subarray(dataStart, dataStart + size) };
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** The `20260804` out of `GeoLite2-City_20260804/GeoLite2-City.mmdb`. */
export function buildDateFromMemberName(name: string): string | null {
  const m = /_(\d{8})\//.exec(name);
  return m ? m[1] : null;
}

/* ────────────────────────────────────────────────────────────────────────
 * PROVISIONING
 * ──────────────────────────────────────────────────────────────────────── */

async function verifySha(tarball: Buffer, actual: string): Promise<void> {
  if (EXPECTED_SHA256) {
    if (actual !== EXPECTED_SHA256) {
      throw new Error(
        `geoip provisioning: SHA-256 mismatch — refusing the download. ` +
          `expected ${EXPECTED_SHA256}, got ${actual}. ` +
          `Either the pin is stale (MaxMind ages builds out) or the artefact is not what we pinned.`,
      );
    }
    return;
  }

  // UNPINNED. MaxMind's own sidecar is not a supply-chain guarantee — it
  // travels the same channel as the data — but it does catch a truncated or
  // corrupted transfer, which is the failure this path can still detect.
  const sidecar = (await download(downloadUrl("tar.gz.sha256"))).toString("utf8").trim();
  const published = (sidecar.split(/\s+/)[0] || "").toLowerCase();
  if (published && published !== actual) {
    throw new Error(
      `geoip provisioning: download does not match MaxMind's published SHA-256 ` +
        `(published ${published}, got ${actual}) — treating as a corrupt transfer.`,
    );
  }
}

/** Proves the file we just wrote actually parses as an MMDB and answers. */
async function validateDatabase(dbPath: string): Promise<void> {
  const maxmind = (await import("maxmind")).default;
  const reader = await maxmind.open<any>(dbPath);
  // 8.8.8.8 is present in every GeoLite2-City build. A null here means the
  // file opened but carries no data, which is worse than a parse error
  // because it would degrade silently at request time.
  const probe = reader.get("8.8.8.8");
  if (!probe) throw new Error("geoip provisioning: database opened but resolved nothing for 8.8.8.8");
}

let ensurePromise: Promise<string> | null = null;

/**
 * Idempotent, memoized. Safe to call from the build script (provisions once)
 * and lazily at request time (self-heals if the build step didn't run or the
 * file went missing) without ever re-downloading once present.
 *
 * Throws when it cannot produce a usable database — callers in the request
 * path must treat that as "geo unavailable", never as a request failure. See
 * location.service.ts, which does exactly that.
 */
export function ensureGeoipDatabase(): Promise<string> {
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    if (fs.existsSync(GEOIP_DB_PATH)) {
      return GEOIP_DB_PATH;
    }

    if (!LICENSE_KEY) {
      throw new Error(
        "geoip provisioning: MAXMIND_LICENSE_KEY is not set — no database to download. " +
          "Create a free MaxMind account, generate a licence key, and set MAXMIND_LICENSE_KEY.",
      );
    }

    fs.mkdirSync(GEOIP_DIR, { recursive: true });

    const tarball = await download(downloadUrl("tar.gz"));
    const actualSha = sha256(tarball);
    await verifySha(tarball, actualSha);

    const tar = zlib.gunzipSync(tarball);
    const member = findMmdbInTar(tar);
    if (!member) throw new Error("geoip provisioning: no .mmdb member found in the downloaded archive");

    const tmpPath = `${GEOIP_DB_PATH}.download`;
    fs.writeFileSync(tmpPath, member.data);
    try {
      await validateDatabase(tmpPath);
    } catch (err) {
      // Never leave a half-usable database behind — an unreadable file on
      // disk would satisfy the existsSync() fast path above forever.
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
    fs.renameSync(tmpPath, GEOIP_DB_PATH);

    if (!EXPECTED_SHA256) {
      const resolvedDate = buildDateFromMemberName(member.name) || "<see MaxMind>";
      console.warn(
        `[geoipProvision] UNPINNED — this build fetched whatever MaxMind was serving.\n` +
          `  To pin it, set these two constants in src/services/geoipProvision.ts:\n` +
          `    const PINNED_BUILD_DATE = "${resolvedDate}";\n` +
          `    const PINNED_SHA256 = "${actualSha}";`,
      );
    }

    return GEOIP_DB_PATH;
  })().catch((err) => {
    // Don't poison future calls with a rejected memo — let the next caller
    // retry (the request path self-heals if the build step was skipped).
    ensurePromise = null;
    throw err;
  });

  return ensurePromise;
}

/** True when a database is already on disk — no download, no promise. */
export function isGeoipDatabasePresent(): boolean {
  return fs.existsSync(GEOIP_DB_PATH);
}

// `node dist/services/geoipProvision.js` — invoked as a build step
// (apps/backend/package.json `build`). Non-fatal by design, exactly like
// ytDlpProvision: a deploy must not fail because a geo database could not be
// fetched. Location resolution degrades to `source: "unresolved"` and no
// caller changes behaviour, because in Phase 1 there are no callers at all.
const isMainModule = process.argv[1] && process.argv[1].endsWith("geoipProvision.js");
if (isMainModule) {
  ensureGeoipDatabase()
    .then((p) => console.log("[geoipProvision] GeoLite2-City ready at", p))
    .catch((err) => {
      console.warn(
        `[geoipProvision] provisioning failed at build time (non-fatal — location resolution ` +
          `will report "unresolved" until this is fixed): ${err?.message || err}\n` +
          `  url: ${safeUrl("tar.gz")}`,
      );
    });
}
