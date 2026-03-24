import { readdir, readFile, writeFile, mkdir, access, rm } from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import archiver from "archiver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "../../logs/tbo");
const AUTH_DIR = path.join(LOG_DIR, "auth");
const CALENDAR_DIR = path.join(LOG_DIR, "calendar");
const CERT_DIR = path.join(LOG_DIR, "certification");

/** Methods we consolidate from the traceId folder */
const TRACE_METHODS = [
  "PriceRBD",
  "FareQuote",
  "FareRule",
  "SSR",
  "Book",
  "Ticket",
  "GetBookingDetails",
] as const;

/** Methods that should be filtered by BookingId when OB/IB share a traceId */
const BOOKING_FILTERED_METHODS: string[] = ["Ticket", "GetBookingDetails"];

/**
 * Convert a JSON log file to TBO certification .txt format:
 *
 *   Request :
 *
 *   {json}
 *
 *   Response:
 *
 *   {json}
 */
function toTBOTextFormat(content: { request?: unknown; response?: unknown }): string {
  const req = JSON.stringify(content.request ?? {}, null, 2);
  const res = JSON.stringify(content.response ?? {}, null, 2);
  return `Request :\n\n${req}\n\nResponse:\n\n${res}`;
}

/**
 * Extract an ISO timestamp from a log filename.
 * Filenames look like: Method_2026-03-16T10-30-00-000Z.json
 * We restore the colons and dot to get a parseable ISO string.
 */
function tsFromFilename(fname: string): Date | null {
  const base = fname.replace(/\.json$/, "");
  const idx = base.indexOf("_");
  if (idx < 0) return null;
  const raw = base.slice(idx + 1);
  // 2026-03-16T10-30-00-000Z → 2026-03-16T10:30:00.000Z
  const iso = raw.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    "$1:$2:$3.$4",
  );
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Consolidate trace method logs from a single traceId folder.
 * Writes flat files to `outDir` with an optional suffix (e.g. " OB", " IB")
 * appended before the .txt extension.
 *
 * When `bookingId` is provided, Ticket and GetBookingDetails files are filtered
 * so only the file whose response.Response.FlightItinerary.BookingId matches is
 * copied. This handles the case where OB and IB legs share the same traceId
 * folder — each leg's consolidation picks only its own Ticket/GBD.
 * FareQuote, FareRule, SSR, Book are shared and always copied.
 */
async function consolidateLeg(
  traceId: string,
  outDir: string,
  suffix: string,
  bookingId?: number,
  /** For return trips where OB/IB share a traceId: 0 = pick first file, 1 = pick second file */
  fileIndex: number = 0,
): Promise<{ writtenFiles: string[]; fareQuoteTs: Date | null }> {
  const traceDir = path.join(LOG_DIR, traceId);
  try { await access(traceDir); } catch { return { writtenFiles: [], fareQuoteTs: null }; }

  await mkdir(outDir, { recursive: true });

  const traceFiles = (await readdir(traceDir)).filter(f => f.endsWith(".json")).sort();
  const writtenFiles: string[] = [];

  // For fareQuoteTs, pick the file matching our fileIndex
  let fareQuoteTs: Date | null = null;
  const fqFiles = traceFiles.filter(f => f.startsWith("FareQuote_"));
  const fqTarget = fqFiles[fileIndex] ?? fqFiles[0];
  if (fqTarget) fareQuoteTs = tsFromFilename(fqTarget);

  for (const method of TRACE_METHODS) {
    const txtName = suffix ? `${method} ${suffix}.txt` : `${method}.txt`;

    // When bookingId is provided, filter Ticket/GBD by BookingId
    if (bookingId && BOOKING_FILTERED_METHODS.includes(method)) {
      const candidates = traceFiles.filter(f => f.startsWith(`${method}_`));
      if (candidates.length === 0) continue;

      let found = false;
      for (const fname of candidates) {
        const content = JSON.parse(await readFile(path.join(traceDir, fname), "utf-8"));

        // Ticket: response.Response.Response.FlightItinerary.BookingId
        //     or: response.Response.BookingId / response.Response.Response.BookingId
        // GBD:   response.Response.FlightItinerary.BookingId
        //    or: response.BookingId
        const fileBookingId = method === "Ticket"
          ? (content?.response?.Response?.Response?.FlightItinerary?.BookingId
            ?? content?.response?.Response?.BookingId
            ?? content?.response?.Response?.Response?.BookingId)
          : (content?.response?.Response?.FlightItinerary?.BookingId
            ?? content?.response?.BookingId);

        if (fileBookingId === bookingId) {
          console.log(`[CERT] Copying: ${fname} → ${outDir} (as ${txtName})`);
          await writeFile(path.join(outDir, txtName), toTBOTextFormat(content), "utf-8");
          writtenFiles.push(txtName);
          found = true;
          break;
        }
      }
      // Fallback: if only one file exists (no ambiguity), use it anyway
      if (!found && candidates.length === 1) {
        const content = JSON.parse(await readFile(path.join(traceDir, candidates[0]), "utf-8"));
        console.log(`[CERT] Copying (fallback): ${candidates[0]} → ${outDir} (as ${txtName})`);
        await writeFile(path.join(outDir, txtName), toTBOTextFormat(content), "utf-8");
        writtenFiles.push(txtName);
      }
      continue;
    }

    // For non-booking-filtered methods (FareQuote, FareRule, SSR, Book):
    // When multiple files exist (OB + IB called in parallel), use fileIndex to pick the correct one
    const candidates = traceFiles.filter(f => f.startsWith(`${method}_`));
    if (candidates.length === 0) continue;

    const match = candidates[fileIndex] ?? candidates[0];
    const content = JSON.parse(await readFile(path.join(traceDir, match), "utf-8"));
    console.log(`[CERT] Copying: ${match} → ${outDir} (as ${txtName})`);
    await writeFile(path.join(outDir, txtName), toTBOTextFormat(content), "utf-8");
    writtenFiles.push(txtName);
  }

  return { writtenFiles, fareQuoteTs };
}

