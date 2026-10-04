// apps/backend/src/scripts/gen-approval-emails-doc.ts
//
// Writes docs/approval-emails.md from the email map
// (services/approvalEmails/map.ts): one table per event and one per role.
// Never edit the doc by hand — change the map and re-run:
//
//   npx tsx src/scripts/gen-approval-emails-doc.ts
//
// approvalEmails.test.ts fails when the committed doc is out of date.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  APPROVAL_EMAIL_MAP,
  ROLE_LABEL,
  ROLE_VIEWS,
  type ApprovalEmailEvent,
  type EmailEventSpec,
  type EmailRole,
  type LinkType,
} from "../services/approvalEmails/map.js";
import { APPROVAL_LINK_EXPIRY_HOURS } from "../utils/approvalLinkToken.js";

const LINK_LABEL: Record<LinkType, string> = {
  "decision-request": `No-login decision links (approve / decline / ask), own per recipient, ${APPROVAL_LINK_EXPIRY_HOURS}h, single-use — expiry stated in the email`,
  "decision-proposal": `No-login decision links (approve / decline / request changes), own per recipient, ${APPROVAL_LINK_EXPIRY_HOURS}h, single-use — expiry stated in the email`,
  login: "Plumbox button (login)",
  "staff-login": "Ops queue button (staff login)",
  none: "—",
};

const cell = (v: string) => String(v || "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
const roles = (list: EmailRole[]) => (list.length ? list.map((r) => ROLE_LABEL[r]).join(", ") : "—");

function eventTable(key: string, spec: EmailEventSpec): string {
  const rows: Array<[string, string]> = [
    ["Flows", spec.flows.join(", ")],
    ["Trigger", spec.trigger ?? "**Not sent — no trigger exists today**"],
    ["To", roles(spec.to)],
    ["CC", roles(spec.cc)],
    ["Never to", [...spec.exclude.map((r) => ROLE_LABEL[r]), ...(spec.excludeActor ? ["the person who just acted"] : [])].join(", ") || "—"],
    ["Reply-To", spec.replyTo === "desk" ? "ops@plumtrips.com (DESK_EMAIL)" : "—"],
    ["Audience", spec.audience === "customer" ? "Customer side (price-free, staff shown as Plumtrips Travel Desk)" : "Plumtrips staff"],
    ["One email per recipient", spec.perRecipient ? "Yes (own links)" : "No"],
    ["Link", LINK_LABEL[spec.link]],
    ["Template", `\`${spec.template}\``],
    ["Subject", `\`${spec.subject}\``],
  ];
  if (spec.notes) rows.push(["Notes", spec.notes]);
  return [
    `### \`${key}\` — ${spec.label}`,
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
    "",
  ].join("\n");
}

function roleTable(title: string, view: EmailRole[]): string {
  const hits = (Object.entries(APPROVAL_EMAIL_MAP) as Array<[ApprovalEmailEvent, EmailEventSpec]>).filter(
    ([, s]) => s.to.some((r) => view.includes(r)) || s.cc.some((r) => view.includes(r)),
  );
  const lines = hits.map(([key, s]) => {
    const as = s.to.some((r) => view.includes(r)) ? "To" : "CC";
    const via = [...s.to, ...s.cc].filter((r) => view.includes(r)).map((r) => ROLE_LABEL[r]).join(", ");
    return `| \`${key}\` | ${cell(s.label)} | ${as} (as ${cell(via)}) | ${cell(s.trigger ?? "Not sent today")} | ${cell(LINK_LABEL[s.link])} |`;
  });
  return [`### ${title}`, "", "| Event | Email | Gets it as | When | Link |", "|---|---|---|---|---|", ...lines, ""].join("\n");
}

export function renderApprovalEmailsDoc(): string {
  const events = Object.entries(APPROVAL_EMAIL_MAP) as Array<[string, EmailEventSpec]>;
  return [
    "# Approval flow emails (Flows 2 & 3)",
    "",
    "<!-- GENERATED from apps/backend/src/services/approvalEmails/map.ts by",
    "     src/scripts/gen-approval-emails-doc.ts — do not edit by hand. -->",
    "",
    "Flow 2: requester → approver → ops proposal → approver OR Workspace Leader → ops book → done.",
    "Flow 3: requester → approver → ops book directly → done.",
    "",
    "## Rules for every email",
    "",
    "- A deactivated person (User INACTIVE, or every customer membership deactivated) is never emailed or copied.",
    "- One copy per person per event (To wins over CC).",
    "- Customer-facing: Reply-To ops@plumtrips.com; staff appear as \"Plumtrips Travel Desk\"; people are named, never ids; no prices; passports masked.",
    `- Decision links: valid ${APPROVAL_LINK_EXPIRY_HOURS} hours, single-use, the recipient is re-checked on click; every email with links states the expiry.`,
    "- Every send goes through the outbox: tried at once, retried after 2 and 10 more minutes; after the third failure it is listed under \"Email failures\" on the ops queue and alerted to ops@. A request is marked notified only after a successful send.",
    "- Reminders (requests and proposals): 24h, 48h, 72h after it reached the deciders, max 3, to the approver and Workspace Leaders; stop on decision, cancel or revoke. Nothing older than 4 days is reminded.",
    "- ops@plumtrips.com receives only: new case in the queue, no agent available, proposal approved / declined / changes requested, customer cancelled after approval (no such action today), and email failures.",
    "",
    `## Events (${events.length})`,
    "",
    "| Event | Email | To | CC | Flows |",
    "|---|---|---|---|---|",
    ...events.map(([k, s]) => `| \`${k}\` | ${cell(s.label)} | ${cell(roles(s.to))} | ${cell(roles(s.cc))} | ${s.flows.join(", ")} |`),
    "",
    ...events.map(([k, s]) => eventTable(k, s)),
    "## By role",
    "",
    "\"Deciders\" are the approver (while still an approver) plus every active Workspace Leader, so an event sent to deciders appears under both.",
    "",
    ...ROLE_VIEWS.map((v) => roleTable(v.title, v.roles)),
  ].join("\n");
}

export const DOC_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../docs/approval-emails.md");

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/gen-approval-emails-doc.ts");
if (invokedDirectly) {
  fs.writeFileSync(DOC_PATH, renderApprovalEmailsDoc());
  console.log(`wrote ${DOC_PATH}`);
}
