// apps/backend/src/routes/cstep.events.ts
//
// CSTEP Event Master (#15) — the named events a request can be tagged to,
// plus xlsx export and a preview → commit import (mirrors
// routes/cstep.projects.ts). Mounted at /api/cstep/events behind the same
// chain as routes/cstep.ts (requireAuth → requireWorkspace →
// requireFeature("cstepEnabled"); see server.ts).
//
// Access:
//   options (GET /options?q=) — anyone in the workspace who can file a CSTEP
//         request: the intake forms' event picker. Active events only,
//         code + name (+ dates / location, to tell them apart).
//         includeInactive=1 adds the inactive ones (and isActive), for the
//         reports' event filters — an event is usually deactivated once it
//         is over, which is when its spend is reported.
//   everything else (list / get / export / template / import / create /
//         edit / delete) — CSTEP Admin only. The master is Admin-managed;
//         Finance sees events through the reports (event filter, per-event
//         spend), not here.
//
// eventCode is CSTEP's own code (ICSE-2026), typed by the Admin — never
// generated — uppercased, unique per workspace, and fixed once created (a
// request snapshots it). In the import the code is the key: a code that
// exists updates that event, a new code creates one.

import { Router } from "express";
import mongoose from "mongoose";
import CstepEvent from "../models/cstep/CstepEvent.js";
import CstepTravelRequest from "../models/cstep/CstepTravelRequest.js";
import { ownerId, isCstepAdmin } from "../utils/cstepAccess.js";
import {
  sheetUpload,
  MAX_SHEET_ROWS,
  cellToString,
  normalizeDateField,
  readUploadedSheet,
  forEachSheetRow,
  sendSheet,
  type SheetRowOutcome,
} from "../utils/sheetImport.js";

const router = Router();

const CODE_RE = /^[A-Z0-9][A-Z0-9 ._/-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LEN = 200;

const str = (v: any) => String(v ?? "").trim();
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normCode = (v: any) => str(v).toUpperCase().replace(/\s+/g, " ");
const isDate = (v: string) => DATE_RE.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());

/* ── access ───────────────────────────────────────────────────────────── */

function requireAdmin(req: any, res: any): boolean {
  if (isCstepAdmin(req)) return true;
  res.status(403).json({ error: "The event master is managed by a CSTEP Admin" });
  return false;
}

/* ── body ─────────────────────────────────────────────────────────────── */

type EventInput = {
  eventCode?: string;
  eventName?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  isActive?: boolean;
};

function codeError(code: string): string | null {
  if (!code) return "Event code is required";
  if (!CODE_RE.test(code)) return `Event code "${code}" can use letters, digits, space, - _ . / (40 characters max)`;
  return null;
}

/** End before start is the one cross-field rule; either date alone is fine. */
function datesError(startDate?: string, endDate?: string): string | null {
  if (startDate && endDate && endDate < startDate) return "The end date can't be before the start date";
  return null;
}

/** Validates + normalises a create/edit body. `partial` = only the keys
 * present are checked (edit). The code is never part of an edit. A blank
 * date / location clears it (""). */
function readEventBody(body: any, partial: boolean): { value: EventInput; error?: string } {
  const value: EventInput = {};
  const has = (k: string) => k in (body || {});
  if (!partial) {
    value.eventCode = normCode(body?.eventCode);
    const ce = codeError(value.eventCode);
    if (ce) return { value, error: ce };
  }
  if (!partial || has("eventName")) {
    value.eventName = str(body?.eventName).replace(/\s+/g, " ");
    if (!value.eventName) return { value, error: "Event name is required" };
    if (value.eventName.length > MAX_LEN) return { value, error: `Event name is ${MAX_LEN} characters max` };
  }
  for (const [k, label] of [["startDate", "Start date"], ["endDate", "End date"]] as const) {
    if (!partial || has(k)) {
      value[k] = str(body?.[k]);
      if (value[k] && !isDate(value[k]!)) return { value, error: `${label} must be a date (YYYY-MM-DD)` };
    }
  }
  if (!partial || has("location")) {
    value.location = str(body?.location).replace(/\s+/g, " ");
    if (value.location.length > MAX_LEN) return { value, error: `Location is ${MAX_LEN} characters max` };
  }
  if (has("isActive")) value.isActive = body.isActive !== false;
  return { value };
}

