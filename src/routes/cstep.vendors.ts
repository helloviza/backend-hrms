// apps/backend/src/routes/cstep.vendors.ts
//
// CSTEP Vendor Master — vendors and their editable types, plus xlsx export
// and a preview → commit import. Mounted at /api/cstep/vendors behind the
// same chain as routes/cstep.ts (requireAuth → requireWorkspace →
// requireFeature("cstepEnabled"); see server.ts), in its own file so
// cstep.ts doesn't grow further.
//
// Access:
//   read  (list / get / types / export / template) — CSTEP Admin, or a
//         Finance user (some traveller's financeUserId): Finance needs the
//         directory; paid/unpaid arrives with the payment module.
//   write (create / edit / delete / type CRUD / import) — CSTEP Admin only.
//
// vendorCode (CSTEPVEN0001…) comes from the continuous VENDOR series
// (utils/cstepSequence.ts) on create and on import-create; it is never
// edited. The name is not unique — an exact duplicate is a warning, not a
// refusal. GSTIN is optional; a value that isn't the 15-character GSTIN
// shape is a warning too, never a refusal.

import { Router } from "express";
import mongoose from "mongoose";
import CstepVendor from "../models/cstep/CstepVendor.js";
import CstepVendorType from "../models/cstep/CstepVendorType.js";
import CstepVendorInvoice from "../models/cstep/CstepVendorInvoice.js";
import CstepExpenseLine from "../models/cstep/CstepExpenseLine.js";
import Counter from "../models/Counter.js";
import { ownerId, isCstepAdmin, isCstepFinanceUser } from "../utils/cstepAccess.js";
import { nextCstepSerial, formatCstepVendorCode } from "../utils/cstepSequence.js";
import {
  sheetUpload,
  MAX_SHEET_ROWS,
  cellToString,
  readUploadedSheet,
  forEachSheetRow,
  sendSheet,
  type SheetRowOutcome,
} from "../utils/sheetImport.js";

const router = Router();

/** The list a workspace starts with. Seeded once; editable from then on —
 * a workspace already seeded keeps whatever list it has. */
export const STARTER_VENDOR_TYPES = [
  "Travel", "Cab", "Hotel", "Airline", "Railway", "Stationery", "Catering", "Printing",
  "Courier", "Equipment Rental", "Venue", "Miscellaneous",
];

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = (v: any) => String(v ?? "").trim();
const nameKey = (v: any) => str(v).replace(/\s+/g, " ").toLowerCase();
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function gstinWarning(gstin: string): string | null {
  if (!gstin) return null;
  return GSTIN_RE.test(gstin) ? null : `GSTIN ${gstin} doesn't look like a 15-character GSTIN (e.g. 29ABCDE1234F1Z5) — saved anyway`;
}

/* ── access ───────────────────────────────────────────────────────────── */

function requireAdmin(req: any, res: any): boolean {
  if (isCstepAdmin(req)) return true;
  res.status(403).json({ error: "Only a CSTEP Admin can change the vendor master" });
  return false;
}

async function requireReader(req: any, res: any): Promise<boolean> {
  if (isCstepAdmin(req) || (await isCstepFinanceUser(req))) return true;
  res.status(403).json({ error: "The vendor master is open to CSTEP Admin and Finance users" });
  return false;
}

/* ── vendor types ─────────────────────────────────────────────────────── */

/**
 * Seeds the starter list exactly once per workspace — the first time any
 * vendor route runs there. A marker on the Counter collection (upserted
 * atomically) records that it happened, so a workspace that later deletes
 * every type is not re-seeded behind its back, and two first requests
 * racing seed only once.
 */
async function ensureVendorTypes(workspaceId: any): Promise<void> {
  const r = await Counter.updateOne(
    { _id: `cstep:${String(workspaceId)}:VENDOR_TYPES_SEEDED` } as any,
    { $setOnInsert: { seq: 1 } },
    { upsert: true },
  );
  if (!r.upsertedCount) return;
  await CstepVendorType.insertMany(
    STARTER_VENDOR_TYPES.map((name) => ({ workspaceId, name, isActive: true })),
    { ordered: false },
  ).catch((err: any) => {
    if (err?.code !== 11000 && !err?.writeErrors) throw err;
  });
}

