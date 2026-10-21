// apps/backend/src/scripts/render-cstep-emails.ts
//
// Renders EVERY CSTEP notification email (each event in
// services/cstepNotifications.ts, for every form type it fires on) with
// realistic sample data to HTML + plain-text files for review, plus PNG
// screenshots at desktop width and phone width (390px), a few with images
// OFF, and an index.html listing them. No database, no sending, no stack:
//
//   npx tsx src/scripts/render-cstep-emails.ts [outDir] [--no-png]
//
// Default outDir: <repo>/docs/design/cstep-emails/rendered
//
// Images load from apps/frontend/public/email-assets (file://) so the files
// open locally; in real emails they come from assetBase() (the plumbox host).
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
process.env.FRONTEND_PUBLIC_URL ||= "https://plumbox.plumtrips.com";
process.env.EMAIL_ASSET_BASE ||= pathToFileURL(path.join(repo, "apps/frontend/public/email-assets")).href;

const { renderCstepEmail } = await import("../services/cstepNotifications.js");
type Event = Parameters<typeof renderCstepEmail>[0];

/* ───────────────────────── sample data ───────────────────────── */

const traveller = { firstName: "Arjun", lastName: "Nair" };
const base = { _id: "6ad5418eb9e6491f7fb20001", purpose: "Stakeholder workshop on grid storage" };
const FORMS: Record<string, any> = {
  TOUR_PROPOSAL: { ...base, formType: "TOUR_PROPOSAL", stations: [{ to: "Delhi" }, { to: "Jaipur" }], departureDate: "2026-11-03", returnDate: "2026-11-07", claimReference: "0014/1026" },
  EVENT_REQUEST: { ...base, formType: "EVENT_REQUEST", purpose: "India Energy Storage Week", eventLocation: "New Delhi", departureDate: "2026-11-18", returnDate: "2026-11-20", claimReference: "EVR0031/1026" },
  LOCAL_TRAVEL_CLAIM: { ...base, formType: "LOCAL_TRAVEL_CLAIM", purpose: "Site visits — October", claimTotals: { gross: 4380 }, departureDate: "2026-10-06", returnDate: "2026-10-24", claimReference: "LTC0207/1026" },
  EXPENSE_CLAIM: { ...base, formType: "EXPENSE_CLAIM", purpose: "Workshop materials", claimTotals: { gross: 12650 }, claimReference: "EXP0088/1026" },
};
const TRIP = ["TOUR_PROPOSAL", "EVENT_REQUEST"];
const CLAIMS = ["LOCAL_TRAVEL_CLAIM", "EXPENSE_CLAIM"];
const ALL = [...TRIP, ...CLAIMS];
const MONEY = ["TOUR_PROPOSAL", ...CLAIMS];
// Stands in for the workspace's configured reply-to (real emails: cstepContactEmail(settings)).
const contactEmail = "travel@cstep.in";
const reason = "Please attach the hotel invoice.\nThe return date should be 7 Nov, not 8 Nov.";

// [event, form types it fires on, ctx, variant name]
const CASES: Array<[Event, string[], Record<string, any>, string]> = [
  ["SUBMITTED", ALL, {}, ""],
  ["APPROVED", TRIP, {}, ""],
  ["CLAIM_APPROVED", CLAIMS, {}, ""],
  ["RETURN", ALL, { reason }, ""],
  ["REJECTED", ALL, { reason: "Not within this quarter's travel budget." }, ""],
  ["ARRANGED", TRIP, {}, ""],
  ["REPORT_SUBMITTED", TRIP, {}, ""],
  ["RETURN_REPORT", TRIP, { reason }, ""],
  ["RETURN_TO_OFFICIAL", TRIP, { reason: "Per-diem for 5 Nov is counted twice." }, ""],
  ["RETURN_TO_ADMIN", CLAIMS, { reason: "Two receipts are illegible." }, ""],
  ["TRANSFERRED_TO_FINANCE", MONEY, { amountInr: 8420, direction: "PAY_OUT" }, "payout"],
  ["TRANSFERRED_TO_FINANCE", MONEY, { amountInr: 1500, direction: "COLLECT" }, "collect"],
  ["REIMBURSED", MONEY, { amountInr: 8420, reference: "NEFT-UTR-58213907" }, ""],
  ["SETTLED", MONEY, {}, "nothing-owed"],
  ["SETTLED", MONEY, { amountInr: 1500, direction: "COLLECT", reference: "RCPT-0091" }, "recovered"],
];

