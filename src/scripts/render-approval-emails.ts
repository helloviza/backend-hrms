// apps/backend/src/scripts/render-approval-emails.ts
//
// Renders EVERY approval-flow email (each event in services/approvalEmails/
// map.ts) with realistic sample data to HTML files for review, plus PNG
// screenshots at desktop width and phone width (390px), a few with images
// OFF, and an index.html listing them with their recipients from the map.
// No database, no sending, no preview stack:
//
//   npx tsx src/scripts/render-approval-emails.ts [outDir] [--no-png]
//
// Default outDir: <repo>/docs/design/approval-emails/rendered
//
// Samples:
//   flow2/    every Flow 2 event — mixed request: round-trip flight with a
//             picked flight + hotel + visa
//   flow3/    every Flow 3 event — multi-city flight + forex
//   variants/ "approval needed" and "booked" for each request shape: round
//             trip with a picked flight, hotel only, visa only, multi-city,
//             mixed, and one each of cab / forex / eSIM / holiday / MICE
//
// Images load from apps/frontend/public/email-assets (file://) so the files
// open locally; in real emails they come from https://plumbox.plumtrips.com/email-assets.
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
process.env.FRONTEND_PUBLIC_URL ||= "https://plumbox.plumtrips.com";
process.env.EMAIL_ASSET_BASE ||= pathToFileURL(path.join(repo, "apps/frontend/public/email-assets")).href;

const { APPROVAL_EMAIL_MAP, ROLE_LABEL } = await import("../services/approvalEmails/map.js");
const { renderApprovalEmail } = await import("../services/approvalEmails/templates.js");
type Ctx = Parameters<typeof renderApprovalEmail>[1];
type Event = Parameters<typeof renderApprovalEmail>[0];

const NOW = new Date("2026-10-05T04:30:00Z"); // 10:00 IST

/* ───────────────────────── sample data ───────────────────────── */

const asha = { kind: "self", firstName: "Asha", lastName: "Rao", passportNumber: "XXXX4821" };
const rohan = { kind: "manual", firstName: "Rohan", lastName: "Iyer", passportNumber: "XXXX0937" };
const karan = { kind: "self", firstName: "Karan", lastName: "Shah", passportNumber: "XXXX7710" };
const pair = [asha, rohan];

const seg = (airlineName: string, airlineCode: string, flightNumber: string, from: [string, string], to: [string, string], dep: string, arr: string) => ({
  airlineName, airlineCode, flightNumber,
  from: { code: from[0], city: from[1], terminal: "" },
  to: { code: to[0], city: to[1], terminal: "" },
  departAt: dep, arriveAt: arr, durationMin: 0, layoverMin: 0, cabin: "Economy", baggage: { checkIn: "15 kg", cabin: "7 kg" },
});