async function findTypeByName(workspaceId: any, name: string, excludeId?: any) {
  const filter: any = { workspaceId, name: { $regex: `^${escapeRegex(str(name))}$`, $options: "i" } };
  if (excludeId) filter._id = { $ne: excludeId };
  return CstepVendorType.findOne(filter).lean();
}

router.get("/types", async (req: any, res: any) => {
  try {
    if (!(await requireReader(req, res))) return;
    await ensureVendorTypes(req.workspaceObjectId);
    const types = await CstepVendorType.find({ workspaceId: req.workspaceObjectId }).sort({ name: 1 }).lean();
    const counts = await CstepVendor.aggregate([
      { $match: { workspaceId: req.workspaceObjectId } },
      { $group: { _id: "$vendorTypeId", n: { $sum: 1 } } },
    ]);
    const used = new Map(counts.map((c: any) => [String(c._id), c.n]));
    res.json({ ok: true, types: types.map((t: any) => ({ ...t, vendorCount: used.get(String(t._id)) || 0 })) });
  } catch (err: any) {
    console.error("[CSTEP vendors types GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load vendor types" });
  }
});

router.post("/types", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    await ensureVendorTypes(req.workspaceObjectId);
    const name = str(req.body?.name).replace(/\s+/g, " ");
    if (!name) return res.status(400).json({ error: "Type name is required" });
    if (await findTypeByName(req.workspaceObjectId, name)) {
      return res.status(409).json({ error: `A vendor type called "${name}" already exists` });
    }
    const type = await CstepVendorType.create({ workspaceId: req.workspaceObjectId, name, isActive: true });
    res.status(201).json({ ok: true, type });
  } catch (err: any) {
    if (err?.code === 11000) return res.status(409).json({ error: "That vendor type already exists" });
    console.error("[CSTEP vendors types POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to add the vendor type" });
  }
});

router.put("/types/:id", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Vendor type not found" });
    const type: any = await CstepVendorType.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId });
    if (!type) return res.status(404).json({ error: "Vendor type not found" });
    if ("name" in (req.body || {})) {
      const name = str(req.body.name).replace(/\s+/g, " ");
      if (!name) return res.status(400).json({ error: "Type name is required" });
      if (await findTypeByName(req.workspaceObjectId, name, type._id)) {
        return res.status(409).json({ error: `A vendor type called "${name}" already exists` });
      }
      type.name = name;
    }
    if ("isActive" in (req.body || {})) type.isActive = req.body.isActive !== false;
    await type.save();
    res.json({ ok: true, type });
  } catch (err: any) {
    if (err?.code === 11000) return res.status(409).json({ error: "That vendor type already exists" });
    console.error("[CSTEP vendors types PUT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update the vendor type" });
  }
});

router.delete("/types/:id", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Vendor type not found" });
    const type: any = await CstepVendorType.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId }).lean();
    if (!type) return res.status(404).json({ error: "Vendor type not found" });
    const inUse = await CstepVendor.countDocuments({ workspaceId: req.workspaceObjectId, vendorTypeId: type._id });
    if (inUse) {
      return res.status(409).json({
        error: `${inUse} vendor${inUse === 1 ? " uses" : "s use"} "${type.name}" — move them to another type, or deactivate it instead`,
      });
    }
    await CstepVendorType.deleteOne({ _id: type._id, workspaceId: req.workspaceObjectId });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[CSTEP vendors types DELETE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to delete the vendor type" });
  }
});

/* ── vendors ──────────────────────────────────────────────────────────── */

type VendorInput = {
  name?: string;
  vendorTypeId?: any;
  mobile?: string;
  email?: string;
  address?: string;
  city?: string;
  gstin?: string;
  tdsSection?: string;
  tdsRate?: number | null;
  isActive?: boolean;
};

const PLAIN_FIELDS = ["mobile", "address", "city", "tdsSection"] as const;

/** Validates + normalises a create/edit body. `partial` = only the keys
 * present are checked (edit). */
