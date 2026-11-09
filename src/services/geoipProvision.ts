// apps/backend/src/services/geoipProvision.ts
//
// Provisions the MaxMind GeoLite2-City database (.mmdb) — at build time when
// the licence key is available there, otherwise lazily at runtime — and keeps
// it fresh in the background. Same "download a prebuilt artefact once,
// memoize, self-heal lazily" pattern as services/video/ytDlpProvision.ts, for
// the same reason: the App Runner managed nodejs20 runtime has no package
// manager, so anything that isn't an npm dependency has to be fetched by us.
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
// ── WHY LATEST, NOT PINNED (changed 2026-11-09) ───────────────────────────
// This module used to pin one build (20260804) by date + SHA-256. MaxMind
// only serves recent builds, so the pin aged out around the first week of
// September, and every runtime download from then on failed. The failure
// was silent: production bookedFromCity went to 100% `geo_db_unavailable`
// from ISO week 37 to 46 with no log line. A pin that expires turns a
// supply-chain guard into a time bomb.
//
// So the default is now the LATEST build, verified against MaxMind's own
// published `.sha256` sidecar (fail closed: no valid sidecar, no install),
// and refreshed in the background (startGeoipRefresh). The sidecar travels
// the same authenticated channel as the data, so it is a transfer-integrity
// check, not a supply-chain guarantee. That is the accepted trade.
//
// Emergency pin, env only: GEOIP_DB_SHA256 (optionally with GEOIP_DB_DATE)
// forces one exact build and turns the background refresh off. Do not leave
// it set: the same ageing-out applies.
//
// ── EVERY ATTEMPT LOGS ────────────────────────────────────────────────────
// Start, success (build date, size, duration) and failure (HTTP status, URL
// with the licence key removed) are all logged. Never log the key, and never
// put a raw download URL in a log line or an Error: always use describeUrl().
//
// The npm dependency here is `maxmind` (MIT, pure JS, no native build) — the
// READER only. The data itself is this file's job.

import fs from "fs";
import path from "path";
import https from "https";
import crypto from "crypto";
import zlib from "zlib";
import { promisify } from "util";
import { fileURLToPath } from "url";

const gunzip = promisify(zlib.gunzip);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** REQUIRED BY THE GEOLITE2 EULA wherever this data is surfaced to a user. */
export const GEOLITE2_ATTRIBUTION =
  "This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com";

// dist/services/geoipProvision.js -> apps/backend/bin
// Shares the already-gitignored `bin/` directory with yt-dlp: both are
// provisioned artefacts that must never enter git (this one is ~70 MB and
// non-redistributable besides).
export const GEOIP_DIR = path.resolve(__dirname, "../../bin");
export const GEOIP_DB_PATH = path.join(GEOIP_DIR, "GeoLite2-City.mmdb");
/** SHA-256 of the .tar.gz the installed database came from — what the refresh compares. */
export const GEOIP_SHA_PATH = `${GEOIP_DB_PATH}.sha256`;

const EDITION_ID = "GeoLite2-City";

/** Emergency pin, env only — see the header. Empty = latest. */
const PIN_DATE = (process.env.GEOIP_DB_DATE || "").trim();
const PIN_SHA256 = (process.env.GEOIP_DB_SHA256 || "").trim().toLowerCase();

/** Free MaxMind account → "Manage License Keys". Absent = provisioning is a no-op. */
const LICENSE_KEY = (process.env.MAXMIND_LICENSE_KEY || "").trim();

const TAG = "[geoip]";

function downloadUrl(suffix: "tar.gz" | "tar.gz.sha256"): string {
  const u = new URL("https://download.maxmind.com/app/geoip_download");
  u.searchParams.set("edition_id", EDITION_ID);
  u.searchParams.set("license_key", LICENSE_KEY);
  u.searchParams.set("suffix", suffix);
  if (PIN_DATE) u.searchParams.set("date", PIN_DATE);
  return u.toString();
}

/**
 * A URL that is safe to log: host + path + only the harmless parameters.
 *
 * EVERY url that reaches a log line or an Error message goes through this.
 * It drops the licence key, and it also drops the signed query string of the
 * storage redirect MaxMind answers with. Build output and App Runner logs
 * are not a secret store.
 */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    const keep = ["edition_id", "suffix", "date"]
      .filter((k) => u.searchParams.has(k))
      .map((k) => `${k}=${u.searchParams.get(k)}`);
    return `${u.origin}${u.pathname}${keep.length ? `?${keep.join("&")}` : ""}`;
  } catch {
    return "<unparseable url>";
  }
}

class HttpStatusError extends Error {
  constructor(public status: number, url: string) {
    // 401 here is overwhelmingly "bad/absent licence key"; 404 is "that
    // build date was never published or has aged out".
    super(`HTTP ${status} for ${describeUrl(url)}`);
  }
}

