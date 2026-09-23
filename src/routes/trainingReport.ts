// apps/backend/src/routes/trainingReport.ts
//
// The org-wide Learning Hub progress report (services/trainingReport.ts).
// Mounted in server.ts as
//   app.use("/api/training/report", requireAuth, requireWorkspace, requireHouse, trainingReportRouter)
// — HOUSE (training is HOUSE-only) — and every route here additionally needs
// the dedicated `trainingReports` capability (models/UserPermission.ts),
// checked by the router-level gate below. It is granted per-person in the
// Access Console and deliberately NOT implied by HR/people access: the report
// is visible only to whoever an admin grants it to. SUPERADMIN bypasses.
//
//   GET /          JSON: live modules × active staff, per-module counts
//   GET /export    XLSX: the same grid + a per-module summary sheet
// Both take ?department=<name>[,<name>…] (use "Unassigned" for the blank bucket).
import { Router } from "express";
import ExcelJS from "exceljs";
import { buildTrainingReport, type CellStatus } from "../services/trainingReport.js";
import { holdsCapability } from "../services/capabilityProbe.js";
import logger from "../utils/logger.js";

const router = Router();

// One gate for the report AND the export. holdsCapability: SUPERADMIN → true,
// else the caller's own modules.trainingReports at READ+ (absent = NONE).
router.use(async (req, res, next) => {
  try {
    if (await holdsCapability(req, "trainingReports", "READ")) return next();
    return res.status(403).json({ success: false, message: "Module access not granted", module: "trainingReports", required: "READ" });
  } catch (err: any) {
    logger.error("training report gate error", { err: err?.message });
    return res.status(500).json({ error: "Could not check access" });
  }
});

function departmentsParam(q: any): string[] {
  const v = q?.department;
  const raw = Array.isArray(v) ? v : v == null ? [] : String(v).split(",");
  return raw.map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 50);
}

export const STATUS_LABEL: Record<CellStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
};

router.get("/", async (req, res) => {
  try {
    return res.json(await buildTrainingReport({ departments: departmentsParam(req.query) }));
  } catch (err: any) {
    logger.error("training report GET error", { err: err?.message });
    return res.status(500).json({ error: "Could not build the training report" });
  }
});

router.get("/export", async (req, res) => {
  try {
    const report = await buildTrainingReport({ departments: departmentsParam(req.query) });
    const wb = new ExcelJS.Workbook();
    const HEAD = { font: { bold: true, color: { argb: "FFFFFFFF" } }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF00477F" } } } as const;
    const TINT: Record<CellStatus, string> = { not_started: "FFFDECEA", in_progress: "FFFFF6E0", completed: "FFE7F7EF" };
    const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

    // Sheet 1 — the grid: one row per person, status + % per module.
    const grid = wb.addWorksheet("Progress");
    grid.views = [{ state: "frozen", xSplit: 3, ySplit: 1 }];
    const header = ["Name", "Email", "Department"];
    for (const m of report.modules) header.push(`${m.title} — status`, `${m.title} — %`, `${m.title} — last activity`, `${m.title} — completed on`);
    const h = grid.addRow(header);
    h.font = HEAD.font as any;
    h.fill = HEAD.fill as any;
    grid.getColumn(1).width = 26;
    grid.getColumn(2).width = 30;
    grid.getColumn(3).width = 24;
    report.modules.forEach((_, i) => {
      const base = 4 + i * 4;
      grid.getColumn(base).width = 14;
      grid.getColumn(base + 1).width = 8;
      grid.getColumn(base + 2).width = 14;
      grid.getColumn(base + 3).width = 14;
    });
    for (const r of report.rows) {
      const values: any[] = [r.name, r.email, r.department];
      for (const m of report.modules) {
        const c = r.cells[m.id];
        values.push(STATUS_LABEL[c.status], c.pct, day(c.lastActivity), day(c.completedAt));
      }
      const row = grid.addRow(values);
      report.modules.forEach((m, i) => {
        row.getCell(4 + i * 4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: TINT[r.cells[m.id].status] } };
      });
    }

    // Sheet 2 — per-module summary for the same slice.
    const sum = wb.addWorksheet("Summary");
    const sh = sum.addRow(["Module", "Completed", "In progress", "Not started", "People", "Completion rate %"]);
    sh.font = HEAD.font as any;
    sh.fill = HEAD.fill as any;
    [30, 12, 12, 12, 10, 18].forEach((w, i) => (sum.getColumn(i + 1).width = w));
    for (const m of report.modules) {
      const c = report.counts[m.id];
      sum.addRow([m.title, c.completed, c.inProgress, c.notStarted, c.total, c.completionRate]);
    }
    sum.addRow([]);
    sum.addRow([`Departments: ${report.filter.departments.length ? report.filter.departments.join(", ") : "All"}`]);
    sum.addRow([`Generated ${report.generatedAt}`]);

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="training-progress-${report.generatedAt.slice(0, 10)}.xlsx"`);
    return res.send(buffer);
  } catch (err: any) {
    logger.error("training report export error", { err: err?.message });
    return res.status(500).json({ error: "Export failed" });
  }
});

export default router;