async function readVendorBody(
  workspaceId: any,
  body: any,
  partial: boolean,
): Promise<{ value: VendorInput; error?: string }> {
  const value: VendorInput = {};
  const has = (k: string) => k in (body || {});

  if (!partial || has("name")) {
    value.name = str(body?.name);
    if (!value.name) return { value, error: "Vendor name is required" };
  }
  if (!partial || has("vendorTypeId")) {
    const id = str(body?.vendorTypeId);
    if (!id) return { value, error: "Vendor type is required" };
    if (!mongoose.isValidObjectId(id)) return { value, error: "Unknown vendor type" };
    const type: any = await CstepVendorType.findOne({ _id: id, workspaceId }).lean();
    if (!type) return { value, error: "Unknown vendor type" };
    if (!type.isActive) return { value, error: `Vendor type "${type.name}" is inactive` };
    value.vendorTypeId = type._id;
  }
  for (const k of PLAIN_FIELDS) if (!partial || has(k)) (value as any)[k] = str(body?.[k]);
  if (!partial || has("email")) {
    value.email = str(body?.email).toLowerCase();
    if (value.email && !EMAIL_RE.test(value.email)) return { value, error: "Invalid email format" };
  }
  if (!partial || has("gstin")) value.gstin = str(body?.gstin).toUpperCase();
  if (has("tdsRate")) {
    const raw = body.tdsRate;
    if (raw === null || raw === "" || raw === undefined) value.tdsRate = null;
    else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) return { value, error: "TDS rate must be a percentage between 0 and 100" };
      value.tdsRate = n;
    }
  }
  if (has("isActive")) value.isActive = body.isActive !== false;
  return { value };
}

/** The exact-duplicate-name warning (case and spacing ignored). */
async function duplicateNameWarning(workspaceId: any, name: string, excludeId?: any): Promise<string | null> {
  const filter: any = { workspaceId, name: { $regex: `^\\s*${escapeRegex(name).replace(/\s+/g, "\\s+")}\\s*$`, $options: "i" } };
  if (excludeId) filter._id = { $ne: excludeId };
  const other: any = await CstepVendor.findOne(filter).select("vendorCode name").lean();
  return other ? `Another vendor is already called "${other.name}" (${other.vendorCode}) — saved anyway` : null;
}

/** Takes the next CSTEPVEN code. The unique index is the backstop: a code
 * that somehow already exists is skipped and the next one taken. */
async function createVendorWithCode(workspaceId: any, fields: any): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { seq } = await nextCstepSerial(workspaceId, "VENDOR");
    try {
      return await CstepVendor.create({ ...fields, workspaceId, vendorCode: formatCstepVendorCode(seq) });
    } catch (err: any) {
      if (err?.code === 11000 && err?.keyPattern?.vendorCode) continue;
      throw err;
    }
  }
  throw new Error("Could not issue a vendor code — try again");
}

function vendorJson(v: any, typeName?: string) {
  return { ...v, vendorTypeName: typeName ?? v.vendorTypeName ?? "" };
}

async function typeNames(workspaceId: any): Promise<Map<string, string>> {
  const types = await CstepVendorType.find({ workspaceId }).select("name").lean();
  return new Map(types.map((t: any) => [String(t._id), t.name]));
}

router.get("/", async (req: any, res: any) => {
  try {
    if (!(await requireReader(req, res))) return;
    const workspaceId = req.workspaceObjectId;
    await ensureVendorTypes(workspaceId);
    const filter: any = { workspaceId };
    const q = str(req.query.q);
    if (q) {
      const re = { $regex: escapeRegex(q), $options: "i" };
      filter.$or = [{ name: re }, { vendorCode: re }, { city: re }, { email: re }, { mobile: re }, { gstin: re }];
    }
    if (req.query.typeId && mongoose.isValidObjectId(String(req.query.typeId))) filter.vendorTypeId = req.query.typeId;
    if (req.query.active === "true") filter.isActive = true;
    if (req.query.active === "false") filter.isActive = false;
    const [vendors, names] = await Promise.all([
      CstepVendor.find(filter).sort({ vendorCode: 1 }).lean(),
      typeNames(workspaceId),
    ]);
    res.json({
      ok: true,
      canEdit: isCstepAdmin(req),
      vendors: vendors.map((v: any) => vendorJson(v, names.get(String(v.vendorTypeId)))),
    });
  } catch (err: any) {
    console.error("[CSTEP vendors GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load vendors" });
  }
});

