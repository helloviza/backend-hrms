// apps/backend/src/scripts/render-approval-emails.ts
//
// Renders EVERY approval-flow email (each event in services/approvalEmails/
// map.ts) with realistic sample data — a Flow 2 case and a Flow 3 case — to
// HTML files for review, plus an index.html listing them with their
// recipients from the map. No database, no sending, no preview stack:
//
//   npx tsx src/scripts/render-approval-emails.ts [outDir]
//
// Default outDir: <repo>/docs/design/approval-emails/rendered
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

process.env.FRONTEND_PUBLIC_URL ||= "https://plumbox.plumtrips.com";

const { APPROVAL_EMAIL_MAP, ROLE_LABEL } = await import("../services/approvalEmails/map.js");
const { renderApprovalEmail } = await import("../services/approvalEmails/templates.js");
type Ctx = Parameters<typeof renderApprovalEmail>[1];
type Event = Parameters<typeof renderApprovalEmail>[0];

const NOW = new Date("2026-10-05T04:30:00Z"); // 10:00 IST

const travellers = [
  { kind: "self", firstName: "Asha", lastName: "Rao", passportNumber: "XXXX4821" },
  { kind: "manual", firstName: "Rohan", lastName: "Iyer", passportNumber: "XXXX0937" },
];

const flow2Request = {
  _id: "6a1f0c2b9d4e7f0012ab34cd",
  ticketId: "",
  customerName: "Acme Logistics Pvt Ltd",
  frontlinerEmail: "asha.rao@acmelogistics.in",
  frontlinerName: "Asha Rao",
  managerEmail: "vikram.mehta@acmelogistics.in",
  managerName: "Vikram Mehta",
  approvedByName: "Vikram Mehta",
  comments: "Client workshop in Mumbai on the 13th — morning flight please. Budget approx ₹18,000/- per head.",
  meta: { travelFlow: "APPROVAL_FLOW", adminAssigned: { agentName: "Neha Kapoor", agentEmail: "neha.kapoor@plumtrips.com" } },
  cartItems: [
    {
      type: "flight",
      title: "BLR → BOM (Round Trip)",
      qty: 2,
      meta: {
        origin: "BLR", destination: "BOM", departDate: "2026-10-12", returnDate: "2026-10-14",
        tripType: "roundtrip", cabinClass: "Economy", adults: 2, preferredTime: "Morning", travellers,
      },
    },
    {
      type: "hotel",
      title: "Hotel near BKC",
      qty: 1,
      meta: { city: "Mumbai", hotelName: "Trident Bandra Kurla", checkIn: "2026-10-12", checkOut: "2026-10-14", rooms: 2, guests: 2, travellers },
    },
  ],
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
  comments: "Regional sales review, Dubai.",
  meta: { travelFlow: "APPROVAL_DIRECT" },
  cartItems: [
    {
      type: "flight",
      title: "DEL → DXB (One Way)",
      qty: 1,
      meta: {
        origin: "DEL", destination: "DXB", departDate: "2026-10-20", tripType: "oneway", cabinClass: "Economy", adults: 1,
        travellers: [{ kind: "self", firstName: "Karan", lastName: "Shah", passportNumber: "XXXX7710" }],
      },
    },
    { type: "forex", title: "Forex", qty: 1, meta: { currency: "AED", amount: 3000, deliveryMode: "Door delivery", city: "New Delhi", requiredBy: "2026-10-18" } },
  ],
};

const proposal = {
  _id: "6a1f0e9a4b2c1d0014ef78ab",
  version: 2,
  history: [{ action: "SUBMITTED", byEmail: "neha.kapoor@plumtrips.com", at: NOW }],
  requesterEmail: "neha.kapoor@plumtrips.com",
  options: [
    {
      optionNo: 1,
      title: "IndiGo 6E-5321 morning + Trident BKC — ₹41,250",
      notes: "Refundable fares; breakfast included. Total INR 41,250/-",
      lineItems: [
        { category: "flight", title: "BLR → BOM 6E-5321 07:05 (₹6,450 per pax)", qty: 2, meta: { origin: "BLR", destination: "BOM", tripType: "roundtrip" } },
        { category: "hotel", title: "Trident Bandra Kurla, Deluxe — Rs 14,200 / night", qty: 2 },
      ],
    },
    {
      optionNo: 2,
      title: "Air India AI-639 + Sofitel BKC <b>(premium)</b>",
      lineItems: [
        { category: "flight", title: "BLR → BOM AI-639 09:10", qty: 2, meta: { origin: "BLR", destination: "BOM", tripType: "roundtrip" } },
        { category: "hotel", title: "Sofitel Mumbai BKC — 2 rooms, 18,900 rupees", qty: 2 },
      ],
    },
  ],
};