/* ── list + options ───────────────────────────────────────────────────── */

router.get("/", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    const filter: any = { workspaceId: req.workspaceObjectId };
    const q = str(req.query.q);
    if (q) {
      const re = { $regex: escapeRegex(q), $options: "i" };
      filter.$or = [{ eventCode: re }, { eventName: re }, { location: re }];
    }
    if (req.query.active === "true") filter.isActive = true;
    if (req.query.active === "false") filter.isActive = false;
    const events = await CstepEvent.find(filter).sort({ eventCode: 1 }).lean();
    res.json({ ok: true, canEdit: true, events });
  } catch (err: any) {
    console.error("[CSTEP events GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load events" });
  }
});

/** The intake forms' picker: active events by code or name, best match
 * first (a code that starts with the query, then everything else). The
 * reports' filters ask for the inactive ones too. */
router.get("/options", async (req: any, res: any) => {
  try {
    const includeInactive = ["1", "true"].includes(String(req.query.includeInactive || ""));
    const filter: any = { workspaceId: req.workspaceObjectId };
    if (!includeInactive) filter.isActive = true;
    const q = str(req.query.q).slice(0, 80);
    if (q) {
      const re = { $regex: escapeRegex(q), $options: "i" };
      filter.$or = [{ eventCode: re }, { eventName: re }];
    }
    const rows: any[] = await CstepEvent.find(filter)
      .select("_id eventCode eventName startDate endDate location isActive")
      .sort({ eventCode: 1 })
      .limit(includeInactive ? 500 : 50)
      .lean();
    const lead = q.toUpperCase();
    rows.sort((a, b) => Number(!a.eventCode.startsWith(lead)) - Number(!b.eventCode.startsWith(lead)));
    res.json({
      ok: true,
      events: rows.slice(0, includeInactive ? 500 : 20).map((e) => ({
        _id: String(e._id),
        eventCode: e.eventCode,
        eventName: e.eventName,
        startDate: e.startDate || undefined,
        endDate: e.endDate || undefined,
        location: e.location || undefined,
        ...(includeInactive ? { isActive: e.isActive !== false } : {}),
      })),
    });
  } catch (err: any) {
    console.error("[CSTEP events OPTIONS]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load events" });
  }
});

/* ── export / template / import (static paths before /:id) ───────────── */

const SHEET_COLUMNS = ["Event Code", "Event Name", "Start Date", "End Date", "Location", "Active"];
// The code and both dates are typed as Text ("0042", "2026-11-05").
const TEXT_COLUMNS = [0, 2, 3];

const HEADER_FIELD_MAP: Record<string, string> = {
  eventcode: "eventCode",
  code: "eventCode",
  eventname: "eventName",
  name: "eventName",
  startdate: "startDate",
  start: "startDate",
  from: "startDate",
  enddate: "endDate",
  end: "endDate",
  to: "endDate",
  location: "location",
  venue: "location",
  active: "active",
};

router.get("/export", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    const events = await CstepEvent.find({ workspaceId: req.workspaceObjectId }).sort({ eventCode: 1 }).lean();
    await sendSheet(res, {
      format: req.query.format === "csv" ? "csv" : "xlsx",
      filename: "cstep-events",
      sheetName: "Events",
      columns: SHEET_COLUMNS,
      textColumns: TEXT_COLUMNS,
      rows: (events as any[]).map((e) => [
        e.eventCode,
        e.eventName,
        e.startDate || "",
        e.endDate || "",
        e.location || "",
        e.isActive === false ? "No" : "Yes",
      ]),
    });
  } catch (err: any) {
    console.error("[CSTEP events EXPORT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to export events" });
  }
});