/* ── export / template / import (static paths before /:id) ───────────── */

const SHEET_COLUMNS = [
  "Vendor Code", "Vendor Name", "Vendor Type", "Mobile", "Email", "Address", "City",
  "GSTIN", "TDS Section", "TDS Rate", "Active",
];

const HEADER_FIELD_MAP: Record<string, string> = {
  vendorcode: "vendorCode",
  vendorname: "name",
  name: "name",
  vendortype: "vendorType",
  type: "vendorType",
  mobile: "mobile",
  email: "email",
  address: "address",
  city: "city",
  gstin: "gstin",
  gst: "gstin",
  gstnumber: "gstin",
  tdssection: "tdsSection",
  tdsrate: "tdsRate",
  active: "active",
};

router.get("/export", async (req: any, res: any) => {
  try {
    if (!(await requireReader(req, res))) return;
    const workspaceId = req.workspaceObjectId;
    const [vendors, names] = await Promise.all([
      CstepVendor.find({ workspaceId }).sort({ vendorCode: 1 }).lean(),
      typeNames(workspaceId),
    ]);
    const rows = (vendors as any[]).map((v) => [
      v.vendorCode, v.name, names.get(String(v.vendorTypeId)) || "", v.mobile || "", v.email || "",
      v.address || "", v.city || "", v.gstin || "", v.tdsSection || "",
      v.tdsRate === null || v.tdsRate === undefined ? "" : v.tdsRate, v.isActive === false ? "No" : "Yes",
    ]);
    await sendSheet(res, {
      format: req.query.format === "csv" ? "csv" : "xlsx",
      filename: "cstep-vendors",
      sheetName: "Vendors",
      columns: SHEET_COLUMNS,
      rows,
    });
  } catch (err: any) {
    console.error("[CSTEP vendors EXPORT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to export vendors" });
  }
});

router.get("/template", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    await sendSheet(res, {
      format: req.query.format === "csv" ? "csv" : "xlsx",
      filename: "cstep-vendors-template",
      sheetName: "Vendors",
      columns: SHEET_COLUMNS,
    });
  } catch (err: any) {
    console.error("[CSTEP vendors TEMPLATE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to build the template" });
  }
});

interface VendorRowOutcome extends SheetRowOutcome {
  name: string;
  vendorCode?: string;
  warnings?: string[];
}

function parseActive(raw: string): boolean | undefined | "bad" {
  const v = raw.toLowerCase();
  if (!v) return undefined;
  if (["yes", "y", "true", "1", "active"].includes(v)) return true;
  if (["no", "n", "false", "0", "inactive"].includes(v)) return false;
  return "bad";
}

/**
 * Preview (dryRun) and commit share this, same as the traveller import.
 *   - A Vendor Code that matches an existing vendor UPDATES it — only the
 *     cells the row fills; a blank cell never clears a stored value.
 *   - No Vendor Code → a NEW vendor with a fresh code (taken at commit
 *     only — a preview consumes nothing).
 *   - A Vendor Code that matches nothing is SKIPPED, never created under a
 *     new code: a mistyped code would otherwise duplicate the vendor.
 *   - Skipped with a reason: missing name / type (on a create), unknown or
 *     inactive type, bad email, bad Active or TDS rate value, and an
 *     in-file duplicate (the same Vendor Code twice, or — for new rows —
 *     the same name twice).
 *   - Warned, never skipped: a GSTIN that isn't the 15-char shape, and a
 *     new vendor whose name exactly matches an existing one.
 */
