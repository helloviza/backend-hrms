// apps/backend/src/routes/cstep.projects.ts
//
// CSTEP Project Master — projects and their Tally cost-centre codes, plus
// xlsx export and a preview → commit import (mirrors routes/cstep.vendors.ts).
// Mounted at /api/cstep/projects behind the same chain as routes/cstep.ts
// (requireAuth → requireWorkspace → requireFeature("cstepEnabled"); see
// server.ts).
//
// Access:
//   options (GET /options?q=) — anyone in the workspace who can file a CSTEP
//         request: the intake forms' project picker. Active projects only,
//         code + name.
//   read  (list / get / export) — CSTEP Admin or a Finance user.
//   write (create / edit / delete / template / import) — CSTEP Admin only.
//
// projectCode is CSTEP's own code (PRJ-SOLAR), typed by the Admin — never
// generated — uppercased, unique per workspace, and fixed once created (a
// request snapshots it). In the import the code is the key: a code that
// exists updates that project, a new code creates one.

import { Router } from "express";
import mongoose from "mongoose";
import CstepProject from "../models/cstep/CstepProject.js";
import CstepTravelRequest from "../models/cstep/CstepTravelRequest.js";
import { ownerId, isCstepAdmin, isCstepFinanceUser } from "../utils/cstepAccess.js";
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

const CODE_RE = /^[A-Z0-9][A-Z0-9 ._/-]{0,39}$/;
const MAX_LEN = 200;

const str = (v: any) => String(v ?? "").trim();
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normCode = (v: any) => str(v).toUpperCase().replace(/\s+/g, " ");

/* ── access ───────────────────────────────────────────────────────────── */

function requireAdmin(req: any, res: any): boolean {
  if (isCstepAdmin(req)) return true;
  res.status(403).json({ error: "Only a CSTEP Admin can change the project master" });
  return false;
}

async function requireReader(req: any, res: any): Promise<boolean> {
  if (isCstepAdmin(req) || (await isCstepFinanceUser(req))) return true;
  res.status(403).json({ error: "The project master is open to CSTEP Admin and Finance users" });
  return false;
}

/* ── body ─────────────────────────────────────────────────────────────── */

type ProjectInput = { projectCode?: string; projectName?: string; tallyProjectCC?: string; isActive?: boolean };

function codeError(code: string): string | null {
  if (!code) return "Project code is required";
  if (!CODE_RE.test(code)) return `Project code "${code}" can use letters, digits, space, - _ . / (40 characters max)`;
  return null;
}

/** Validates + normalises a create/edit body. `partial` = only the keys
 * present are checked (edit). The code is never part of an edit. */
function readProjectBody(body: any, partial: boolean): { value: ProjectInput; error?: string } {
  const value: ProjectInput = {};
  const has = (k: string) => k in (body || {});
  if (!partial) {
    value.projectCode = normCode(body?.projectCode);
    const ce = codeError(value.projectCode);
    if (ce) return { value, error: ce };
  }
  if (!partial || has("projectName")) {
    value.projectName = str(body?.projectName).replace(/\s+/g, " ");
    if (!value.projectName) return { value, error: "Project name is required" };
    if (value.projectName.length > MAX_LEN) return { value, error: `Project name is ${MAX_LEN} characters max` };
  }
  if (!partial || has("tallyProjectCC")) {
    value.tallyProjectCC = str(body?.tallyProjectCC).replace(/\s+/g, " ");
    if (value.tallyProjectCC.length > 100) return { value, error: "Tally cost-centre code is 100 characters max" };
  }
  if (has("isActive")) value.isActive = body.isActive !== false;
  return { value };
}

/* ── list + options ───────────────────────────────────────────────────── */

router.get("/", async (req: any, res: any) => {
  try {
    if (!(await requireReader(req, res))) return;
    const filter: any = { workspaceId: req.workspaceObjectId };
    const q = str(req.query.q);
    if (q) {
      const re = { $regex: escapeRegex(q), $options: "i" };
      filter.$or = [{ projectCode: re }, { projectName: re }, { tallyProjectCC: re }];
    }
    if (req.query.active === "true") filter.isActive = true;
    if (req.query.active === "false") filter.isActive = false;
    const projects = await CstepProject.find(filter).sort({ projectCode: 1 }).lean();
    res.json({ ok: true, canEdit: isCstepAdmin(req), projects });
  } catch (err: any) {
    console.error("[CSTEP projects GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load projects" });
  }
});

/** The intake forms' picker: active projects by code or name, best match
 * first (a code that starts with the query, then everything else). */
