// apps/backend/src/services/leadImportTemplate.ts
//
// The fill-in workbook for the bulk lead import (GET /leads/import/template).
//
//   Sheet "Leads"           header row = EXACTLY the field keys the importer
//                           maps (services/leadImport.ts IMPORT_FIELDS, in
//                           order), one valid example row, dropdowns on every
//                           constrained column, date columns forced to text so
//                           Excel never re-reads "03-04-2026" in its own locale.
//   Sheet "Allowed values"  the human-readable vocabulary: how each column is
//                           read, the LIVE disposition set (sub-dispositions
//                           grouped under their disposition with what each
//                           derives), statuses, stages, sources, currencies and
//                           the CRM reps an `owner` cell may name.
//   Sheet "Lists"           hidden — the single-column ranges the dropdowns
//                           reference.
//
// Built from the same constants the validator reads, so the sheet can never
// drift from what the importer accepts.
import ExcelJS from "exceljs";
import { LEAD_SOURCES, LEAD_STAGES } from "../models/Lead.js";
import { LEAD_STATUSES, LEAD_STATUS_LABEL } from "../models/crmTaxonomy.js";
import { type DispositionEntry } from "../models/crmDisposition.js";
import { IMPORT_FIELDS, IMPORT_ROW_CAP, type ImportField } from "./leadImport.js";

export interface TemplateInput {
  reps: Array<{ name: string; email: string }>;
  /** null = CRM_V2_DISPOSITION off on this server. */
  dispositionSet: DispositionEntry[] | null;
  /** The requesting user, when they are a rep — makes the example row valid for them. */
  exampleOwner: { name: string; email: string } | null;
  /** OWN scope: the owner column may only name the importer. */
  ownScope: boolean;
}

const CURRENCIES = ["INR", "USD", "AED"] as const;
const SOURCE_LABEL: Record<(typeof LEAD_SOURCES)[number], string> = {
  manual: "Manual", website: "Website", linkedin: "LinkedIn", facebook: "Facebook", instagram: "Instagram", referral: "Referral", cold_call: "Cold Call", email: "Email", other: "Other",
};
const SOURCE_ALSO: Partial<Record<(typeof LEAD_SOURCES)[number], string>> = {
  website: "web", facebook: "fb", instagram: "ig", referral: "reference, referred", cold_call: "coldcall, call", other: "others",
};
const STAGE_LABEL: Record<(typeof LEAD_STAGES)[number], string> = {
  new: "New", email_sent: "Email Sent", contacted: "Contacted", demo_scheduled: "Demo Scheduled", proposal_sent: "Proposal Sent", negotiation: "Negotiation", follow_up: "Follow Up", won: "Won", lost: "Lost",
};

/** What each column means, as the header note and the Allowed-values sheet. */
const FIELD_HELP: Record<ImportField, string> = {
  contactName: "Required. The person's full name.",
  contactPhone: "Required. At least 6 digits; any formatting is kept as typed.",
  contactEmail: "Optional. Must be a valid address when given. On a Won row this is also the dedupe key for the CRM contact.",
  contactDesignation: "Optional. Job title.",
  companyName: "Optional. Blank = individual lead. Anchored to ONE CRM company by normalised name (created if new).",
  industry: "Optional free text (e.g. IT/Technology, Pharma/Healthcare, FMCG).",
  companySize: "Optional free text (e.g. 1-10, 11-50, 51-200, 201-500, 500+).",
  location: "Optional. City.",
  address: "Optional.",
  website: "Optional.",
  gstin: "Optional.",
  source: "Optional. One of the Source values; blank = the batch default chosen on the import screen.",
  owner: "Optional. A CRM rep's EMAIL (preferred) or exact full name — see Owners. Unknown or ambiguous → the row is rejected. Blank = the batch owner chosen on the import screen.",
  status: "Optional, legacy-only rows. Ignored when the row has a disposition (derived instead).",
  stage: "Optional, legacy-only rows. Ignored when the row has a disposition (derived instead).",
  disposition: "Optional. Must be the parent of subDisposition. May stand alone only when it has exactly one sub-disposition (Onboarded).",
  subDisposition: "Optional. The key: stage, status, opportunity and (for Onboarded) the CRM contact are derived from it exactly as a live disposition.",
  budget: "Optional free text.",
  dealValue: "Optional number (no currency symbol needed; 1,80,000 is fine). Becomes the opportunity value on Interested / Onboarded rows.",
  currency: "Optional. INR (default), USD or AED.",
  nextFollowUpDate: "dd-mm-yyyy or ISO. REQUIRED for 'Call Back Time Given' and 'Follow up Required'; kept as the lead's next follow-up otherwise.",
  followUpNotes: "Optional. Stored as the follow-up note (and as the disposition note when the row has one).",
  createdDate: "dd-mm-yyyy or ISO date-time. PRESERVED as the lead's created date (not the import day). Blank = import time. Not in the future.",
  dispositionDate: "dd-mm-yyyy or ISO date-time. When the disposition happened — stamps dispositionAt / wonDate / opportunity closed date. Blank = import time. Not before createdDate.",
  notes: "Optional. Stored on the lead and echoed into the import note on its timeline.",
};

