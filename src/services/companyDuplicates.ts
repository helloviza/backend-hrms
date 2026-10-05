// apps/backend/src/services/companyDuplicates.ts
//
// READ-ONLY detection of likely duplicate companies (Customer + its
// CustomerWorkspace). Nothing here writes. A "company" is any account with a
// Customer / workspace — businesses, affiliates, agents, partners alike.
//
// Two records are linked when they share:
//   • a normalised name (case, punctuation, "&"→"and", extra spaces, and trailing
//     legal suffixes: Private Limited / Pvt Ltd / Ltd / Limited / LLP / OPC …),
//   • a GSTIN, or a PAN (also read from a GSTIN's characters 3–12),
//   • a company email domain (public mail domains like gmail.com never link).
// Links are transitive (union-find), so A~B and B~C put all three in one group.
// The "main" record is a SUGGESTION: the one with the most linked data.
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Customer from "../models/Customer.js";
import User from "../models/User.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import ManualBooking from "../models/ManualBooking.js";
import Invoice from "../models/Invoice.js";
import CreditNote from "../models/CreditNote.js";
import SBTWalletLedger from "../models/SBTWalletLedger.js";
import SBTMarginOverride from "../models/SBTMarginOverride.js";
import { companyNameOf } from "./companyNames.js";

type AnyObj = Record<string, any>;

const LEGAL_SUFFIX = new Set(["private", "pvt", "limited", "ltd", "llp", "opc", "plc", "inc", "pte", "pl"]);
const PUBLIC_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "icloud.com", "me.com", "rediffmail.com", "aol.com", "protonmail.com", "proton.me", "zoho.com", "ymail.com",
]);

/** "LLAMA LOGISOL PRIVATE LIMITED" and "Llama Logisol Pvt. Ltd." → "llama logisol". */
export function normaliseCompanyName(v: unknown): string {
  const words = String(v ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)/g, (m) => (/opc/.test(m) ? " opc " : m)) // "(OPC)" is a suffix; keep other bracketed words
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIX.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

export const nameKey = (v: unknown) => normaliseCompanyName(v).replace(/\s+/g, "");
export const normGstin = (v: unknown) => {
  const s = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 15 ? s : "";
};
export const normPan = (v: unknown) => {
  const s = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s) ? s : "";
};
export const panFromGstin = (g: string) => (g.length === 15 ? normPan(g.slice(2, 12)) : "");
export function companyDomain(email: unknown): string {
  const d = String(email ?? "").toLowerCase().trim().split("@")[1] || "";
  return d && !PUBLIC_MAIL.has(d) ? d : "";
}

export interface CompanyRecord {
  key: string; // stable id for grouping (workspace id, else customer id)
  names: string[];
  gstin: string;
  pan: string;
  emailDomain: string;
}

export interface DuplicateGroup {
  keys: string[];
  reasons: string[]; // e.g. name:"llama logisol", gstin:…, pan:…, domain:…
}

/** Group records that share a name key, GSTIN, PAN or company email domain. */
export function groupDuplicates(records: CompanyRecord[]): DuplicateGroup[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const r of records) parent.set(r.key, r.key);

  const byToken = new Map<string, string[]>();
  for (const r of records) {
    const tokens = new Set<string>();
    for (const n of r.names) { const k = nameKey(n); if (k) tokens.add(`name:${normaliseCompanyName(n)}`); }
    if (r.gstin) tokens.add(`gstin:${r.gstin}`);
    const pan = r.pan || panFromGstin(r.gstin);
    if (pan) tokens.add(`pan:${pan}`);
    if (r.emailDomain) tokens.add(`domain:${r.emailDomain}`);
    for (const t of tokens) {
      // Names compare without spaces ("logi sol" = "logisol"); the reason keeps the readable form.
      const k = t.startsWith("name:") ? `name:${t.slice(5).replace(/\s+/g, "")}` : t;
      if (!byToken.has(k)) byToken.set(k, []);
      byToken.get(k)!.push(`${r.key}\u0000${t}`);
    }
  }
  const reasonsByRoot = new Map<string, Set<string>>();
  for (const entries of byToken.values()) {
    const keys = [...new Set(entries.map((e) => e.split("\u0000")[0]))];
    if (keys.length < 2) continue;
    for (let i = 1; i < keys.length; i++) union(keys[0], keys[i]);
    const reason = entries[0].split("\u0000")[1];
    const root = find(keys[0]);
    if (!reasonsByRoot.has(root)) reasonsByRoot.set(root, new Set());
    reasonsByRoot.get(root)!.add(reason);
  }
  const groups = new Map<string, string[]>();
  for (const r of records) {
    const root = find(r.key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(r.key);
  }
  const out: DuplicateGroup[] = [];
  for (const [root, keys] of groups) {
    if (keys.length < 2) continue;
    // Reasons were filed under whatever the root was then; collect any that now resolve here.
    const reasons = new Set<string>();
    for (const [rr, set] of reasonsByRoot) if (find(rr) === root) for (const s of set) reasons.add(s);
    out.push({ keys, reasons: [...reasons].sort() });
  }
  return out;
}