router.get("/options", async (req: any, res: any) => {
  try {
    const filter: any = { workspaceId: req.workspaceObjectId, isActive: true };
    const q = str(req.query.q).slice(0, 80);
    if (q) {
      const re = { $regex: escapeRegex(q), $options: "i" };
      filter.$or = [{ projectCode: re }, { projectName: re }];
    }
    const rows: any[] = await CstepProject.find(filter).select("_id projectCode projectName").sort({ projectCode: 1 }).limit(50).lean();
    const lead = q.toUpperCase();
    rows.sort((a, b) => Number(!a.projectCode.startsWith(lead)) - Number(!b.projectCode.startsWith(lead)));
    res.json({
      ok: true,
      projects: rows.slice(0, 20).map((p) => ({ _id: String(p._id), projectCode: p.projectCode, projectName: p.projectName })),
    });
  } catch (err: any) {
    console.error("[CSTEP projects OPTIONS]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load projects" });
  }
});

/* ── export / template / import (static paths before /:id) ───────────── */

const SHEET_COLUMNS = ["Project Code", "Project Name", "Tally Project CC", "Active"];
// The code and the cost-centre code are typed as Text ("130 OAK 06", "0042").
const TEXT_COLUMNS = [0, 2];

const HEADER_FIELD_MAP: Record<string, string> = {
  projectcode: "projectCode",
  code: "projectCode",
  projectname: "projectName",
  name: "projectName",
  tallyprojectcc: "tallyProjectCC",
  tallycc: "tallyProjectCC",
  projectcc: "tallyProjectCC",
  costcentre: "tallyProjectCC",
  costcenter: "tallyProjectCC",
  active: "active",
};

router.get("/export", async (req: any, res: any) => {
  try {
    if (!(await requireReader(req, res))) return;
    const projects = await CstepProject.find({ workspaceId: req.workspaceObjectId }).sort({ projectCode: 1 }).lean();
    await sendSheet(res, {
      format: req.query.format === "csv" ? "csv" : "xlsx",
      filename: "cstep-projects",
      sheetName: "Projects",
      columns: SHEET_COLUMNS,
      textColumns: TEXT_COLUMNS,
      rows: (projects as any[]).map((p) => [p.projectCode, p.projectName, p.tallyProjectCC || "", p.isActive === false ? "No" : "Yes"]),
    });
  } catch (err: any) {
    console.error("[CSTEP projects EXPORT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to export projects" });
  }
});

router.get("/template", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    await sendSheet(res, {
      format: req.query.format === "csv" ? "csv" : "xlsx",
      filename: "cstep-projects-template",
      sheetName: "Projects",
      columns: SHEET_COLUMNS,
      textColumns: TEXT_COLUMNS,
    });
  } catch (err: any) {
    console.error("[CSTEP projects TEMPLATE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to build the template" });
  }
});

interface ProjectRowOutcome extends SheetRowOutcome {
  projectCode?: string;
  projectName: string;
}

function parseActive(raw: string): boolean | undefined | "bad" {
  const v = raw.toLowerCase();
  if (!v) return undefined;
  if (["yes", "y", "true", "1", "active"].includes(v)) return true;
  if (["no", "n", "false", "0", "inactive"].includes(v)) return false;
  return "bad";
}

/**
 * Preview (dryRun) and commit share this, as the vendor import does.
 *   - Project Code is required on every row and is the key: one that exists
 *     UPDATES that project (only the cells the row fills — a blank cell
 *     never clears a stored value); a new one CREATES a project.
 *   - Skipped with a reason: no code / a malformed one, no name on a new
 *     project, a bad Active value, and the same code twice in the file.
 */