const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);
function letter(i: number): string {
  let s = "";
  for (let n = i; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function buildImportTemplate(input: TemplateInput): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Plumtrips CRM";
  const set = input.dispositionSet ?? [];
  const dispositions = [...new Set(set.map((e) => e.disposition))];
  const subs = set.map((e) => e.subDisposition);
  const ownerEmails = input.reps.map((r) => r.email).filter(Boolean);
  const exampleOwner = input.exampleOwner?.email || input.reps[0]?.email || "";

  // Leads is added FIRST: the importer reads the first sheet.
  const leads = wb.addWorksheet("Leads", { views: [{ state: "frozen", ySplit: 1 }] });

  /* ── Lists (hidden) — one column per dropdown ── */
  const lists = wb.addWorksheet("Lists", { state: "hidden" });
  const listCols: Array<{ key: ImportField; values: string[] }> = [
    { key: "source", values: LEAD_SOURCES.map((s) => SOURCE_LABEL[s]) },
    { key: "owner", values: ownerEmails },
    { key: "status", values: [...LEAD_STATUSES] },
    { key: "stage", values: [...LEAD_STAGES] },
    { key: "disposition", values: dispositions },
    { key: "subDisposition", values: subs },
    { key: "currency", values: [...CURRENCIES] },
  ];
  const listRef = new Map<ImportField, string>();
  listCols.forEach((c, i) => {
    const col = letter(i + 1);
    lists.getCell(`${col}1`).value = c.key;
    c.values.forEach((v, j) => { lists.getCell(`${col}${j + 2}`).value = v; });
    if (c.values.length) listRef.set(c.key, `Lists!$${col}$2:$${col}$${c.values.length + 1}`);
  });

  /* ── Leads — the sheet the importer reads ── */
  const keys = IMPORT_FIELDS.map((f) => f.key);
  const header = leads.addRow(keys);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00477F" } };
  header.alignment = { vertical: "middle" };
  keys.forEach((k, i) => {
    const f = IMPORT_FIELDS[i];
    const required = "required" in f && !!f.required;
    const cell = header.getCell(i + 1);
    cell.note = `${f.label}${required ? " — REQUIRED" : ""}\n${FIELD_HELP[k]}`;
    if (required) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB3261E" } };
  });

  const widths: Partial<Record<ImportField, number>> = {
    contactName: 22, contactPhone: 16, contactEmail: 28, contactDesignation: 18, companyName: 24, industry: 16, companySize: 12, location: 14, address: 24, website: 20, gstin: 16,
    source: 12, owner: 28, status: 12, stage: 14, disposition: 16, subDisposition: 26, budget: 12, dealValue: 12, currency: 9, nextFollowUpDate: 16, followUpNotes: 26, createdDate: 20, dispositionDate: 20, notes: 36,
  };
  const TEXT_COLS: ImportField[] = ["contactPhone", "gstin", "nextFollowUpDate", "createdDate", "dispositionDate"];
  keys.forEach((k, i) => {
    const col = leads.getColumn(i + 1);
    col.width = widths[k] ?? 14;
    if (TEXT_COLS.includes(k)) col.numFmt = "@"; // text — Excel must not re-read dd-mm-yyyy in its own locale
  });

  // One valid example row (the user replaces or deletes it).
  const hasDisp = set.length > 0;
  const example: Record<ImportField, string | number> = {
    contactName: "Kavya Rao", contactPhone: "9811000901", contactEmail: "kavya.rao@onboarded-demo.test", contactDesignation: "HR Head",
    companyName: "Onboarded Demo Co", industry: "IT/Technology", companySize: "51-200", location: "Bengaluru", address: "", website: "onboarded-demo.test", gstin: "",
    source: "LinkedIn", owner: exampleOwner, status: hasDisp ? "" : "CONTACTED", stage: hasDisp ? "" : "contacted",
    disposition: hasDisp ? "Interested" : "", subDisposition: hasDisp ? "Follow up Required" : "",
    budget: "", dealValue: 220000, currency: "INR", nextFollowUpDate: ddmmyyyy(daysFromNow(7)), followUpNotes: "Send offsite proposal",
    createdDate: ddmmyyyy(daysFromNow(-30)), dispositionDate: hasDisp ? ddmmyyyy(daysFromNow(-7)) : "",
    notes: "EXAMPLE ROW — replace or delete before importing. Annual offsite for 60.",
  };
  const ex = leads.addRow(keys.map((k) => example[k]));
  ex.font = { italic: true, color: { argb: "FF6B7280" } };

  // Dropdowns on the constrained columns, header+1 .. row cap.
  const last = IMPORT_ROW_CAP + 1;
  for (const [key, ref] of listRef) {
    const c = letter(keys.indexOf(key) + 1);
    // Range-level validation lives on the runtime worksheet; the typings only expose per-cell dataValidation.
    (leads as any).dataValidations.add(`${c}2:${c}${last}`, {
      type: "list", allowBlank: true, formulae: [ref], showErrorMessage: true,
      errorStyle: "warning", errorTitle: "Not an allowed value", error: `See the "Allowed values" sheet for ${key}.`,
    });
  }

  /* ── Allowed values — the human sheet ── */
  const av = wb.addWorksheet("Allowed values");
  [30, 34, 16, 14, 14, 16, 18, 18].forEach((w, i) => { av.getColumn(i + 1).width = w; });
  const title = (t: string) => { const r = av.addRow([t]); r.font = { bold: true, size: 13, color: { argb: "FF00477F" } }; };
  const head = (cells: string[]) => { const r = av.addRow(cells); r.font = { bold: true }; r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } }; };
  const gap = () => av.addRow([]);

  title("How the importer reads the Leads sheet");
  const setEnabled = input.dispositionSet !== null;
  [
    ["Required", "contactName and contactPhone. Everything else is optional."],
    ["Row cap", `First sheet only · header row required · up to ${IMPORT_ROW_CAP} rows · 10 MB. Delete or replace the grey example row.`],
    ["owner", input.ownScope
      ? "Your import scope is OWN: the owner column may only name you (or stay blank). Any other rep → the row is rejected."
      : "A rep's email (exact, case-insensitive) — or their exact full name. Unknown, not a CRM rep, or ambiguous → the row is REJECTED with the reason (never silently dropped, never self-assigned). Blank → the batch owner picked on the import screen."],
    ["disposition / subDisposition", setEnabled
      ? "subDisposition is the key (matched case-insensitively). disposition is optional but must be its parent. Only 'Onboarded' may be given without a sub-disposition. From the pair the importer DERIVES dispositionStage, dispositionStatus, the lead status, the legacy stage, the opportunity and (Onboarded) the CRM contact — exactly like the live disposition flow. Never type those derived values."
      : "Dispositions are OFF on this server (CRM_V2_DISPOSITION). Leave both columns blank or the row is rejected."],
    ["status / stage", "Only for rows WITHOUT a disposition (legacy-only leads). With a disposition they are ignored (a warning shows if they differ from the derived value). Either may be given alone — the other is derived."],
    ["Opportunity", "Interested → an open opportunity at the sub-disposition's stage. Onboarded → a closed-won opportunity + the CRM contact/company. Not Interested / Number Does not Exist / Temp out of Service → lost at the lead grain (a fresh import never had an opportunity to close). Call Back / Switched off / Ringing Only → none."],
    ["Dates", "dd-mm-yyyy (read as UTC midnight), yyyy-mm-dd, or a full ISO date-time (2026-03-14T09:30:00.000Z). Keep the cells as TEXT — the template already formats them."],
    ["createdDate", "PRESERVED as the lead's created date. Blank = import time. Rejected if in the future or before 2000."],
    ["dispositionDate", "When the disposition happened. Stamps dispositionAt, wonDate and a new opportunity's created/closed date. Blank = import time (the same as a live disposition — so a re-import without it reads as 'dispositioned today'). Rejected if before createdDate."],
    ["nextFollowUpDate", "REQUIRED for 'Call Back Time Given' and 'Follow up Required'. Kept on the lead for every row."],
    ["Duplicates", "A row whose company already has an OPEN lead is still imported, tagged as a possible duplicate (advisory)."],
  ].forEach(([k, v]) => { const r = av.addRow([k, v]); r.getCell(1).font = { bold: true }; r.getCell(2).alignment = { wrapText: true, vertical: "top" }; av.mergeCells(r.number, 2, r.number, 8); });
  gap();

  title("Dispositions → what each sub-disposition derives");
  if (setEnabled) {
    head(["Disposition", "Sub-disposition", "→ dispositionStage", "→ dispositionStatus", "→ Lead status", "→ Legacy stage", "Needs nextFollowUpDate", "Opportunity"]);
    const effectLabel: Record<DispositionEntry["opportunityEffect"], (e: DispositionEntry) => string> = {
      none: () => "none",
      open: (e) => `opened / synced at ${e.opportunityStage}`,
      won: () => "closed-won + CRM contact",
      lost: () => "closed-lost if one exists",
    };
    let prev = "";
    for (const e of set) {
      const r = av.addRow([e.disposition === prev ? "" : e.disposition, e.subDisposition, e.stage, e.status, e.leadStatus, e.legacyStage, e.nextTouch ? "YES" : "", effectLabel[e.opportunityEffect](e)]);
      if (e.disposition !== prev) { r.getCell(1).font = { bold: true }; if (prev) r.border = { top: { style: "thin", color: { argb: "FFD1D5DB" } } }; }
      prev = e.disposition;
    }
  } else {
    av.addRow(["Dispositions are off on this server (CRM_V2_DISPOSITION)."]);
  }
  gap();

  title("status (legacy-only rows)");
  head(["Value", "Meaning"]);
  LEAD_STATUSES.forEach((s) => av.addRow([s, LEAD_STATUS_LABEL[s]]));
  gap();

  title("stage (legacy-only rows)");
  head(["Value", "Also accepted"]);
  LEAD_STAGES.forEach((s) => av.addRow([s, STAGE_LABEL[s]]));
  gap();

  title("source");
  head(["Value", "Also accepted", "Stored as"]);
  LEAD_SOURCES.forEach((s) => av.addRow([SOURCE_LABEL[s], SOURCE_ALSO[s] || "", s]));
  gap();

  title("currency");
  head(["Value"]);
  CURRENCIES.forEach((c) => av.addRow([c]));
  gap();

  title("Owners — CRM reps an owner cell may name");
  head(["Name", "Email (use this)"]);
  if (input.reps.length) input.reps.forEach((r) => av.addRow([r.name, r.email]));
  else av.addRow(["(no CRM reps found — the owner column will reject every value)"]);

  return wb;
}