router.get("/template", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    await sendSheet(res, {
      format: req.query.format === "csv" ? "csv" : "xlsx",
      filename: "cstep-events-template",
      sheetName: "Events",
      columns: SHEET_COLUMNS,
      textColumns: TEXT_COLUMNS,
    });
  } catch (err: any) {
    console.error("[CSTEP events TEMPLATE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to build the template" });
  }
});

interface EventRowOutcome extends SheetRowOutcome {
  eventCode?: string;
  eventName: string;
}

function parseActive(raw: string): boolean | undefined | "bad" {
  const v = raw.toLowerCase();
  if (!v) return undefined;
  if (["yes", "y", "true", "1", "active"].includes(v)) return true;
  if (["no", "n", "false", "0", "inactive"].includes(v)) return false;
  return "bad";
}

/**
 * Preview (dryRun) and commit share this, as the project import does.
 *   - Event Code is required on every row and is the key: one that exists
 *     UPDATES that event (only the cells the row fills — a blank cell never
 *     clears a stored value); a new one CREATES an event.
 *   - Skipped with a reason: no code / a malformed one, no name on a new
 *     event, a bad date or Active value, an end date before the start (the
 *     stored one counts when the row leaves a date blank), and the same code
 *     twice in the file.
 */
async function processEventRows(workspaceId: any, uid: string, rawRows: Record<string, any>[], dryRun: boolean): Promise<EventRowOutcome[]> {
  const outcomes: EventRowOutcome[] = [];
  const codeRows = new Map<string, number>();

  await forEachSheetRow(rawRows, HEADER_FIELD_MAP, async (mapped, rowNumber) => {
    const cell = (k: string) => cellToString(mapped[k]).replace(/\s+/g, " ");
    const code = normCode(cellToString(mapped.eventCode));
    const eventName = cell("eventName");
    const skip = (reason: string) => outcomes.push({ rowNumber, eventCode: code || undefined, eventName, action: "skip", reason });

    const ce = codeError(code);
    if (ce) return void skip(ce);
    if (codeRows.has(code)) return void skip(`Event Code ${code} is also on row ${codeRows.get(code)} of this file`);
    if (eventName.length > MAX_LEN) return void skip(`Event Name is ${MAX_LEN} characters max`);
    const start = normalizeDateField(mapped.startDate, "Start Date");
    if (start.error) return void skip(start.error);
    const end = normalizeDateField(mapped.endDate, "End Date");
    if (end.error) return void skip(end.error);
    for (const d of [start.value, end.value]) if (d && !isDate(d)) return void skip(`${d} is not a real date`);
    const location = cell("location");
    if (location.length > MAX_LEN) return void skip(`Location is ${MAX_LEN} characters max`);
    const active = parseActive(cell("active"));
    if (active === "bad") return void skip(`Active must be Yes or No, not "${cell("active")}"`);

    const existing: any = await CstepEvent.findOne({ workspaceId, eventCode: code });
    if (!existing && !eventName) return void skip("Event Name is required for a new event");
    const de = datesError(start.value || existing?.startDate, end.value || existing?.endDate);
    if (de) return void skip(de);
    codeRows.set(code, rowNumber);

    const fields: any = {};
    if (eventName) fields.eventName = eventName;
    if (start.value) fields.startDate = start.value;
    if (end.value) fields.endDate = end.value;
    if (location) fields.location = location;
    if (active !== undefined) fields.isActive = active;

    if (existing) {
      if (!dryRun) {
        existing.set({ ...fields, updatedBy: uid });
        await existing.save();
      }
      outcomes.push({ rowNumber, eventCode: code, eventName: eventName || existing.eventName, action: "update" });
      return;
    }
    if (!dryRun) await CstepEvent.create({ ...fields, workspaceId, eventCode: code, createdBy: uid });
    outcomes.push({ rowNumber, eventCode: code, eventName, action: "create" });
  });

  return outcomes;
}