async function processProjectRows(workspaceId: any, uid: string, rawRows: Record<string, any>[], dryRun: boolean): Promise<ProjectRowOutcome[]> {
  const outcomes: ProjectRowOutcome[] = [];
  const codeRows = new Map<string, number>();

  await forEachSheetRow(rawRows, HEADER_FIELD_MAP, async (mapped, rowNumber) => {
    const cell = (k: string) => cellToString(mapped[k]).replace(/\s+/g, " ");
    const code = normCode(cellToString(mapped.projectCode));
    const projectName = cell("projectName");
    const skip = (reason: string) => outcomes.push({ rowNumber, projectCode: code || undefined, projectName, action: "skip", reason });

    const ce = codeError(code);
    if (ce) return void skip(ce);
    if (codeRows.has(code)) return void skip(`Project Code ${code} is also on row ${codeRows.get(code)} of this file`);
    if (projectName.length > MAX_LEN) return void skip(`Project Name is ${MAX_LEN} characters max`);
    const cc = cell("tallyProjectCC");
    if (cc.length > 100) return void skip("Tally Project CC is 100 characters max");
    const active = parseActive(cell("active"));
    if (active === "bad") return void skip(`Active must be Yes or No, not "${cell("active")}"`);

    const existing: any = await CstepProject.findOne({ workspaceId, projectCode: code });
    if (!existing && !projectName) return void skip("Project Name is required for a new project");
    codeRows.set(code, rowNumber);

    const fields: any = {};
    if (projectName) fields.projectName = projectName;
    if (cc) fields.tallyProjectCC = cc;
    if (active !== undefined) fields.isActive = active;

    if (existing) {
      if (!dryRun) {
        existing.set({ ...fields, updatedBy: uid });
        await existing.save();
      }
      outcomes.push({ rowNumber, projectCode: code, projectName: projectName || existing.projectName, action: "update" });
      return;
    }
    if (!dryRun) await CstepProject.create({ ...fields, workspaceId, projectCode: code, createdBy: uid });
    outcomes.push({ rowNumber, projectCode: code, projectName, action: "create" });
  });

  return outcomes;
}

async function importStep(req: any, res: any, dryRun: boolean) {
  if (!requireAdmin(req, res)) return;
  const sheet = await readUploadedSheet(req.file);
  if (sheet.error !== undefined) return res.status(400).json({ error: sheet.error });
  const results = await processProjectRows(req.workspaceObjectId, ownerId(req), sheet.rows, dryRun);
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
    console.error("[CSTEP projects IMPORT PREVIEW]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to read the file" });
  }
});

router.post("/import/commit", sheetUpload.single("file"), async (req: any, res: any) => {
  try {
    await importStep(req, res, false);
  } catch (err: any) {
    console.error("[CSTEP projects IMPORT COMMIT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to import" });
  }
});

/* ── single project ───────────────────────────────────────────────────── */

router.get("/:id", async (req: any, res: any) => {
  try {
    if (!(await requireReader(req, res))) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Project not found" });
    const project = await CstepProject.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId }).lean();
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json({ ok: true, project });
  } catch (err: any) {
    console.error("[CSTEP projects GET one]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load the project" });
  }
});

router.post("/", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    const { value, error } = readProjectBody(req.body, false);
    if (error) return res.status(400).json({ error });
    const workspaceId = req.workspaceObjectId;
    if (await CstepProject.exists({ workspaceId, projectCode: value.projectCode })) {
      return res.status(409).json({ error: `Project code ${value.projectCode} is already in use` });
    }
    const fields: any = { ...value, workspaceId, createdBy: ownerId(req) };
    if (!fields.tallyProjectCC) delete fields.tallyProjectCC;
    try {
      const project = await CstepProject.create(fields);
      res.status(201).json({ ok: true, project: project.toObject() });
    } catch (err: any) {
      if (err?.code === 11000) return res.status(409).json({ error: `Project code ${value.projectCode} is already in use` });
      throw err;
    }
  } catch (err: any) {
    console.error("[CSTEP projects POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to add the project" });
  }
});

router.put("/:id", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Project not found" });
    const project: any = await CstepProject.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if ("projectCode" in (req.body || {}) && normCode(req.body.projectCode) !== project.projectCode) {
      return res.status(400).json({ error: "The project code can't be changed — requests keep it; add a new project instead" });
    }
    const { value, error } = readProjectBody(req.body, true);
    if (error) return res.status(400).json({ error });
    for (const [k, v] of Object.entries(value)) project[k] = v === "" ? undefined : v;
    project.updatedBy = ownerId(req);
    await project.save();
    res.json({ ok: true, project: project.toObject() });
  } catch (err: any) {
    console.error("[CSTEP projects PUT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update the project" });
  }
});

router.delete("/:id", async (req: any, res: any) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Project not found" });
    const workspaceId = req.workspaceObjectId;
    const project: any = await CstepProject.findOne({ _id: req.params.id, workspaceId }).lean();
    if (!project) return res.status(404).json({ error: "Project not found" });
    // A project a request points at is deactivated, never deleted.
    if (await CstepTravelRequest.exists({ workspaceId, projectId: project._id })) {
      return res.status(409).json({ error: `${project.projectCode} is used on existing requests — deactivate it instead` });
    }
    await CstepProject.deleteOne({ _id: project._id, workspaceId });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[CSTEP projects DELETE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to delete the project" });
  }
});

export default router;