const roundTripPicked = {
  type: "flight",
  title: "BLR → BOM",
  qty: 2,
  meta: {
    origin: "BLR", destination: "BOM", departDate: "2026-10-12", returnDate: "2026-10-14", tripType: "roundtrip",
    cabinClass: "Economy", preferredTime: "Morning (8am–12pm)", adults: 2, travellers: pair,
    selection: {
      kind: "flight", optionRef: "x", tripKind: "RT_DOM", searchedAt: "2026-10-05T04:00:00Z",
      legs: [
        { direction: "out", stopCount: 0, journeyMin: 135, refundable: true, isLCC: true, productLabel: "Saver", seatsLeft: 9,
          segments: [seg("IndiGo", "6E", "2134", ["BLR", "Bengaluru"], ["BOM", "Mumbai"], "2026-10-12T06:10:00", "2026-10-12T08:25:00")] },
        { direction: "back", stopCount: 0, journeyMin: 110, refundable: true, isLCC: true, productLabel: "Saver", seatsLeft: 4,
          segments: [seg("IndiGo", "6E", "5318", ["BOM", "Mumbai"], ["BLR", "Bengaluru"], "2026-10-14T19:40:00", "2026-10-14T21:30:00")] },
      ],
    },
  },
};
const hotelMumbai = {
  type: "hotel",
  title: "Trident Bandra Kurla · 2 nights",
  qty: 2,
  meta: {
    city: "Mumbai", hotelName: "Trident Bandra Kurla", checkIn: "2026-10-12", checkOut: "2026-10-14", rooms: 2, adults: 2,
    roomType: "Deluxe", mealPlan: "Breakfast", starRating: "5 Star", travellers: pair,
  },
};
const visaUae = {
  type: "visa",
  title: "United Arab Emirates visa",
  qty: 2,
  meta: {
    destinationCountry: "United Arab Emirates", destinationCountryCode: "AE", visaType: "eVisa", purpose: "Business",
    travelDate: "2026-10-20", returnDate: "2026-10-24", processingSpeed: "Express", travelers: 2, travellers: pair,
  },
};
const multiCity = {
  type: "flight",
  title: "DEL → DXB → LHR → DEL",
  qty: 1,
  meta: {
    tripType: "multicity", cabinClass: "Business", adults: 1, travellers: [karan],
    legs: [
      { origin: "DEL", destination: "DXB", date: "2026-10-20" },
      { origin: "DXB", destination: "LHR", date: "2026-10-23" },
      { origin: "LHR", destination: "DEL", date: "2026-10-27" },
    ],
    origin: "DEL", destination: "DEL", departDate: "2026-10-20",
  },
};
const forexAed = {
  type: "forex",
  title: "AED 3000 forex",
  qty: 1,
  meta: { currency: "AED", amount: 3000, deliveryMode: "Forex Card", city: "New Delhi", requiredBy: "2026-10-18", purpose: "Business travel", travellers: [karan] },
};
const cabPune = {
  type: "cab", title: "Mumbai Airport → Pune", qty: 1,
  meta: { tripType: "oneway", pickup: "Mumbai Airport T2", drop: "Hinjewadi, Pune", city: "Mumbai", pickupDate: "2026-10-12", vehicleType: "Sedan", luggage: "Medium", passengers: 2, travellers: pair },
};
const esimJapan = {
  type: "esim", title: "Japan eSIM", qty: 1,
  meta: { country: "Japan", countryCode: "JP", dataPack: "10 GB", startDate: "2026-11-02", days: 7, numberOfTravellers: 1, travellers: [karan] },
};
const holidayBali = {
  type: "holiday", title: "Bali holiday", qty: 1,
  meta: { destination: "Bali", startDate: "2026-12-18", days: 5, people: 4, budgetBand: "Premium", hotelClass: "5 Star", inclusions: ["Airport transfers", "Breakfast", "Ubud day tour"] },
};
const miceGoa = {
  type: "mice", title: "Offsite · Goa", qty: 1,
  meta: { mode: "Offsite", location: "Goa", startDate: "2026-11-19", endDate: "2026-11-21", attendees: 60, travelMode: "Flights", hotelType: "Resort", foodPref: "Veg + Non-Veg", addOns: ["Team dinner", "AV setup"] },
};

const base = {
  customerName: "Acme Logistics Pvt Ltd",
  frontlinerEmail: "asha.rao@acmelogistics.in",
  frontlinerName: "Asha Rao",
  managerEmail: "vikram.mehta@acmelogistics.in",
  managerName: "Vikram Mehta",
  approvedByName: "Vikram Mehta",
};

const flow2Request = {
  ...base,
  _id: "6a1f0c2b9d4e7f0012ab34cd",
  ticketId: "",
  comments: "Client workshop in Mumbai on the 13th, then the Dubai distributor meet — morning flight please. Budget approx ₹18,000/- per head.",
  meta: { travelFlow: "APPROVAL_FLOW", adminAssigned: { agentName: "Neha Kapoor", agentEmail: "neha.kapoor@plumtrips.com" } },
  cartItems: [roundTripPicked, hotelMumbai, visaUae],
};

const flow3Request = {
  _id: "6a1f0d7e2c9b4a0013cd56ef",
  ticketId: "TKT-20419",
  customerName: "Northwind Pharma",
  frontlinerEmail: "karan.shah@northwindpharma.com",
  frontlinerName: "Karan Shah",
  managerEmail: "meera.pillai@northwindpharma.com",
  managerName: "Meera Pillai",
  approvedByName: "Meera Pillai",
  comments: "Regional sales review in Dubai, then the London partner summit.",
  meta: { travelFlow: "APPROVAL_DIRECT" },
  cartItems: [multiCity, forexAed],
};

const proposal = {
  _id: "6a1f0e9a4b2c1d0014ef78ab",
  version: 2,
  history: [{ action: "SUBMITTED", byEmail: "neha.kapoor@plumtrips.com", at: NOW }],
  requesterEmail: "neha.kapoor@plumtrips.com",
  options: [
    {
      optionNo: 1,
      title: "IndiGo 6E 2134 morning + Trident BKC — ₹41,250",
      notes: "Refundable fares; breakfast included. Total INR 41,250/-",
      lineItems: [
        { category: "flight", title: "BLR → BOM 6E 2134 06:10 (₹6,450 per pax)", qty: 2, meta: { origin: "BLR", destination: "BOM", tripType: "roundtrip" } },
        { category: "hotel", title: "Trident Bandra Kurla, Deluxe — Rs 14,200 / night", qty: 2 },
      ],
    },
    {
      optionNo: 2,
      title: "Air India AI 639 + Sofitel BKC <b>(premium)</b>",
      lineItems: [
        { category: "flight", title: "BLR → BOM AI 639 09:10", qty: 2, meta: { origin: "BLR", destination: "BOM", tripType: "roundtrip" } },
        { category: "hotel", title: "Sofitel Mumbai BKC — 2 rooms, 18,900 rupees", qty: 2 },
      ],
    },
  ],
};