/**
 * Time-match Search log from auth/ and write it to outDir.
 * Returns the filename written, or null if no match.
 */
async function consolidateSearch(fareQuoteTs: Date, outDir: string): Promise<string | null> {
  let authFiles: string[];
  try { authFiles = (await readdir(AUTH_DIR)).filter(f => f.endsWith(".json")).sort(); } catch { return null; }

  let bestFile: string | null = null;
  let bestDiff = Infinity;

  for (const fname of authFiles) {
    if (!fname.startsWith("Search_")) continue;
    const ts = tsFromFilename(fname);
    if (!ts) continue;
    const diff = fareQuoteTs.getTime() - ts.getTime();
    if (diff >= 0 && diff < 15 * 60_000 && diff < bestDiff) {
      bestDiff = diff;
      bestFile = fname;
    }
  }

  if (!bestFile) return null;

  const content = JSON.parse(await readFile(path.join(AUTH_DIR, bestFile), "utf-8"));
  const txtName = "Search.txt";
  await writeFile(path.join(outDir, txtName), toTBOTextFormat(content), "utf-8");
  return txtName;
}

/**
 * Read the most recent GetCalendarFare log from logs/tbo/calendar/.
 * Returns { request, response } or null if no log exists.
 */
async function getLastCalendarFareLog(): Promise<{ request: unknown; response: unknown } | null> {
  try {
    const files = (await readdir(CALENDAR_DIR))
      .filter(f => f.startsWith("GetCalendarFare_") && f.endsWith(".json"))
      .sort();
    if (files.length === 0) return null;
    const latest = files[files.length - 1];
    const content = JSON.parse(await readFile(path.join(CALENDAR_DIR, latest), "utf-8"));
    return content as { request: unknown; response: unknown };
  } catch {
    return null;
  }
}

/**
 * Create a zip archive of the given directory.
 * Writes to `${dirPath}.zip`, overwriting if it already exists.
 */
async function zipDirectory(dirPath: string): Promise<string> {
  const zipPath = `${dirPath}.zip`;
  const output = createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  const done = new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
  });

  archive.pipe(output);
  archive.directory(dirPath, path.basename(dirPath));
  await archive.finalize();
  await done;

  return zipPath;
}

/**
 * Consolidate TBO certification logs into a single folder ready to zip and send.
 *
 * 1. Reads all JSON logs from logs/tbo/{traceId}/
 * 2. Time-matches the Search log from logs/tbo/auth/
 * 3. Converts each to TBO's required .txt format
 * 4. Writes to logs/tbo/certification/{caseLabel}/
 * 5. Creates logs/tbo/certification/{caseLabel}.zip
 *
 * For return trips, files are written flat with OB/IB suffix:
 *   FareQuote OB.txt, FareQuote IB.txt, Ticket OB.txt, etc.
 * For one-way trips, files are flat without suffix:
 *   FareQuote.txt, Ticket.txt, etc.
 *
 * If the folder already exists it is removed first so we always
 * get a clean, up-to-date consolidation.
 *
 * Fire-and-forget — never throws.
 */