async function processVendorRows(
  workspaceId: any,
  uid: string,
  rawRows: Record<string, any>[],
  dryRun: boolean,
): Promise<VendorRowOutcome[]> {
  const outcomes: VendorRowOutcome[] = [];
  const types = await CstepVendorType.find({ workspaceId }).lean();
  const typeByName = new Map(types.map((t: any) => [nameKey(t.name), t]));
  const codeRows = new Map<string, number>();
  const newNameRows = new Map<string, number>();

  await forEachSheetRow(rawRows, HEADER_FIELD_MAP, async (mapped, rowNumber) => {
    const cell = (k: string) => cellToString(mapped[k]);
    const name = cell("name");
    const code = cell("vendorCode").toUpperCase();
    const skip = (reason: string) => outcomes.push({ rowNumber, name, vendorCode: code || undefined, action: "skip", reason });

    let existing: any = null;
    if (code) {
      if (codeRows.has(code)) return void skip(`Vendor Code ${code} is also on row ${codeRows.get(code)} of this file`);
      existing = await CstepVendor.findOne({ workspaceId, vendorCode: code });
      if (!existing) return void skip(`No vendor with code ${code} — leave Vendor Code blank to add a new vendor`);
    } else {
      if (!name) return void skip("Vendor Name is required");
      const key = nameKey(name);
      if (newNameRows.has(key)) return void skip(`"${name}" is also a new vendor on row ${newNameRows.get(key)} of this file`);
    }

    const typeName = cell("vendorType");
    let typeId: any;
    if (typeName) {
      const t: any = typeByName.get(nameKey(typeName));
      if (!t) return void skip(`Unknown vendor type "${typeName}" — add it under Manage types first, or correct the spelling`);
      if (!t.isActive) return void skip(`Vendor type "${t.name}" is inactive`);
      typeId = t._id;
    } else if (!existing) {
      return void skip("Vendor Type is required");
    }

    const email = cell("email").toLowerCase();
    if (email && !EMAIL_RE.test(email)) return void skip("Invalid email format");
    const active = parseActive(cell("active"));
    if (active === "bad") return void skip(`Active must be Yes or No, not "${cell("active")}"`);
    const tdsRaw = cell("tdsRate");
    let tdsRate: number | undefined;
    if (tdsRaw) {
      tdsRate = Number(tdsRaw.replace(/%$/, ""));
      if (!Number.isFinite(tdsRate) || tdsRate < 0 || tdsRate > 100) return void skip("TDS Rate must be a percentage between 0 and 100");
    }

    const gstin = cell("gstin").toUpperCase();
    const warnings: string[] = [];
    const gw = gstinWarning(gstin);
    if (gw) warnings.push(gw);

    if (code) codeRows.set(code, rowNumber);
    else newNameRows.set(nameKey(name), rowNumber);

    const fields: any = {};
    if (name) fields.name = name;
    if (typeId) fields.vendorTypeId = typeId;
    for (const k of ["mobile", "address", "city", "tdsSection"]) if (cell(k)) fields[k] = cell(k);
    if (email) fields.email = email;
    if (gstin) fields.gstin = gstin;
    if (tdsRate !== undefined) fields.tdsRate = tdsRate;
    if (active !== undefined) fields.isActive = active;

    if (existing) {
      if (!dryRun) {
        existing.set({ ...fields, updatedBy: uid });
        await existing.save();
      }
      outcomes.push({ rowNumber, name: name || existing.name, vendorCode: existing.vendorCode, action: "update", warnings });
      return;
    }

    const dup = await duplicateNameWarning(workspaceId, name);
    if (dup) warnings.push(dup);
    if (dryRun) {
      outcomes.push({ rowNumber, name, action: "create", warnings });
      return;
    }
    const created = await createVendorWithCode(workspaceId, { ...fields, createdBy: uid });
    outcomes.push({ rowNumber, name, vendorCode: created.vendorCode, action: "create", warnings });
  });

  return outcomes.map((o) => (o.warnings && !o.warnings.length ? { ...o, warnings: undefined } : o));
}

async function importStep(req: any, res: any, dryRun: boolean) {
  if (!requireAdmin(req, res)) return;
  const workspaceId = req.workspaceObjectId;
  await ensureVendorTypes(workspaceId);
  const sheet = await readUploadedSheet(req.file);
  if (sheet.error !== undefined) return res.status(400).json({ error: sheet.error });
  const results = await processVendorRows(workspaceId, ownerId(req), sheet.rows, dryRun);
  const count = (a: SheetRowOutcome["action"]) => results.filter((r) => r.action === a).length;
  res.json({
    ok: true,
    totalRows: results.length,
    maxRows: MAX_SHEET_ROWS,
    created: count("create"),
    updated: count("update"),
    skipped: count("skip"),
    warned: results.filter((r) => r.warnings?.length).length,
    results,
  });
}

