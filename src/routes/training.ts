// apps/backend/src/routes/training.ts
//
// Serves the Plumtrips Learning Hub HTML (the hub page and the training
// decks) to authenticated HOUSE users only. The files are internal training
// material (real product screenshots), so they deliberately do NOT live under
// the frontend's public/ folder where anyone with the URL could fetch them.
//
// Mounted in server.ts as
//   app.use("/api/training", requireAuth, requireWorkspace, requireHouse, trainingRouter)
// — the same gate chain as the CRM routers (leads / companies / contacts add
// requireHouse inside the router). The frontend (pages/learning/LearningHub.tsx)
// fetches a file with the Bearer token and renders it in a blob: iframe, so a
// plain browser GET without a token is a 401 and a tenant user is a 403.
//
// The files sit in src/training/ and are copied to dist/training/ by the
// build script (package.json "build": cp -r src/data src/fonts src/training
// dist/), so `../training` resolves in both dev (tsx from src/) and prod
// (node dist/server.js). An explicit allowlist, not a directory listing: a
// new deck is one more line here plus its entry in the hub's PATHS registry.
import { Router } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAINING_DIR = path.join(__dirname, "../training");

const FILES: Record<string, string> = {
  "learning-hub.html": "learning-hub.html",
  "crm-walkthrough.html": "crm-walkthrough.html",
  "spendbox-walkthrough.html": "spendbox-walkthrough.html",
};

const router = Router();

router.get("/:file", (req, res) => {
  const file = FILES[String(req.params.file || "")];
  if (!file) return res.status(404).json({ ok: false, message: "Training file not found" });
  // Private to the session that fetched it — never cacheable by a shared cache.
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.sendFile(path.join(TRAINING_DIR, file), { headers: { "Content-Type": "text/html; charset=utf-8" } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ ok: false, message: "Training file not found" });
  });
});

export default router;
