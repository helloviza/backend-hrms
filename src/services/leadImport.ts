// apps/backend/src/services/leadImport.ts
//
// Bulk lead import (ask #6) + the same-company check it shares with
// GET /leads/company-check (asks #5/#7).
//
//   parseSpreadsheet   CSV / XLSX buffer → header row + string cells (xlsx,
//                      the lib the manual-bookings import already uses).
//   suggestMapping     detected columns → lead fields by header alias.
//   validateRows       mapping applied, required / enum / number / date
//                      checks per row. Pure — no DB.
//   companyCheck       the dedupe read: resolve the company on nameNormalized
//                      and list its leads with an `open` flag and owner.
//   dedupeSnapshot     one companyCheck per distinct company in the batch,
//                      taken BEFORE anything is written, so "already had an
//                      open lead" means exactly that and rows that share a
//                      company inside the file are reported separately.
//   commitImport       creates the valid rows one by one through Lead.create
//                      (the model's pre-save draws LEAD-YYYY-NNNN from the
//                      atomic Counter — never countDocuments), anchoring the
//                      company on resolveOrCreateCompany exactly like POST /.
//                      A row that throws is reported and the batch continues:
//                      nothing is half-written silently.
//
// Fresh-lead defaults are the model's own: stage "new", disposition fields
// "" (which the UI reads as Open / Prospect), no opportunity. Under
// CRM_V2_OPPORTUNITY the model's pre-validate derives `status` from `stage`
// exactly as it does for a single create.
import mongoose from "mongoose";
import XLSX from "xlsx";
import Lead, { LEAD_SOURCES, effectiveLeadStatus } from "../models/Lead.js";
import LeadActivity from "../models/LeadActivity.js";
import CRMCompany from "../models/CRMCompany.js";
import User from "../models/User.js";
import { isClosedLeadStatus } from "../models/crmTaxonomy.js";
import { normalizeCompanyName, resolveOrCreateCompany } from "../utils/crmCompany.js";

type AnyObj = Record<string, any>;

export const IMPORT_ROW_CAP = 1000;
export const IMPORT_FILE_CAP_BYTES = 10 * 1024 * 1024;

/* ───────────────────────────── company check ───────────────────────────── */