async function importStep(req: any, res: any, dryRun: boolean) {
  if (!requireAdmin(req, res)) return;
  const sheet = await readUploadedSheet(req.file);
  if (sheet.error !== undefined) return res.status(400).json({ error: sheet.error });
  const results = await processEventRows(req.workspaceObjectId, ownerId(req), sheet.rows, dryRun);
  const count = (a: SheetRowOutcome["action"]) => results.filter((r) => r.action === a).length;
  res.json({
    ok: true,
    totalRows: results.length,
    maxRows: MAX_SHEET_ROWS,
    created: count("create"),
    updated: count("update"),
    skipped: count("skip"),
    results,
  });
}

router.post("/import/preview", sheetUpload.single("file"), async (req: any, res: any) => {
  try {
    await importStep(req, res, true);
  } catch (err: any) {
    console.error("[CSTEP events IMPORT PREVIEW]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to read the file" });
  }
});

router.post("/import/commit", sheetUpload.single("file"), async (req: any, res: any) => {
  try {
    await importStep(req, res, false);
  } catch (err: any) {
    console.error("[CSTEP events IMPORT COMMIT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to import" });
  }
});

/* ── single event ─────────────────────────────────────────────────────── */

router.get("/:id", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Event not found" });
    const event = await CstepEvent.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId }).lean();
    if (!event) return res.status(404).json({ error: "Event not found" });
    res.json({ ok: true, event });
  } catch (err: any) {
    console.error("[CSTEP events GET one]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the event" });
  }
});

router.post("/", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    const { value, error } = readEventBody(req.body, false);
    if (error) return res.status(400).json({ error });
    const de = datesError(value.startDate, value.endDate);
    if (de) return res.status(400).json({ error: de });
    const workspaceId = req.workspaceObjectId;
    if (await CstepEvent.exists({ workspaceId, eventCode: value.eventCode })) {
      return res.status(409).json({ error: `Event code ${value.eventCode} is already in use` });
    }
    const fields: any = { ...value, workspaceId, createdBy: ownerId(req) };
    for (const k of ["startDate", "endDate", "location"]) if (!fields[k]) delete fields[k];
    try {
      const event = await CstepEvent.create(fields);
      res.status(201).json({ ok: true, event: event.toObject() });
    } catch (err: any) {
      if (err?.code === 11000) return res.status(409).json({ error: `Event code ${value.eventCode} is already in use` });
      throw err;
    }
  } catch (err: any) {
    console.error("[CSTEP events POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to add the event" });
  }
});

router.put("/:id", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Event not found" });
    const event: any = await CstepEvent.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId });
    if (!event) return res.status(404).json({ error: "Event not found" });
    if ("eventCode" in (req.body || {}) && normCode(req.body.eventCode) !== event.eventCode) {
      return res.status(400).json({ error: "The event code can't be changed — requests keep it; add a new event instead" });
    }
    const { value, error } = readEventBody(req.body, true);
    if (error) return res.status(400).json({ error });
    const de = datesError(
      value.startDate !== undefined ? value.startDate : event.startDate,
      value.endDate !== undefined ? value.endDate : event.endDate,
    );
    if (de) return res.status(400).json({ error: de });
    for (const [k, v] of Object.entries(value)) event[k] = v === "" ? undefined : v;
    event.updatedBy = ownerId(req);
    await event.save();
    res.json({ ok: true, event: event.toObject() });
  } catch (err: any) {
    console.error("[CSTEP events PUT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update the event" });
  }
});

router.delete("/:id", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Event not found" });
    const workspaceId = req.workspaceObjectId;
    const event: any = await CstepEvent.findOne({ _id: req.params.id, workspaceId }).lean();
    if (!event) return res.status(404).json({ error: "Event not found" });
    // An event a request points at is deactivated, never deleted.
    if (await CstepTravelRequest.exists({ workspaceId, eventId: event._id })) {
      return res.status(409).json({ error: `${event.eventCode} is used on existing requests — deactivate it instead` });
    }
    await CstepEvent.deleteOne({ _id: event._id, workspaceId });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[CSTEP events DELETE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to delete the event" });
  }
});

export default router;