type Sample = { flow: string; label: string; ar: any; events: Array<{ event: Event; ctx?: Partial<Ctx>; recipient?: string; note?: string; name?: string }> };

const f2Leader = "priya.nair@acmelogistics.in";
const f2Approver = flow2Request.managerEmail;
const f3Approver = flow3Request.managerEmail;

const samples: Sample[] = [
  {
    flow: "flow2",
    label: "Flow 2 — round trip with a picked flight + hotel + visa",
    ar: flow2Request,
    events: [
      { event: "request_submitted_approver", recipient: f2Approver },
      { event: "request_submitted_leaders", recipient: f2Leader },
      { event: "request_submitted_confirmation" },
      { event: "request_auto_approved", note: "as if Asha were a Workspace Leader" },
      { event: "request_resent", recipient: f2Approver },
      { event: "request_resubmitted", recipient: f2Approver },
      { event: "request_reminder", recipient: f2Leader, ctx: { reminderNo: 2 } },
      { event: "clarification_asked", ctx: { actorName: "Priya Nair", reason: "Why two rooms? Can Rohan share? Also the ₹18,000 budget — is that per head?" } },
      { event: "clarification_answered", recipient: f2Leader, ctx: { asker: f2Leader, question: "Why two rooms? Can Rohan share?", reply: "Rohan joins a day later — separate check-in, so two rooms.", edited: true } },
      { event: "request_approved", ctx: { actorName: "Vikram Mehta" } },
      { event: "request_approved_fyi", ctx: { actorName: "Vikram Mehta" }, note: "to Workspace Leaders (not Vikram)" },
      { event: "request_declined", ctx: { actorName: "Priya Nair", reason: "Please combine with the Pune trip next week." } },
      { event: "request_declined_fyi", ctx: { actorName: "Priya Nair", reason: "Please combine with the Pune trip next week." } },
      { event: "ops_new_case", ctx: { actorName: "Vikram Mehta", assignedToName: "Neha Kapoor" } },
      { event: "ops_no_agent", ctx: { actorName: "Vikram Mehta" } },
      { event: "case_assigned", ctx: { agent: { name: "Neha Kapoor", email: "neha.kapoor@plumtrips.com" }, assignWhy: "Auto-assigned (Round robin)" } },
      { event: "proposal_submitted", recipient: f2Approver, ctx: { proposal } },
      { event: "proposal_ready", ctx: { proposal } },
      { event: "proposal_reminder", recipient: f2Leader, ctx: { proposal, reminderNo: 1 } },
      { event: "proposal_approved", ctx: { proposal, decision: "APPROVED", actorName: "Priya Nair" } },
      { event: "proposal_declined", ctx: { proposal, decision: "DECLINED", actorName: "Priya Nair", reason: "Too expensive" } },
      { event: "proposal_changes_requested", ctx: { proposal, decision: "CHANGES_REQUESTED", actorName: "Priya Nair", reason: "Option 1 but a later return flight on the 14th, after 6 pm." } },
      { event: "proposal_decision_fyi", ctx: { proposal, decision: "APPROVED", actorName: "Plumtrips Travel Desk", reason: "Recorded by Plumtrips Travel Desk on behalf of the customer: Vikram approved option 1 on the phone, 5 Oct 11:20." }, note: "recorded on behalf" },
      { event: "ops_proposal_outcome", ctx: { proposal, decision: "CHANGES_REQUESTED", actorName: "Priya Nair", reason: "Option 1 but a later return flight on the 14th, after 6 pm." } },
      { event: "booking_started" },
      { event: "booking_on_hold", ctx: { reason: "Waiting for the hotel to confirm the second room." } },
      { event: "booking_cancelled", ctx: { reason: "Workshop postponed by the client." } },
      { event: "booking_done", ctx: { doneComment: "PNR K7Q2LX (outbound) and K7Q2MA (return). Hotel confirmation TRB-55102. eVisas attached.", attachmentNames: ["Eticket-BLR-BOM.pdf", "Hotel-Voucher-Trident.pdf", "UAE-eVisa-Asha-Rao.pdf", "UAE-eVisa-Rohan-Iyer.pdf"] } },
      { event: "ops_customer_cancelled", ctx: { reason: "Customer cancelled after approval" }, note: "documented only — no trigger exists today" },
      {
        event: "email_send_failed_alert",
        ctx: { failure: { event: "booking_done", subject: "Your Booking has been Processed — Acme Logistics Pvt Ltd (REQ-AB34CD)", to: ["asha.rao@acmelogistics.in"], cc: [f2Approver, f2Leader], attempts: 3, error: "421 4.7.0 Try again later, closing connection" } },
      },
    ],
  },
  {
    flow: "flow3",
    label: "Flow 3 — multi-city flight + forex",
    ar: flow3Request,
    events: [
      { event: "request_submitted_approver", recipient: f3Approver },
      { event: "request_submitted_leaders", recipient: "anil.verma@northwindpharma.com" },
      { event: "request_submitted_confirmation" },
      { event: "request_auto_approved", note: "as if Karan were a Workspace Leader" },
      { event: "request_reminder", recipient: f3Approver, ctx: { reminderNo: 3 } },
      { event: "clarification_asked", ctx: { actorName: "Meera Pillai", reason: "Is the forex for the whole team?" } },
      { event: "clarification_answered", recipient: f3Approver, ctx: { asker: f3Approver, question: "Is the forex for the whole team?", reply: "Just me — the others are already in Dubai." } },
      { event: "request_approved", ctx: { actorName: "Meera Pillai" } },
      { event: "request_approved_fyi", ctx: { actorName: "Meera Pillai" } },
      { event: "request_declined", ctx: { actorName: "Meera Pillai", reason: "Do it over video this quarter." } },
      { event: "ops_new_case", ctx: { actorName: "Meera Pillai" }, note: "allocation off — unassigned" },
      { event: "case_assigned", ctx: { agent: { name: "Imtiaz Khan", email: "imtiaz.khan@plumtrips.com" }, assignWhy: "Assigned by a colleague", assignNote: "Corporate fare code NWP-24" } },
      { event: "booking_started" },
      { event: "booking_on_hold", ctx: { reason: "Forex delivery slot pending." } },
      { event: "booking_cancelled", ctx: { reason: "Trip dropped." } },
      { event: "booking_done", ctx: { doneComment: "PNRs EK5H2Z / BA7Q1M. Forex card dispatched, AWB 778201.", attachmentNames: ["Eticket-DEL-DXB-LHR-DEL.pdf"] } },
    ],
  },
];