export interface CompanyCheckLead {
  _id: string;
  leadCode: string;
  contactName: string;
  contactDesignation: string;
  stage: string;
  status: string;
  dispositionStage: string;
  dispositionStatus: string;
  subDisposition: string;
  assignedTo: string | null;
  assignedToName: string;
  open: boolean;
  nextFollowUpDate: Date | null;
  createdAt: Date;
}
export interface CompanyCheckResult {
  match: boolean;
  company: AnyObj | null;
  leads: CompanyCheckLead[];
  openCount: number;
  total: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EMPTY_CHECK: CompanyCheckResult = { match: false, company: null, leads: [], openCount: 0, total: 0 };

/**
 * Resolve a company by canonical id or by name (nameNormalized, with a
 * case-insensitive exact-name fallback for legacy rows whose key is still
 * "") and list the leads it carries. Leads match on Lead.companyId plus
 * unanchored legacy rows whose companyName equals the company's name.
 * Read-only; deliberately not narrowed to the caller's OWN scope — the
 * point is to reveal a colleague's ownership.
 */
export async function companyCheck(input: { name?: string; companyId?: string }): Promise<CompanyCheckResult> {
  let company: any = null;
  if (input.companyId && mongoose.isValidObjectId(String(input.companyId))) {
    company = await CRMCompany.findById(String(input.companyId)).select("name companyCode industry city country customerId").lean();
  } else {
    const name = String(input.name || "").trim();
    const nameNormalized = normalizeCompanyName(name);
    if (!nameNormalized) return EMPTY_CHECK;
    company = await CRMCompany.findOne({
      $or: [{ nameNormalized }, { nameNormalized: "", name: new RegExp(`^${escapeRe(name)}$`, "i") }],
    })
      .select("name companyCode industry city country customerId")
      .lean();
  }
  if (!company) return EMPTY_CHECK;

  const rows = (await Lead.find({
    $or: [{ companyId: company._id }, { companyId: null, companyName: new RegExp(`^${escapeRe(String(company.name))}$`, "i") }],
  })
    .select("leadCode contactName contactDesignation stage status dispositionStage dispositionStatus subDisposition assignedTo assignedToName nextFollowUpDate createdAt")
    .sort({ createdAt: -1 })
    .limit(50)
    .lean()) as any[];

  // Owner labels: the stored assignedToName, resolved from User when blank.
  const missing = rows.filter((l) => !l.assignedToName && l.assignedTo).map((l) => l.assignedTo);
  const users = missing.length ? ((await User.find({ _id: { $in: missing } }).select("name firstName lastName email").lean()) as any[]) : [];
  const nameOf = new Map(users.map((u) => [String(u._id), (u.name && String(u.name).trim()) || `${u.firstName || ""} ${u.lastName || ""}`.trim() || String(u.email || "")]));

  const leads: CompanyCheckLead[] = rows.map((l) => ({
    _id: String(l._id),
    leadCode: l.leadCode,
    contactName: l.contactName || "",
    contactDesignation: l.contactDesignation || "",
    stage: l.stage,
    status: effectiveLeadStatus(l),
    dispositionStage: l.dispositionStage || "",
    dispositionStatus: l.dispositionStatus || "",
    subDisposition: l.subDisposition || "",
    assignedTo: l.assignedTo ? String(l.assignedTo) : null,
    assignedToName: l.assignedToName || (l.assignedTo ? nameOf.get(String(l.assignedTo)) || "" : ""),
    open: !isClosedLeadStatus(effectiveLeadStatus(l)),
    nextFollowUpDate: l.nextFollowUpDate ?? null,
    createdAt: l.createdAt,
  }));

  return { match: true, company: { ...company, _id: String(company._id) }, leads, openCount: leads.filter((l) => l.open).length, total: leads.length };
}

/* ───────────────────────────── fields + mapping ───────────────────────────── */

export const IMPORT_FIELDS = [
  { key: "contactName", label: "Contact name", required: true },
  { key: "contactPhone", label: "Contact phone", required: true },
  { key: "contactEmail", label: "Contact email" },
  { key: "contactDesignation", label: "Designation" },
  { key: "companyName", label: "Company" },
  { key: "industry", label: "Industry" },
  { key: "companySize", label: "Company size" },
  { key: "location", label: "Location / city" },
  { key: "address", label: "Address" },
  { key: "website", label: "Website" },
  { key: "gstin", label: "GSTIN" },
  { key: "source", label: "Source (overrides the batch default)" },
  { key: "budget", label: "Budget" },
  { key: "dealValue", label: "Deal value" },
  { key: "currency", label: "Currency (INR / USD / AED)" },
  { key: "notes", label: "Notes" },
  { key: "nextFollowUpDate", label: "Next follow-up date" },
  { key: "followUpNotes", label: "Follow-up notes" },
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number]["key"];
const FIELD_KEYS = new Set<string>(IMPORT_FIELDS.map((f) => f.key));

// Header aliases, matched after normalising the header to [a-z0-9] only.
const ALIASES: Record<ImportField, string[]> = {
  contactName: ["contactname", "name", "fullname", "contact", "person", "leadname", "customername", "clientname"],
  contactPhone: ["contactphone", "phone", "mobile", "phonenumber", "mobilenumber", "number", "whatsapp", "cell", "tel", "telephone"],
  contactEmail: ["contactemail", "email", "emailaddress", "mail"],
  contactDesignation: ["contactdesignation", "designation", "title", "jobtitle", "role", "position"],
  companyName: ["companyname", "company", "organisation", "organization", "org", "account", "accountname", "employer", "firm"],
  industry: ["industry", "sector", "vertical"],
  companySize: ["companysize", "size", "employees", "headcount", "teamsize"],
  location: ["location", "city", "town"],
  address: ["address", "fulladdress", "streetaddress"],
  website: ["website", "url", "domain", "web", "site"],
  gstin: ["gstin", "gst", "gstno", "gstnumber"],
  source: ["source", "channel", "leadsource", "origin"],
  budget: ["budget"],
  dealValue: ["dealvalue", "value", "deal", "amount", "dealsize", "revenue", "estimatedvalue"],
  currency: ["currency", "ccy"],
  notes: ["notes", "note", "remarks", "comments", "comment", "description", "message"],
  nextFollowUpDate: ["nextfollowupdate", "nextfollowup", "followupdate", "followup", "nextaction", "nextactiondate"],
  followUpNotes: ["followupnotes", "followupnote", "nextsteps", "nextstep"],
};

export const normHeader = (h: string) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** column → field (or "" when nothing matched). Each field is used once. */
export function suggestMapping(columns: string[]): Record<string, ImportField | ""> {
  const out: Record<string, ImportField | ""> = {};
  const taken = new Set<ImportField>();
  for (const col of columns) {
    const n = normHeader(col);
    let hit: ImportField | "" = "";
    if (n) {
      for (const f of IMPORT_FIELDS) {
        if (taken.has(f.key)) continue;
        if (ALIASES[f.key].includes(n)) { hit = f.key; break; }
      }
    }
    if (hit) taken.add(hit);
    out[col] = hit;
  }
  return out;
}

/* ───────────────────────────── parse ───────────────────────────── */

export interface ParsedSheet {
  columns: string[];
  rows: Record<string, string>[];
  /** Rows beyond IMPORT_ROW_CAP were dropped. */
  truncated: boolean;
  totalRows: number;
}

/** CSV or XLSX (first sheet). Cells come back as trimmed strings; blank rows are dropped. */
export function parseSpreadsheet(buffer: Buffer): ParsedSheet {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true, raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { columns: [], rows: [], truncated: false, totalRows: 0 };
  const grid: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: "" });
  if (!grid.length) return { columns: [], rows: [], truncated: false, totalRows: 0 };

  // Headers: trimmed, de-duplicated ("Phone", "Phone (2)"), blanks named by position.
  const seen = new Map<string, number>();
  const columns = (grid[0] as any[]).map((h, i) => {
    let name = String(h ?? "").trim() || `Column ${i + 1}`;
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    return name;
  });

  const body = grid.slice(1).filter((r) => (r as any[]).some((c) => String(c ?? "").trim() !== ""));
  const totalRows = body.length;
  const rows = body.slice(0, IMPORT_ROW_CAP).map((r) => {
    const o: Record<string, string> = {};
    columns.forEach((c, i) => { o[c] = String((r as any[])[i] ?? "").trim(); });
    return o;
  });
  return { columns, rows, truncated: totalRows > IMPORT_ROW_CAP, totalRows };
}