/* ───────────────────────── the report (reads only) ───────────────────────── */

export interface ReportRow {
  group: number;
  main: boolean;
  name: string;
  gstin: string;
  pan: string;
  emailDomain: string;
  createdAt: Date | null;
  workspaceId: string;
  customerId: string;
  workspaceStatus: string;
  walletOn: boolean;
  creditLimit: number;
  used: number;
  marginOverride: boolean;
  counts: { users: number; approvalRequests: number; sbtBookings: number; manualBookings: number; invoices: number; creditNotes: number; walletEntries: number };
  linkedTotal: number;
  reasons: string;
}

const isHex = (v: unknown) => /^[a-f0-9]{24}$/i.test(String(v ?? ""));
const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v));

/** Every likely-duplicate group with per-record linked-data counts. Read-only. */
export async function collectDuplicateReport(): Promise<{ rows: ReportRow[]; unnamed: Array<{ workspaceId: string; customerId: string; slug: string }> }> {
  const workspaces = (await CustomerWorkspace.find({})
    .select("customerId slug companyName gstNumber pan status createdAt sbtOfficialBooking allowedDomains")
    .lean()) as AnyObj[];
  const customers = (await Customer.find({}).select("name legalName gstNumber panNumber email createdAt").lean()) as AnyObj[];
  const custById = new Map(customers.map((c) => [String(c._id), c]));
  const wsByCustomer = new Map(workspaces.map((w) => [String(w.customerId), w]));

  type Rec = CompanyRecord & { ws: AnyObj | null; cust: AnyObj | null };
  const recs: Rec[] = [];
  for (const w of workspaces) {
    const c = custById.get(String(w.customerId)) || null;
    const gstin = normGstin(w.gstNumber) || normGstin(c?.gstNumber);
    recs.push({
      key: `ws:${w._id}`, ws: w, cust: c,
      names: [c?.name, c?.legalName, w.companyName].filter((n) => typeof n === "string" && n.trim()),
      gstin, pan: normPan(w.pan) || normPan(c?.panNumber), emailDomain: companyDomain(c?.email),
    });
  }
  for (const c of customers) {
    if (wsByCustomer.has(String(c._id))) continue; // already represented by its workspace
    recs.push({
      key: `cust:${c._id}`, ws: null, cust: c,
      names: [c.name, c.legalName].filter((n) => typeof n === "string" && n.trim()),
      gstin: normGstin(c.gstNumber), pan: normPan(c.panNumber), emailDomain: companyDomain(c.email),
    });
  }
  const recByKey = new Map(recs.map((r) => [r.key, r]));
  const groups = groupDuplicates(recs);

  const rows: ReportRow[] = [];
  let gi = 0;
  for (const g of groups) {
    gi++;
    const groupRows: ReportRow[] = [];
    for (const key of g.keys) {
      const r = recByKey.get(key)!;
      const w = r.ws;
      const custId = String(r.cust?._id || w?.customerId || "");
      const wsId = w ? String(w._id) : "";
      const custOr: AnyObj[] = isHex(custId) ? [{ customerId: custId }] : [];
      const wsMatch = wsId ? { workspaceId: oid(wsId) } : null;
      const either = (extra: AnyObj[] = []) => ({ $or: [...(wsMatch ? [wsMatch] : []), ...extra] });
      const has = Boolean(wsMatch) || custOr.length > 0;
      const count = async (m: mongoose.Model<any>, filter: AnyObj) => (has ? m.countDocuments(filter) : 0);
      const counts = {
        users: await count(User, either(custOr)),
        approvalRequests: await count(ApprovalRequest, either(custOr)),
        sbtBookings: wsMatch ? (await SBTBooking.countDocuments(wsMatch)) + (await SBTHotelBooking.countDocuments(wsMatch)) : 0,
        manualBookings: await count(ManualBooking, {
          workspaceId: { $in: [...(wsId ? [oid(wsId)] : []), ...(isHex(custId) ? [oid(custId)] : [])] },
        }),
        invoices: wsMatch ? await Invoice.countDocuments(wsMatch) : 0,
        creditNotes: wsMatch ? await CreditNote.countDocuments(wsMatch) : 0,
        walletEntries: wsId ? await SBTWalletLedger.countDocuments({ workspaceId: wsId }) : 0,
      };
      const ob = w?.sbtOfficialBooking || {};
      groupRows.push({
        group: gi,
        main: false,
        name: w ? companyNameOf(w, r.cust) : (r.names[0] || "Unnamed company"),
        gstin: r.gstin,
        pan: r.pan || panFromGstin(r.gstin),
        emailDomain: r.emailDomain,
        createdAt: (w?.createdAt || r.cust?.createdAt) ?? null,
        workspaceId: wsId,
        customerId: custId,
        workspaceStatus: w ? String(w.status || "") : "no workspace",
        walletOn: ob.enabled === true,
        creditLimit: Number(ob.creditLimit) || 0,
        used: Number(ob.used) || 0,
        marginOverride: wsId ? Boolean(await SBTMarginOverride.exists({ workspaceId: oid(wsId) })) : false,
        counts,
        linkedTotal: Object.values(counts).reduce((s, n) => s + n, 0),
        reasons: g.reasons.join("; "),
      });
    }
    // Suggested main: most linked data, then the oldest.
    groupRows.sort((a, b) => b.linkedTotal - a.linkedTotal || (a.createdAt ? +new Date(a.createdAt) : Infinity) - (b.createdAt ? +new Date(b.createdAt) : Infinity));
    groupRows[0].main = true;
    rows.push(...groupRows);
  }

  const unnamed = workspaces
    .filter((w) => /^Unnamed company/.test(companyNameOf(w, custById.get(String(w.customerId)) || null)))
    .map((w) => ({ workspaceId: String(w._id), customerId: String(w.customerId || ""), slug: String(w.slug || "") }));
  return { rows, unnamed };
}