/* Request-shape variants: the decision email and the booked email for each. */
const variants: Array<[string, string, any[]]> = [
  ["roundtrip-picked", "Round trip with a picked flight", [roundTripPicked]],
  ["hotel-only", "Hotel only", [hotelMumbai]],
  ["visa-only", "Visa only", [visaUae]],
  ["multi-city", "Multi-city flight", [multiCity]],
  ["mixed", "Mixed: flight + hotel + visa", [roundTripPicked, hotelMumbai, visaUae]],
  ["cab", "Cab", [cabPune]],
  ["forex", "Forex", [forexAed]],
  ["esim", "eSIM", [esimJapan]],
  ["holiday", "Holiday", [holidayBali]],
  ["mice", "MICE", [miceGoa]],
];
samples.push({
  flow: "variants",
  label: "Request shapes — approval needed + booked",
  ar: null,
  events: variants.flatMap(([key, label, items]) => {
    const ar = { ...base, _id: "6a1f0c2b9d4e7f0012ab9900", ticketId: "", comments: "", meta: { travelFlow: "APPROVAL_FLOW" }, cartItems: items };
    return [
      { event: "request_submitted_approver" as Event, recipient: f2Approver, ctx: { ar } as Partial<Ctx>, note: label, name: `${key}-approval-needed` },
      { event: "booking_done" as Event, ctx: { ar, attachmentNames: ["Booking-confirmation.pdf"] } as Partial<Ctx>, note: label, name: `${key}-booked` },
    ];
  }),
});

/* ───────────────────────── render ───────────────────────── */

const args = process.argv.slice(2);
const noPng = args.includes("--no-png");
const outDir = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(repo, "docs/design/approval-emails/rendered"));
// Old renders are cleared only from a folder named "rendered" (never a path the caller typed by mistake).
if (path.basename(outDir) === "rendered") fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const rows: string[] = [];
const htmlFiles: string[] = [];
/** Shown with images off too (one per kind of email). */
const IMAGES_OFF = new Set(["flow2/01-request_submitted_approver", "flow2/17-proposal_submitted", "flow2/28-booking_done", "flow2/14-ops_new_case", "flow3/01-request_submitted_approver"]);