function httpGet(url: string, redirectsLeft = 5): Promise<import("http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "plumtrips-hrms-geoip-provision" } }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(httpGet(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new HttpStatusError(status, url));
        return;
      }
      resolve(res);
    });
    // A stalled socket must not hang the refresh forever.
    req.setTimeout(120_000, () => req.destroy(new Error(`timeout for ${describeUrl(url)}`)));
    req.on("error", (e) => reject(new Error(`${e?.message || e} (${describeUrl(url)})`)));
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

/**
 * The hex digest out of a MaxMind `.sha256` sidecar ("<hex>  <filename>"),
 * or null when the body is not one. Null must fail the install: a sidecar we
 * cannot read is not a check that passed.
 */
export function parseSha256Sidecar(body: string): string | null {
  const first = String(body ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "";
  return /^[0-9a-f]{64}$/.test(first) ? first : null;
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
 * INSTALL
 * ──────────────────────────────────────────────────────────────────────── */

async function fetchPublishedSha(): Promise<string> {
  const body = (await download(downloadUrl("tar.gz.sha256"))).toString("utf8");
  const sha = parseSha256Sidecar(body);
  if (!sha) throw new Error("MaxMind's .sha256 sidecar did not contain a SHA-256 digest — refusing to install");
  return sha;
}

/** Proves the file actually parses as an MMDB and answers. Returns its build date. */
async function validateDatabase(dbPath: string): Promise<string> {
  const maxmind = (await import("maxmind")).default;
  const reader = await maxmind.open<any>(dbPath);
  // 8.8.8.8 is present in every GeoLite2-City build. A null here means the
  // file opened but carries no data, which is worse than a parse error
  // because it would degrade silently at request time.
  if (!reader.get("8.8.8.8")) throw new Error("database opened but resolved nothing for 8.8.8.8");
  return describeBuild(reader.metadata);
}

/** "GeoLite2-City build 2026-11-04" from a reader's metadata. */
export function describeBuild(metadata: { databaseType?: string; buildEpoch?: Date } | undefined): string {
  const type = metadata?.databaseType || EDITION_ID;
  const at = metadata?.buildEpoch instanceof Date && !Number.isNaN(metadata.buildEpoch.getTime())
    ? metadata.buildEpoch.toISOString().slice(0, 10)
    : "unknown-date";
  return `${type} build ${at}`;
}

function readInstalledSha(): string | null {
  try {
    return parseSha256Sidecar(fs.readFileSync(GEOIP_SHA_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Download → verify → unpack → validate → atomically swap into place.
 * Logs start, success and failure. Throws on failure; the caller decides
 * whether that matters (it never fails a request).
 */
async function installFromUpstream(reason: "missing" | "refresh", knownSha?: string): Promise<string> {
  const started = Date.now();
  const target = PIN_SHA256 ? `pinned ${PIN_DATE || "date-unset"}` : "latest";
  console.log(`${TAG} download start (${reason}, ${target}) ${describeUrl(downloadUrl("tar.gz"))}`);
  try {
    fs.mkdirSync(GEOIP_DIR, { recursive: true });

    const expected = PIN_SHA256 || knownSha || (await fetchPublishedSha());
    const tarball = await download(downloadUrl("tar.gz"));
    const actual = sha256(tarball);
    if (actual !== expected) {
      throw new Error(
        `SHA-256 mismatch — refusing the download (expected ${expected}, got ${actual}). ` +
          (PIN_SHA256 ? "The env pin is stale or the artefact changed." : "Treating as a corrupt transfer."),
      );
    }

    const member = findMmdbInTar(await gunzip(tarball));
    if (!member) throw new Error("no .mmdb member found in the downloaded archive");

    const tmpPath = `${GEOIP_DB_PATH}.download`;
    fs.writeFileSync(tmpPath, member.data);
    let build: string;
    try {
      build = await validateDatabase(tmpPath);
    } catch (err) {
      // Never leave a half-usable database behind — an unreadable file on
      // disk would satisfy the existsSync() fast path forever.
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
    fs.renameSync(tmpPath, GEOIP_DB_PATH);
    fs.writeFileSync(GEOIP_SHA_PATH, `${actual}\n`);

    console.log(
      `${TAG} download SUCCEEDED (${reason}): ${build} ` +
        `(archive member ${buildDateFromMemberName(member.name) || "?"}), ` +
        `${member.data.length} bytes, ${Date.now() - started} ms, sha256 ${actual.slice(0, 12)}…`,
    );
    return GEOIP_DB_PATH;
  } catch (err: any) {
    const status = err instanceof HttpStatusError ? ` status=${err.status}` : "";
    console.error(
      `${TAG} download FAILED (${reason})${status} after ${Date.now() - started} ms: ${err?.message || err}`,
    );
    throw err;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * PUBLIC API
 * ──────────────────────────────────────────────────────────────────────── */

/** One install at a time — shared by ensure and refresh. */
let installPromise: Promise<string> | null = null;

function runInstall(reason: "missing" | "refresh", knownSha?: string): Promise<string> {
  if (installPromise) return installPromise;
  installPromise = installFromUpstream(reason, knownSha).finally(() => {
    installPromise = null;
  });
  return installPromise;
}

let warnedNoKey = false;

/**
 * Idempotent. Safe to call from the build script (provisions once) and
 * lazily at request time (self-heals if the build step didn't run or the
 * file went missing) without ever re-downloading once present. Freshness is
 * the refresh loop's job, not this function's.
 *
 * Throws when it cannot produce a usable database — callers in the request
 * path must treat that as "geo unavailable", never as a request failure. See
 * location.service.ts, which does exactly that.
 */
export async function ensureGeoipDatabase(): Promise<string> {
  if (fs.existsSync(GEOIP_DB_PATH)) return GEOIP_DB_PATH;

  if (!LICENSE_KEY) {
    const msg =
      "MAXMIND_LICENSE_KEY is not set — no database to download. " +
      "Create a free MaxMind account, generate a licence key, and set MAXMIND_LICENSE_KEY.";
    if (!warnedNoKey) {
      warnedNoKey = true;
      console.warn(`${TAG} ${msg}`);
    }
    throw new Error(`geoip provisioning: ${msg}`);
  }

  return runInstall("missing");
}

/** True when a database is already on disk — no download, no promise. */
export function isGeoipDatabasePresent(): boolean {
  return fs.existsSync(GEOIP_DB_PATH);
}

type UpdateListener = () => void;
const listeners = new Set<UpdateListener>();

/** Called after a refresh swaps a NEW database into place (reader reload). */
export function onGeoipDatabaseUpdated(fn: UpdateListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export type RefreshOutcome = "updated" | "current" | "skipped" | "failed";

/**
 * One refresh check: compare MaxMind's published SHA-256 for the latest
 * build with the one we installed; download only when they differ. Never
 * throws. Logs every outcome except "skipped" (which logs once).
 */
export async function checkForGeoipUpdate(): Promise<RefreshOutcome> {
  if (!LICENSE_KEY || PIN_SHA256) return "skipped";
  if (installPromise) return "skipped"; // an install is already running
  try {
    const published = await fetchPublishedSha();
    const installed = fs.existsSync(GEOIP_DB_PATH) ? readInstalledSha() : null;
    if (installed === published) {
      console.log(`${TAG} refresh check: current (sha256 ${published.slice(0, 12)}…)`);
      return "current";
    }
    await runInstall("refresh", published);
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* a listener must not break the refresh */
      }
    }
    return "updated";
  } catch (err: any) {
    // installFromUpstream already logged its own failure; this covers the
    // sidecar fetch failing before any install started.
    console.error(`${TAG} refresh check FAILED: ${err?.message || err}`);
    return "failed";
  }
}

let refreshTimer: NodeJS.Timeout | null = null;

/**
 * Background refresh. MaxMind publishes GeoLite2 twice a week; the default
 * 12 h check costs one tiny sidecar request per instance when nothing
 * changed. The first check runs `firstDelayMs` after boot, which also
 * replaces an on-disk database that predates this code (no .sha256 file).
 * Timers are unref'd so they never hold the process open.
 */
export function startGeoipRefresh(
  opts: { intervalMs?: number; firstDelayMs?: number } = {},
): void {
  if (refreshTimer) return;
  if (!LICENSE_KEY) return; // ensureGeoipDatabase already says why, once
  if (PIN_SHA256) {
    console.warn(`${TAG} GEOIP_DB_SHA256 is set — pinned build, background refresh OFF. Unset it once the emergency is over.`);
    return;
  }
  const hours = Number(process.env.GEOIP_REFRESH_HOURS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3600_000;
  const first = setTimeout(() => void checkForGeoipUpdate(), opts.firstDelayMs ?? 5 * 60_000);
  first.unref?.();
  refreshTimer = setInterval(() => void checkForGeoipUpdate(), intervalMs);
  refreshTimer.unref?.();
  console.log(`${TAG} background refresh every ${Math.round(intervalMs / 3600_000)} h`);
}

// `node dist/services/geoipProvision.js` — invoked as a build step
// (apps/backend/package.json `build`). Non-fatal by design, exactly like
// ytDlpProvision: a deploy must not fail because a geo database could not be
// fetched. On App Runner the key is runtime-only, so this step logs the
// "not set" line on every build; the runtime download (server.ts boot warm)
// is the one that matters.
const isMainModule = process.argv[1] && process.argv[1].endsWith("geoipProvision.js");
if (isMainModule) {
  ensureGeoipDatabase()
    .then((p) => console.log(`${TAG} GeoLite2-City ready at`, p))
    .catch((err) => {
      console.warn(
        `${TAG} provisioning failed at build time (non-fatal — the runtime download at boot ` +
          `will retry): ${err?.message || err}`,
      );
    });
}