export const REPORT_COLUMNS: Array<[string, (r: ReportRow) => string | number]> = [
  ["Group", (r) => r.group],
  ["Suggested main", (r) => (r.main ? "MAIN" : "")],
  ["Name", (r) => r.name],
  ["GSTIN", (r) => r.gstin],
  ["PAN", (r) => r.pan],
  ["Email domain", (r) => r.emailDomain],
  ["Created", (r) => (r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "")],
  ["Workspace id", (r) => r.workspaceId],
  ["Customer id", (r) => r.customerId],
  ["Workspace status", (r) => r.workspaceStatus],
  ["Wallet", (r) => (r.walletOn ? "ON" : "off")],
  ["Credit limit", (r) => r.creditLimit],
  ["Used", (r) => r.used],
  ["Margin override", (r) => (r.marginOverride ? "Y" : "N")],
  ["Users", (r) => r.counts.users],
  ["Approval requests", (r) => r.counts.approvalRequests],
  ["SBT bookings", (r) => r.counts.sbtBookings],
  ["Manual bookings", (r) => r.counts.manualBookings],
  ["Invoices", (r) => r.counts.invoices],
  ["Credit notes", (r) => r.counts.creditNotes],
  ["Wallet entries", (r) => r.counts.walletEntries],
  ["Linked total", (r) => r.linkedTotal],
  ["Why grouped", (r) => r.reasons],
];

export function reportCsv(rows: ReportRow[]): string {
  const cell = (v: unknown) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + [REPORT_COLUMNS.map(([h]) => h), ...rows.map((r) => REPORT_COLUMNS.map(([, f]) => f(r)))]
    .map((l) => l.map(cell).join(",")).join("\r\n");
}