type Sample = { flow: "flow2" | "flow3"; ar: any; events: Array<{ event: Event; ctx?: Partial<Ctx>; recipient?: string; note?: string }> };

const f2Leader = "priya.nair@acmelogistics.in";
const f2Approver = flow2Request.managerEmail;
const f3Approver = flow3Request.managerEmail;

const samples: Sample[] = [
  {
    flow: "flow2",
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
      { event: "case_assigned", ctx: { agent: { name: "Neha Kapoor", email: "neha.kapoor@plumtrips.com" }, assignWhy: "Auto-assigned (Round robin)", tripLines: ["Flight BLR → BOM · 2026-10-12 – 2026-10-14", "Hotel Mumbai · 2026-10-12 – 2026-10-14"] } },
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
      { event: "booking_done", ctx: { doneComment: "PNR K7Q2LX (outbound) and K7Q2MA (return). Hotel confirmation TRB-55102.", attachmentNames: ["Eticket-BLR-BOM.pdf", "Hotel-Voucher-Trident.pdf"] } },
      { event: "ops_customer_cancelled", ctx: { reason: "Customer cancelled after approval" }, note: "documented only — no trigger exists today" },
      {
        event: "email_send_failed_alert",
        ctx: { failure: { event: "booking_done", subject: "Your booking has been processed — Acme Logistics Pvt Ltd (REQ-AB34CD)", to: ["asha.rao@acmelogistics.in"], cc: [f2Approver, f2Leader], attempts: 3, error: "421 4.7.0 Try again later, closing connection" } },
      },
    ],
  },
  {
    flow: "flow3",
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
      { event: "case_assigned", ctx: { agent: { name: "Imtiaz Khan", email: "imtiaz.khan@plumtrips.com" }, assignWhy: "Assigned by a colleague", assignNote: "Corporate fare code NWP-24", tripLines: ["Flight DEL → DXB · 2026-10-20", "Forex"] } },
      { event: "booking_started" },
      { event: "booking_on_hold", ctx: { reason: "Forex delivery slot pending." } },
      { event: "booking_cancelled", ctx: { reason: "Trip dropped." } },
      { event: "booking_done", ctx: { doneComment: "PNR EK-5H2ZQ. Forex card dispatched, AWB 778201.", attachmentNames: ["Eticket-DEL-DXB.pdf"] } },
    ],
  },
];

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] || path.join(here, "../../../../docs/design/approval-emails/rendered"));
fs.mkdirSync(outDir, { recursive: true });

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const rows: string[] = [];
const written: string[] = [];

for (const sample of samples) {
  fs.mkdirSync(path.join(outDir, sample.flow), { recursive: true });
  sample.events.forEach((e, i) => {
    const ctx = { ar: sample.ar, now: NOW, ...(e.ctx || {}) } as Ctx;
    const r = renderApprovalEmail(e.event, ctx, e.recipient || "");
    const file = `${sample.flow}/${String(i + 1).padStart(2, "0")}-${e.event}.html`;
    fs.writeFileSync(path.join(outDir, file), r.html);
    written.push(path.join(outDir, file));
    const spec: any = (APPROVAL_EMAIL_MAP as any)[e.event];
    const who = (list: string[]) => list.map((x) => (ROLE_LABEL as any)[x]).join(", ") || "—";
    rows.push(
      `<tr><td>${sample.flow === "flow2" ? "Flow 2" : "Flow 3"}</td><td><a href="${esc(file)}">${esc(e.event)}</a>${e.note ? `<div class="n">${esc(e.note)}</div>` : ""}</td>` +
        `<td>${esc(who(spec.to))}${e.recipient ? `<div class="n">sample: ${esc(e.recipient)}</div>` : ""}</td><td>${esc(who(spec.cc))}</td>` +
        `<td>${spec.replyTo === "desk" ? "ops@plumtrips.com" : "—"}</td><td>${esc(r.subject)}</td></tr>`,
    );
  });
}

fs.writeFileSync(
  path.join(outDir, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>Approval emails — rendered</title>
<style>body{font-family:Arial,sans-serif;margin:24px;color:#0f172a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e2e8f0;padding:6px 8px;font-size:13px;text-align:left;vertical-align:top}th{background:#f8fafc}.n{color:#64748b;font-size:11px;margin-top:2px}</style>
</head><body><h1>Approval flow emails — rendered samples</h1>
<p>Generated by apps/backend/src/scripts/render-approval-emails.ts from the email map. "Expires by" lines use a fixed clock (5 Oct 2026, 10:00 IST). Decision links are signed with a local dev key and do not work.</p>
<table><tr><th>Flow</th><th>Event</th><th>To</th><th>CC</th><th>Reply-To</th><th>Subject</th></tr>${rows.join("")}</table></body></html>`,
);

console.log(`index: ${path.join(outDir, "index.html")}`);
for (const f of written) console.log(f);