/* ───────────────────────────── validate ───────────────────────────── */

export interface ImportDefaults {
  source: string;
  assignedTo?: string | null;
}

export interface ValidatedRow {
  row: number; // 1-based position in the file body
  values: Record<string, string>; // raw cells by column
  lead: AnyObj | null; // the Lead.create body, when valid
  errors: string[];
  warnings: string[];
}

const SOURCE_BY_LABEL: Record<string, string> = {
  manual: "manual", website: "website", web: "website", linkedin: "linkedin", facebook: "facebook", fb: "facebook", instagram: "instagram", ig: "instagram",
  referral: "referral", reference: "referral", referred: "referral", coldcall: "cold_call", cold_call: "cold_call", call: "cold_call", email: "email", other: "other", others: "other",
};
export function normaliseSource(v: string): string {
  const k = String(v || "").toLowerCase().replace(/[\s-]+/g, "");
  return SOURCE_BY_LABEL[k] || SOURCE_BY_LABEL[k.replace(/_/g, "")] || "";
}

function parseDate(v: string): Date | null {
  const s = String(v || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (m) {
    const d = new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00.000Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseMoney(v: string): number | null {
  const s = String(v || "").replace(/[^\d.-]/g, "");
  if (!s) return 0;
  const n = Number(s);
  return isNaN(n) || n < 0 ? null : n;
}

/** Apply `mapping` to every row and validate. Pure. */
export function validateRows(rows: Record<string, string>[], mapping: Record<string, string>, defaults: ImportDefaults): ValidatedRow[] {
  const byField: Partial<Record<ImportField, string>> = {};
  for (const [col, field] of Object.entries(mapping || {})) if (field && FIELD_KEYS.has(field)) byField[field as ImportField] = col;
  const get = (r: Record<string, string>, f: ImportField) => (byField[f] ? String(r[byField[f]!] ?? "").trim() : "");

  return rows.map((values, i) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const contactName = get(values, "contactName");
    const contactPhone = get(values, "contactPhone");
    if (!contactName) errors.push("Contact name is required");
    if (!contactPhone) errors.push("Contact phone is required");
    else if (contactPhone.replace(/\D/g, "").length < 6) errors.push("Contact phone doesn't look like a phone number");

    const email = get(values, "contactEmail");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Contact email is not a valid address");

    let source = defaults.source;
    const rowSource = get(values, "source");
    if (rowSource) {
      const s = normaliseSource(rowSource);
      if (s) source = s;
      else warnings.push(`Source "${rowSource}" isn't a known channel — using the batch default`);
    }

    const dealValue = parseMoney(get(values, "dealValue"));
    if (dealValue === null) errors.push("Deal value must be a number");

    let currency = get(values, "currency").toUpperCase();
    if (currency && !["INR", "USD", "AED"].includes(currency)) { warnings.push(`Currency "${currency}" not supported — using INR`); currency = ""; }

    const fuRaw = get(values, "nextFollowUpDate");
    const nextFollowUpDate = fuRaw ? parseDate(fuRaw) : null;
    if (fuRaw && !nextFollowUpDate) errors.push("Next follow-up date isn't a date (use dd-mm-yyyy or ISO)");

    const companyName = get(values, "companyName");
    const lead: AnyObj | null = errors.length
      ? null
      : {
          type: companyName ? "company" : "individual",
          contactName,
          contactPhone,
          contactEmail: email,
          contactDesignation: get(values, "contactDesignation"),
          companyName,
          industry: get(values, "industry"),
          companySize: get(values, "companySize"),
          location: get(values, "location"),
          address: get(values, "address"),
          website: get(values, "website"),
          gstin: get(values, "gstin"),
          source,
          budget: get(values, "budget"),
          dealValue: dealValue ?? 0,
          currency: currency || "INR",
          notes: get(values, "notes"),
          followUpNotes: get(values, "followUpNotes"),
          ...(nextFollowUpDate ? { nextFollowUpDate } : {}),
        };
    return { row: i + 1, values, lead, errors, warnings };
  });
}

/* ───────────────────────────── dedupe snapshot ───────────────────────────── */

export interface DuplicateHit {
  leadId: string;
  leadCode: string;
  contactName: string;
  ownerName: string;
  status: string;
}
export interface DedupeInfo {
  /** The company's OPEN leads that existed before this batch (advisory flag). */
  existingOpen: DuplicateHit[];
  /** How many other rows in this file name the same company. */
  sameCompanyRowsInFile: number;
}

/** One companyCheck per distinct company name in the batch, taken before any write. */
export async function dedupeSnapshot(rows: ValidatedRow[]): Promise<Map<number, DedupeInfo>> {
  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    const key = r.lead?.companyName ? normalizeCompanyName(r.lead.companyName) : "";
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) || []), r.row]);
  }
  const out = new Map<number, DedupeInfo>();
  for (const [key, rowNos] of byKey) {
    const sample = rows.find((r) => r.row === rowNos[0])!;
    const check = await companyCheck({ name: sample.lead!.companyName });
    const existingOpen = check.leads.filter((l) => l.open).map((l) => ({ leadId: l._id, leadCode: l.leadCode, contactName: l.contactName, ownerName: l.assignedToName, status: l.status }));
    for (const n of rowNos) out.set(n, { existingOpen, sameCompanyRowsInFile: rowNos.length - 1 });
    void key;
  }
  return out;
}