router.post("/import/preview", sheetUpload.single("file"), async (req: any, res: any) => {
  try {
    await importStep(req, res, true);
  } catch (err: any) {
    console.error("[CSTEP vendors IMPORT PREVIEW]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to read the file" });
  }
});

router.post("/import/commit", sheetUpload.single("file"), async (req: any, res: any) => {
  try {
    await importStep(req, res, false);
  } catch (err: any) {
    console.error("[CSTEP vendors IMPORT COMMIT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to import" });
  }
});

/* ── single vendor ────────────────────────────────────────────────────── */

router.get("/:id", async (req: any, res: any) => {
  try {
    if (!(await requireReader(req, res))) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Vendor not found" });
    const v: any = await CstepVendor.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId }).lean();
    if (!v) return res.status(404).json({ error: "Vendor not found" });
    const names = await typeNames(req.workspaceObjectId);
    res.json({ ok: true, vendor: vendorJson(v, names.get(String(v.vendorTypeId))) });
  } catch (err: any) {
    console.error("[CSTEP vendors GET one]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the vendor" });
  }
});

router.post("/", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    const workspaceId = req.workspaceObjectId;
    await ensureVendorTypes(workspaceId);
    // Validated in full BEFORE a code is taken, so a refused create burns
    // no number in the continuous series.
    const { value, error } = await readVendorBody(workspaceId, req.body, false);
    if (error) return res.status(400).json({ error });
    const warnings = [await duplicateNameWarning(workspaceId, value.name!), gstinWarning(value.gstin || "")].filter(Boolean);
    const fields: any = { ...value, createdBy: ownerId(req) };
    for (const k of Object.keys(fields)) if (fields[k] === "" || fields[k] === null) delete fields[k];
    const vendor = await createVendorWithCode(workspaceId, fields);
    res.status(201).json({ ok: true, vendor: vendor.toObject(), warnings });
  } catch (err: any) {
    console.error("[CSTEP vendors POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to add the vendor" });
  }
});

router.put("/:id", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Vendor not found" });
    const workspaceId = req.workspaceObjectId;
    const vendor: any = await CstepVendor.findOne({ _id: req.params.id, workspaceId });
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });
    if ("vendorCode" in (req.body || {}) && str(req.body.vendorCode).toUpperCase() !== vendor.vendorCode) {
      return res.status(400).json({ error: "The vendor code is issued automatically and can't be changed" });
    }
    const { value, error } = await readVendorBody(workspaceId, req.body, true);
    if (error) return res.status(400).json({ error });
    const warnings: string[] = [];
    if (value.name !== undefined && nameKey(value.name) !== nameKey(vendor.name)) {
      const dup = await duplicateNameWarning(workspaceId, value.name, vendor._id);
      if (dup) warnings.push(dup);
    }
    if (value.gstin !== undefined && value.gstin !== (vendor.gstin || "")) {
      const gw = gstinWarning(value.gstin);
      if (gw) warnings.push(gw);
    }
    for (const [k, v] of Object.entries(value)) vendor[k] = v === "" || v === null ? undefined : v;
    vendor.updatedBy = ownerId(req);
    await vendor.save();
    res.json({ ok: true, vendor: vendor.toObject(), warnings });
  } catch (err: any) {
    console.error("[CSTEP vendors PUT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update the vendor" });
  }
});

router.delete("/:id", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Vendor not found" });
    const workspaceId = req.workspaceObjectId;
    const vendor: any = await CstepVendor.findOne({ _id: req.params.id, workspaceId }).lean();
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });
    // A vendor something already points at is deactivated, never deleted —
    // its code stays resolvable on those records.
    const [invoices, lines] = await Promise.all([
      CstepVendorInvoice.countDocuments({ workspaceId, vendorId: vendor._id }),
      CstepExpenseLine.countDocuments({ workspaceId, vendorId: vendor._id }),
    ]);
    if (invoices || lines) {
      return res.status(409).json({ error: `${vendor.vendorCode} is used on existing records — deactivate it instead` });
    }
    await CstepVendor.deleteOne({ _id: vendor._id, workspaceId });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[CSTEP vendors DELETE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to delete the vendor" });
  }
});

export default router;
