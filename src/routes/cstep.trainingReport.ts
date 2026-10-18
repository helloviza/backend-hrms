// apps/backend/src/routes/cstep.trainingReport.ts
//
// CSTEP Team Training report (services/cstepTrainingReport.ts) — the
// tenant-scoped twin of routes/trainingReport.ts. Mounted in server.ts as
//   app.use("/api/cstep/training/report", requireAuth, requireWorkspace, requireFeature("cstepEnabled"), cstepTrainingReportRouter)
// ahead of the deck router, and scoped to the caller's own workspace
// (req.workspaceObjectId) — never a query parameter.
//
// Open to a CSTEP Admin (isCstepAdmin — SUPERADMIN / ADMIN / HR / workspace
// leader) or a Finance user (mapped as some traveller's Finance user); the
// router-level gate below refuses everyone else, the export included.
//
//   GET /          JSON: live decks × active workspace users, per-deck counts
//   GET /export    XLSX: the same grid + a per-deck summary sheet
// Both take ?role=<TAG>[,<TAG>…] (ADMIN, APPROVER, OFFICIAL, FINANCE,
// REQUESTER; NONE = no CSTEP role).
import { Router } from "express";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { buildCstepTrainingReport, type CellStatus } from "../services/cstepTrainingReport.js";
import { isCstepAdmin, isCstepFinanceUser } from "../utils/cstepAccess.js";

const router = Router();

// One gate for the report AND the export.
router.use(async (req: any, res: any, next: any) => {
  try {
    if (isCstepAdmin(req) || (await isCstepFinanceUser(req))) return next();
    return res.status(403).json({ error: "Team Training is open to CSTEP Admin and Finance users" });
  } catch (err: any) {
    console.error("[CSTEP training report gate]", err?.message);
    return res.status(500).json({ error: "Could not check access" });
  }
});

function rolesParam(q: any): string[] {
  const v = q?.role;
  const raw = Array.isArray(v) ? v : v == null ? [] : String(v).split(",");
  return raw.map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 10);
}

function workspaceOf(req: any): mongoose.Types.ObjectId | null {
  const ws = req.workspaceObjectId;
  return ws && mongoose.isValidObjectId(ws) ? new mongoose.Types.ObjectId(String(ws)) : null;
}

export const STATUS_LABEL: Record<CellStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
};

export const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  APPROVER: "Approver",
  OFFICIAL: "Official",
  FINANCE: "Finance",
  REQUESTER: "Requester",
  NONE: "No CSTEP role",
};

router.get("/", async (req: any, res: any) => {
  try {
    const ws = workspaceOf(req);
    if (!ws) return res.status(400).json({ error: "No workspace on the session" });
    return res.json(await buildCstepTrainingReport(ws, { roles: rolesParam(req.query) }));
  } catch (err: any) {
    console.error("[CSTEP training report GET]", err?.message);
    return res.status(500).json({ error: "Could not build the training report" });
  }
});

router.get("/export", async (req: any, res: any) => {
  try {
    const ws = workspaceOf(req);
    if (!ws) return res.status(400).json({ error: "No workspace on the session" });
    const report = await buildCstepTrainingReport(ws, { roles: rolesParam(req.query) });
    const wb = new ExcelJS.Workbook();
    const HEAD = { font: { bold: true, color: { argb: "FFFFFFFF" } }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF00477F" } } } as const;
    const TINT: Record<CellStatus, string> = { not_started: "FFFDECEA", in_progress: "FFFFF6E0", completed: "FFE7F7EF" };
    const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

    // Sheet 1 — the grid: one row per person, status + % per deck.
    const grid = wb.addWorksheet("Progress");
    grid.views = [{ state: "frozen", xSplit: 3, ySplit: 1 }];
    const header = ["Name", "Email", "CSTEP roles"];
    for (const m of report.modules) header.push(`${m.title} — status`, `${m.title} — %`, `${m.title} — last activity`, `${m.title} — completed on`);
    const h = grid.addRow(header);
    h.font = HEAD.font as any;
    h.fill = HEAD.fill as any;
    grid.getColumn(1).width = 26;
    grid.getColumn(2).width = 30;
    grid.getColumn(3).width = 28;
    report.modules.forEach((_, i) => {
      const base = 4 + i * 4;
      grid.getColumn(base).width = 14;
      grid.getColumn(base + 1).width = 8;
      grid.getColumn(base + 2).width = 14;
      grid.getColumn(base + 3).width = 14;
    });
    for (const r of report.rows) {
      const values: any[] = [r.name, r.email, r.roles.length ? r.roles.map((x) => ROLE_LABEL[x] || x).join(", ") : ROLE_LABEL.NONE];
      for (const m of report.modules) {
        const c = r.cells[m.id];
        values.push(STATUS_LABEL[c.status], c.pct, day(c.lastActivity), day(c.completedAt));
      }
      const row = grid.addRow(values);
      report.modules.forEach((m, i) => {
        row.getCell(4 + i * 4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: TINT[r.cells[m.id].status] } };
      });
    }

    // Sheet 2 — per-deck summary for the same slice.
    const sum = wb.addWorksheet("Summary");
    const sh = sum.addRow(["Deck", "Completed", "In progress", "Not started", "People", "Completion rate %"]);
    sh.font = HEAD.font as any;
    sh.fill = HEAD.fill as any;
    [30, 12, 12, 12, 10, 18].forEach((w, i) => (sum.getColumn(i + 1).width = w));
    for (const m of report.modules) {
      const c = report.counts[m.id];
      sum.addRow([m.title, c.completed, c.inProgress, c.notStarted, c.total, c.completionRate]);
    }
    sum.addRow([]);
    sum.addRow([`Roles: ${report.filter.roles.length ? report.filter.roles.map((x) => ROLE_LABEL[x] || x).join(", ") : "All"}`]);
    sum.addRow([`Generated ${report.generatedAt}`]);

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="cstep-team-training-${report.generatedAt.slice(0, 10)}.xlsx"`);
    return res.send(buffer);
  } catch (err: any) {
    console.error("[CSTEP training report export]", err?.message);
    return res.status(500).json({ error: "Export failed" });
  }
});

export default router;