/* ───────────────────────── render ───────────────────────── */

const args = process.argv.slice(2);
const noPng = args.includes("--no-png");
const outDir = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(repo, "docs/design/cstep-emails/rendered"));
// Old renders are cleared only from a folder named "rendered" (never a path the caller typed by mistake).
if (path.basename(outDir) === "rendered") fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const rows: string[] = [];
const stems: string[] = [];
/** Shown with images off too: one photo band, one plain band. */
const IMAGES_OFF = new Set(["01-SUBMITTED-TOUR_PROPOSAL", "09-RETURN-TOUR_PROPOSAL"]);

let n = 0;
for (const [event, types, ctx, variant] of CASES) {
  for (const t of types) {
    const r = renderCstepEmail(event, FORMS[t], traveller, { logEntryId: "sample", ...ctx } as any, "CSTEP", contactEmail);
    const stem = `${String(++n).padStart(2, "0")}-${event}${variant ? `-${variant}` : ""}-${t}`;
    fs.writeFileSync(path.join(outDir, `${stem}.html`), r.html);
    fs.writeFileSync(path.join(outDir, `${stem}.txt`), r.text);
    stems.push(stem);
    const shots = noPng
      ? ""
      : `<a href="${esc(stem)}.desktop.png">desktop</a> · <a href="${esc(stem)}.phone.png">phone</a>${IMAGES_OFF.has(stem) ? ` · <a href="${esc(stem)}.images-off.png">images off</a>` : ""}`;
    rows.push(
      `<tr><td><a href="${esc(stem)}.html">${esc(event)}</a>${variant ? `<div class="n">${esc(variant)}</div>` : ""}</td><td>${esc(t)}</td>` +
        `<td>${shots}</td><td><a href="${esc(stem)}.txt">text</a></td><td>${esc(r.subject)}</td></tr>`,
    );
  }
}

fs.writeFileSync(
  path.join(outDir, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>CSTEP emails — rendered</title>
<style>body{font-family:Arial,sans-serif;margin:24px;color:#0f172a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e2e8f0;padding:6px 8px;font-size:13px;text-align:left;vertical-align:top}th{background:#f8fafc}.n{color:#64748b;font-size:11px;margin-top:2px}</style>
</head><body><h1>CSTEP Travel &amp; Claim Portal emails — rendered samples (${n})</h1>
<p>Generated by apps/backend/src/scripts/render-cstep-emails.ts through renderCstepEmail. Images load from the local email-assets folder; real emails load them from the plumbox host.</p>
<table><tr><th>Event</th><th>Form</th><th>Screenshots</th><th>Plain text</th><th>Subject</th></tr>${rows.join("")}</table></body></html>`,
);

console.log(`rendered ${n} → ${path.join(outDir, "index.html")}`);

/* ───────────────────────── screenshots ───────────────────────── */

if (!noPng) {
  const puppeteer = (await import("puppeteer")).default;
  const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chrome,
    args: ["--allow-file-access-from-files", "--renderer-process-limit=1", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    let imagesOff = false;
    await page.setRequestInterception(true);
    page.on("request", (req) => (imagesOff && req.resourceType() === "image" ? req.abort() : req.continue()));
    const shoot = async (stem: string, width: number, suffix: string, noImages = false) => {
      imagesOff = noImages;
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(path.join(outDir, `${stem}.html`)).href, { waitUntil: "load" });
      await page.screenshot({ path: path.join(outDir, `${stem}.${suffix}.png`) as `${string}.png`, fullPage: true });
    };
    for (const stem of stems) {
      await shoot(stem, 680, "desktop");
      await shoot(stem, 390, "phone");
      if (IMAGES_OFF.has(stem)) await shoot(stem, 680, "images-off", true);
    }
  } finally {
    await browser.close();
  }
}