/* ───────────────────────────── commit ───────────────────────────── */

export interface CommitInput {
  rows: Record<string, string>[];
  mapping: Record<string, string>;
  defaults: ImportDefaults;
  importer: { id: string; name: string };
  owner: { id: string; name: string };
  batchId?: string;
}
export interface CommitReport {
  batchId: string;
  summary: { total: number; created: number; flagged: number; invalid: number; failed: number };
  created: Array<{ row: number; leadId: string; leadCode: string; contactName: string; companyName: string; duplicateOf: DuplicateHit | null; sameCompanyRowsInFile: number }>;
  invalid: Array<{ row: number; errors: string[] }>;
  failed: Array<{ row: number; reason: string }>;
}

export async function commitImport(input: CommitInput): Promise<CommitReport> {
  const batchId = input.batchId || `IMP-${new Date().toISOString().slice(0, 10)}-${new mongoose.Types.ObjectId().toHexString().slice(-6)}`;
  const validated = validateRows(input.rows, input.mapping, input.defaults);
  const snapshot = await dedupeSnapshot(validated.filter((r) => r.lead));
  const importerId = mongoose.isValidObjectId(input.importer.id) ? new mongoose.Types.ObjectId(input.importer.id) : undefined;
  const ownerId = mongoose.isValidObjectId(input.owner.id) ? new mongoose.Types.ObjectId(input.owner.id) : undefined;

  const report: CommitReport = { batchId, summary: { total: validated.length, created: 0, flagged: 0, invalid: 0, failed: 0 }, created: [], invalid: [], failed: [] };

  for (const r of validated) {
    if (!r.lead) {
      report.invalid.push({ row: r.row, errors: r.errors });
      continue;
    }
    try {
      // Same anchor as POST /: resolve-or-create on nameNormalized, never trusted from the row.
      let companyId: mongoose.Types.ObjectId | null = null;
      if (r.lead.type === "company") {
        const co = await resolveOrCreateCompany(
          { name: r.lead.companyName, industry: r.lead.industry, companySize: r.lead.companySize, location: r.lead.location, website: r.lead.website },
          importerId
        );
        companyId = co?._id ?? null;
      }
      const dupe = snapshot.get(r.row);
      const duplicateOf = dupe?.existingOpen[0] ?? null;

      const lead = await Lead.create({
        ...r.lead,
        companyId,
        assignedTo: ownerId,
        assignedToName: input.owner.name,
        createdBy: importerId,
        importBatchId: batchId,
        possibleDuplicateOf: duplicateOf ? new mongoose.Types.ObjectId(duplicateOf.leadId) : null,
      });

      // The record on the timeline: where it came from, and the advisory flag.
      const dupeNote = duplicateOf
        ? ` Possible duplicate — ${r.lead.companyName} already had an open lead ${duplicateOf.leadCode} (${duplicateOf.contactName}${duplicateOf.ownerName ? `, owned by ${duplicateOf.ownerName}` : ""}).`
        : "";
      await LeadActivity.create({
        leadId: lead._id,
        type: "note",
        note: `Imported in batch ${batchId} by ${input.importer.name || "import"} (row ${r.row}).${dupeNote}${r.lead.notes ? `\n\n${r.lead.notes}` : ""}`,
        createdBy: importerId,
        createdByName: input.importer.name || "Import",
      });

      report.created.push({ row: r.row, leadId: String(lead._id), leadCode: lead.leadCode, contactName: lead.contactName, companyName: lead.companyName, duplicateOf, sameCompanyRowsInFile: dupe?.sameCompanyRowsInFile ?? 0 });
      report.summary.created += 1;
      if (duplicateOf) report.summary.flagged += 1;
    } catch (e: any) {
      report.failed.push({ row: r.row, reason: e?.message || "Could not create this lead" });
    }
  }
  report.summary.invalid = report.invalid.length;
  report.summary.failed = report.failed.length;
  return report;
}