let lastFlow = "";
for (const sample of samples) {
  fs.mkdirSync(path.join(outDir, sample.flow), { recursive: true });
  sample.events.forEach((e, i) => {
    const ctx = { ar: sample.ar, now: NOW, ...(e.ctx || {}) } as Ctx;
    const r = renderApprovalEmail(e.event, ctx, e.recipient || "");
    const stem = `${sample.flow}/${String(i + 1).padStart(2, "0")}-${e.name || e.event}`;
    fs.writeFileSync(path.join(outDir, `${stem}.html`), r.html);
    htmlFiles.push(stem);
    const spec: any = (APPROVAL_EMAIL_MAP as any)[e.event];
    const who = (list: string[]) => list.map((x) => (ROLE_LABEL as any)[x]).join(", ") || "—";
    const shots = noPng
      ? ""
      : `<a href="${esc(stem)}.desktop.png">desktop</a> · <a href="${esc(stem)}.phone.png">phone</a>${IMAGES_OFF.has(stem) ? ` · <a href="${esc(stem)}.images-off.png">images off</a>` : ""}`;
    if (sample.flow !== lastFlow) {
      rows.push(`<tr><th colspan="7" class="g">${esc(sample.label)}</th></tr>`);
      lastFlow = sample.flow;
    }
    rows.push(
      `<tr><td><a href="${esc(stem)}.html">${esc(e.event)}</a>${e.note ? `<div class="n">${esc(e.note)}</div>` : ""}</td><td>${shots}</td>` +
        `<td>${esc(who(spec.to))}${e.recipient ? `<div class="n">sample: ${esc(e.recipient)}</div>` : ""}</td><td>${esc(who(spec.cc))}</td>` +
        `<td>${spec.replyTo === "desk" ? "ops@plumtrips.com" : "—"}</td><td>${spec.audience}</td><td>${esc(r.subject)}</td></tr>`,
    );
  });
}

fs.writeFileSync(
  path.join(outDir, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>Approval emails — rendered</title>
<style>body{font-family:Arial,sans-serif;margin:24px;color:#0f172a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e2e8f0;padding:6px 8px;font-size:13px;text-align:left;vertical-align:top}th{background:#f8fafc}th.g{background:#00477f;color:#fff;font-size:14px}.n{color:#64748b;font-size:11px;margin-top:2px}</style>
</head><body><h1>Approval flow emails — rendered samples</h1>
<p>Generated by apps/backend/src/scripts/render-approval-emails.ts from the email map and templates. "Valid until" lines use a fixed clock (5 Oct 2026, 10:00 IST). Decision links are signed with a local dev key and do not work. Images load from the local email-assets folder; real emails load them from https://plumbox.plumtrips.com/email-assets/.</p>
<table><tr><th>Event</th><th>Screenshots</th><th>To</th><th>CC</th><th>Reply-To</th><th>Audience</th><th>Subject</th></tr>${rows.join("")}</table></body></html>`,
);

console.log(`index: ${path.join(outDir, "index.html")}`);

/* ───────────────────────── screenshots ───────────────────────── */

if (!noPng) {
  const puppeteer = (await import("puppeteer")).default;
  const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));
  const browser = await puppeteer.launch({ headless: true, executablePath: chrome, args: ["--allow-file-access-from-files"] });
  try {
    const page = await browser.newPage();
    let imagesOff = false;
    await page.setRequestInterception(true);
    page.on("request", (req) => (imagesOff && req.resourceType() === "image" ? req.abort() : req.continue()));
    const shoot = async (stem: string, width: number, suffix: string, noImages = false) => {
      imagesOff = noImages;
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(path.join(outDir, `${stem}.html`)).href, { waitUntil: "load" });
      if (noImages) {
        // Mail apps with images off drop background images too.
        await page.addStyleTag({ content: "*{background-image:none!important}" });
      }
      await page.screenshot({ path: path.join(outDir, `${stem}.${suffix}.png`) as `${string}.png`, fullPage: true });
    };
    for (const stem of htmlFiles) {
      await shoot(stem, 680, "desktop");
      await shoot(stem, 390, "phone");
      if (IMAGES_OFF.has(stem)) await shoot(stem, 680, "images-off", true);
    }
  } finally {
    await browser.close();
  }
}

for (const f of htmlFiles) console.log(path.join(outDir, `${f}.html`));