export async function consolidateCertificationLogs(
  traceId: string,
  bookingId: number,
  pnr: string,
  caseLabel: string,
  returnLeg?: {
    traceId: string;
    bookingId: number;
    pnr: string;
  },
): Promise<void> {
  try {
    const rootDir = path.join(CERT_DIR, caseLabel);

    // Overwrite: remove existing folder so we always get the latest
    try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
    await mkdir(rootDir, { recursive: true });

    // Prepend GetCalendarFare log (Case 9 cert requirement) — skip silently if absent
    const calendarLog = await getLastCalendarFareLog();
    const calendarFiles: string[] = [];
    if (calendarLog) {
      const calTxtName = "GetCalendarFare.txt";
      await writeFile(path.join(rootDir, calTxtName), toTBOTextFormat(calendarLog), "utf-8");
      calendarFiles.push(calTxtName);
    }

    if (returnLeg) {
      // ── Return trip: flat files with OB/IB suffix at root ──
      // When OB and IB share the same traceId, use fileIndex to pick the correct file
      // (FareQuote/SSR are called in parallel and produce two files in the same folder)
      const sameTrace = traceId === returnLeg.traceId;
      const [ob, ib] = await Promise.all([
        consolidateLeg(traceId, rootDir, "OB", bookingId, 0),
        consolidateLeg(returnLeg.traceId, rootDir, "IB", returnLeg.bookingId, sameTrace ? 1 : 0),
      ]);

      const allFiles: string[] = [...calendarFiles, ...ob.writtenFiles, ...ib.writtenFiles];

      // Shared Search.txt at root (use OB fareQuote timestamp, fall back to IB)
      const fqTs = ob.fareQuoteTs ?? ib.fareQuoteTs;
      if (fqTs) {
        const searchFile = await consolidateSearch(fqTs, rootDir);
        if (searchFile) allFiles.push(searchFile);
      }

      const summary = {
        caseLabel,
        outbound: { traceId, bookingId, pnr },
        inbound: { traceId: returnLeg.traceId, bookingId: returnLeg.bookingId, pnr: returnLeg.pnr },
        consolidatedAt: new Date().toISOString(),
        files: allFiles,
      };
      await writeFile(
        path.join(rootDir, "_summary.json"),
        JSON.stringify(summary, null, 2),
        "utf-8",
      );
    } else {
      // ── One-way: flat structure, no suffix ──
      const { writtenFiles, fareQuoteTs } = await consolidateLeg(traceId, rootDir, "");

      if (fareQuoteTs) {
        const searchFile = await consolidateSearch(fareQuoteTs, rootDir);
        if (searchFile) writtenFiles.push(searchFile);
      }

      const summary = {
        caseLabel,
        traceId,
        bookingId,
        pnr,
        consolidatedAt: new Date().toISOString(),
        files: [...calendarFiles, ...writtenFiles],
      };
      await writeFile(
        path.join(rootDir, "_summary.json"),
        JSON.stringify(summary, null, 2),
        "utf-8",
      );
    }

    // Auto-create zip of the certification folder
    await zipDirectory(rootDir);
  } catch {
    // Silently swallow — consolidation must never break the booking flow
  }
}

/** Hotel methods we consolidate from the traceId folder */
const HOTEL_TRACE_METHODS = [
  "HotelSearch",
  "HotelPreBook",
  "HotelBook",
  "HotelGetBookingDetail",
] as const;

/**
 * Consolidate TBO hotel certification logs into a single folder ready to zip and send.
 *
 * 1. Reads JSON logs from logs/tbo/{traceId}/
 * 2. Converts each to TBO's required .txt format
 * 3. Writes to logs/tbo/certification/{caseLabel}/
 * 4. Creates logs/tbo/certification/{caseLabel}.zip
 *
 * For HotelSearch, picks only the first batch file (batch0) if multiple exist.
 *
 * Fire-and-forget — never throws.
 */
export async function consolidateHotelCertificationLogs(
  traceId: string,
  bookingId: number,
  confirmationNo: string,
  caseLabel: string,
): Promise<void> {
  try {
    const rootDir = path.join(CERT_DIR, caseLabel);

    // Overwrite: remove existing folder so we always get the latest
    try { await rm(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
    await mkdir(rootDir, { recursive: true });

    const traceDir = path.join(LOG_DIR, traceId);
    let traceFiles: string[];
    try {
      traceFiles = (await readdir(traceDir)).filter(f => f.endsWith(".json")).sort();
    } catch {
      traceFiles = [];
    }

    const writtenFiles: string[] = [];

    for (const method of HOTEL_TRACE_METHODS) {
      const candidates = traceFiles.filter(f => f.startsWith(`${method}_`));
      if (candidates.length === 0) continue;

      // For multi-batch searches, pick only the first file
      const match = candidates[0];
      const content = JSON.parse(await readFile(path.join(traceDir, match), "utf-8"));
      const txtName = `${method}.txt`;
      console.log(`[CERT] Copying: ${match} → ${rootDir} (as ${txtName})`);
      await writeFile(path.join(rootDir, txtName), toTBOTextFormat(content), "utf-8");
      writtenFiles.push(txtName);
    }

    const summary = {
      caseLabel,
      traceId,
      bookingId,
      confirmationNo,
      consolidatedAt: new Date().toISOString(),
      files: writtenFiles,
    };
    await writeFile(
      path.join(rootDir, "_summary.json"),
      JSON.stringify(summary, null, 2),
      "utf-8",
    );

    // Auto-create zip of the certification folder
    await zipDirectory(rootDir);
  } catch {
    // Silently swallow — consolidation must never break the booking flow
  }
}
