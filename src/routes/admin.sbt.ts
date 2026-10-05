import express from "express";
import multer from "multer";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import SBTConfig from "../models/SBTConfig.js";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import mongoose from "mongoose";
import {
  invalidateMarginCache,
  DEFAULT_MARGINS,
  parseMarginInput,
  isValidMarginPct,
  marginsLiveHere,
  MARGIN_MIN_PCT,
  MARGIN_MAX_PCT,
  type MarginConfig,
} from "../utils/margin.js";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin.js";
import { userNames, nameOrUnknown } from "../services/actorNames.js";
import SBTMarginOverride from "../models/SBTMarginOverride.js";
import SBTMarginChange from "../models/SBTMarginChange.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { invalidateOverrideCache, liveOverride } from "../services/sbtMargin.js";
import { HOUSE_WORKSPACE_ID } from "../utils/bookingAccess.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

// GET /api/admin/sbt/offers — multi-offer config (flight + hotel arrays)
router.get("/offers", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "offers" }).lean();
    const value = (doc?.value as any) ?? { flight: [], hotel: [] };
    res.json({ ok: true, flight: value.flight ?? [], hotel: value.hotel ?? [] });
  } catch (err: any) {
    console.error("[Admin SBT Offers GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/sbt/offers — upsert multi-offer config
router.put("/offers", async (req: any, res: any) => {
  try {
    const { flight, hotel } = req.body;
    const value = { flight: Array.isArray(flight) ? flight : [], hotel: Array.isArray(hotel) ? hotel : [] };
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub ?? "";
    const doc = await SBTConfig.findOneAndUpdate(
      { key: "offers" },
      { $set: { value, updatedBy: String(userId) } },
      { upsert: true, new: true },
    );
    res.json({ ok: true, offers: doc.value });
  } catch (err: any) {
    console.error("[Admin SBT Offers PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sbt/upload-offer — direct S3 upload via backend (no ACL, relies on bucket policy)
router.post("/upload-offer", upload.single("file"), async (req: any, res: any) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    if (!allowed.includes(req.file.mimetype)) {
      return res.status(400).json({ error: "Only PNG, JPEG, WebP or GIF images are allowed" });
    }

    const ext = req.file.originalname.split(".").pop()?.replace(/[^a-z0-9]/gi, "") || "jpg";
    const key = `offers/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const url = `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
    console.log("[Admin SBT Upload] Uploaded offer image:", url);
    res.json({ ok: true, url });
  } catch (err: any) {
    console.error("[Admin SBT Upload] S3 error:", err.message);
    res.status(500).json({ error: "Upload failed", detail: err.message });
  }
});

// GET /api/admin/sbt/offer — current offer config
router.get("/offer", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "offer" }).lean();
    if (!doc) return res.json({ ok: true, enabled: false });
    res.json({ ok: true, ...((doc.value as any) ?? {}), enabled: (doc.value as any)?.enabled ?? false });
  } catch (err: any) {
    console.error("[Admin SBT Offer GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/sbt/offer — upsert offer config
router.put("/offer", async (req: any, res: any) => {
  try {
    const { enabled, title, description, ctaText, ctaUrl, bgColor } = req.body;
    const value = { enabled: !!enabled, title, description, ctaText, ctaUrl, bgColor };
    const userId = req.user?._id ?? req.user?.id ?? "";

    const doc = await SBTConfig.findOneAndUpdate(
      { key: "offer" },
      { $set: { value, updatedBy: String(userId) } },
      { upsert: true, new: true },
    );
    res.json({ ok: true, offer: doc.value });
  } catch (err: any) {
    console.error("[Admin SBT Offer PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sbt/landing-config — recents/promos slot mode for SBT landing pages
router.get("/landing-config", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "landing-recents-mode" }).lean();
    const value = (doc?.value as any) ?? {};
    res.json({ ok: true, enabled: value.enabled ?? true, mode: value.mode ?? "hybrid" });
  } catch (err: any) {
    console.error("[Admin SBT Landing GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/sbt/landing-config — upsert recents/promos slot mode
router.put("/landing-config", async (req: any, res: any) => {
  try {
    const VALID_MODES = ["hybrid", "recents_only", "promos_only"];
    const mode = VALID_MODES.includes(req.body?.mode) ? req.body.mode : "hybrid";
    const value = { enabled: !!req.body?.enabled, mode };
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub ?? "";
    const doc = await SBTConfig.findOneAndUpdate(
      { key: "landing-recents-mode" },
      { $set: { value, updatedBy: String(userId) } },
      { upsert: true, new: true },
    );
    res.json({ ok: true, ...(doc.value as any) });
  } catch (err: any) {
    console.error("[Admin SBT Landing PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sbt/config — read TBO wallet config
router.get("/config", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "global" }).lean();
    res.json({
      ok: true,
      tboWalletEnabled: doc?.tboWalletEnabled ?? false,
      tboWalletMonthlyLimit: doc?.tboWalletMonthlyLimit ?? 0,
    });
  } catch (err: any) {
    console.error("[Admin SBT Config GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/sbt/config — update TBO wallet config
router.patch("/config", async (req: any, res: any) => {
  try {
    const { tboWalletEnabled, tboWalletMonthlyLimit } = req.body;
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub ?? "";
    const update: Record<string, any> = { updatedBy: String(userId) };

    if (typeof tboWalletEnabled === "boolean") update.tboWalletEnabled = tboWalletEnabled;
    if (typeof tboWalletMonthlyLimit === "number") update.tboWalletMonthlyLimit = tboWalletMonthlyLimit;

    const doc = await SBTConfig.findOneAndUpdate(
      { key: "global" },
      { $set: update },
      { upsert: true, new: true },
    );
    res.json({
      ok: true,
      tboWalletEnabled: doc.tboWalletEnabled,
      tboWalletMonthlyLimit: doc.tboWalletMonthlyLimit,
    });
  } catch (err: any) {
    console.error("[Admin SBT Config PATCH]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────────────── margins (SUPERADMIN only) ─────────────────────────
 * Plumtrips' markup on every customer's fares: the defaults (master switch +
 * four percents, versioned), one optional override per company, and an
 * append-only change log. Pricing reads them through services/sbtMargin.ts
 * (cached ≤ 30 s per instance, so a save reaches every instance within a minute).
 */

const actorOf = (req: any) => String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? "");
const MAX_REASON = 500;

/** "Last updated by" as a profile name (services/actorNames.ts), never the stored id. */
async function withUpdatedByName(value: any) {
  const by = String(value?.updatedBy || "");
  if (!by) return value;
  const names = await userNames([by]);
  return { ...value, updatedByName: nameOrUnknown(names.get(by)) };
}

async function actorName(req: any): Promise<string> {
  const id = actorOf(req);
  const names = await userNames([id, req.user?.email].filter(Boolean));
  return nameOrUnknown(names.get(id), names.get(String(req.user?.email || "").toLowerCase()));
}

async function logChange(req: any, entry: {
  scope: "DEFAULTS" | "WORKSPACE"; action: "UPDATE" | "CREATE" | "REMOVE";
  workspaceId?: unknown; workspaceName?: string; before: unknown; after: unknown; reason: string;
}) {
  await SBTMarginChange.create({
    ...entry,
    workspaceId: entry.workspaceId ? new mongoose.Types.ObjectId(String(entry.workspaceId)) : null,
    workspaceName: entry.workspaceName || "",
    actorId: actorOf(req),
    actorName: await actorName(req),
    at: new Date(),
  });
}

const wsName = (w: any) => String(w?.companyName || "").trim() || String(w?.customerId || "") || "Unnamed company";
const fourOf = (v: any) => ({
  flight: { domestic: v?.flight?.domestic ?? null, international: v?.flight?.international ?? null },
  hotel: { domestic: v?.hotel?.domestic ?? null, international: v?.hotel?.international ?? null },
});

/** An optional end date: "YYYY-MM-DD" = the end of that day in India; must be in the future. */
function parseValidUntil(v: unknown): { ok: true; value: Date | null } | { ok: false; error: string } {
  if (v == null || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "validUntil must be a date" };
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T23:59:59.999+05:30`) : new Date(v);
  if (Number.isNaN(d.getTime())) return { ok: false, error: "validUntil must be a date" };
  if (d.getTime() <= Date.now()) return { ok: false, error: "The end date must be in the future" };
  return { ok: true, value: d };
}

// GET /api/admin/sbt/margins — defaults + every company override
router.get("/margins", requireSuperAdmin, async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "margins" }).lean();
    const value = (doc?.value as MarginConfig) ?? DEFAULT_MARGINS;
    const rows = (await SBTMarginOverride.find({}).sort({ updatedAt: -1 }).lean()) as any[];
    const workspaces = rows.length
      ? ((await CustomerWorkspace.find({ _id: { $in: rows.map((r) => r.workspaceId) } })
          .select("companyName customerId").lean()) as any[])
      : [];
    const byWs = new Map(workspaces.map((w) => [String(w._id), w]));
    const names = await userNames(rows.flatMap((r) => [r.updatedBy, r.createdBy]).filter(Boolean));
    const now = new Date();
    const byName = (r: any) => {
      const by = String(r.updatedBy || r.createdBy || "");
      return by.startsWith("script:") ? "Setup script" : nameOrUnknown(names.get(by));
    };
    const overrides = rows.map((r) => ({
      id: String(r._id),
      workspaceId: String(r.workspaceId),
      companyName: wsName(byWs.get(String(r.workspaceId))),
      isHouse: String(r.workspaceId) === HOUSE_WORKSPACE_ID,
      ...fourOf(r),
      reason: r.reason,
      validUntil: r.validUntil || null,
      expired: !liveOverride(r, now),
      updatedAt: r.updatedAt,
      updatedByName: byName(r),
    }));
    res.json({
      ok: true,
      margins: await withUpdatedByName(value),
      overrides,
      limits: { min: MARGIN_MIN_PCT, max: MARGIN_MAX_PCT },
      liveHere: marginsLiveHere(),
    });
  } catch (err: any) {
    console.error("[Admin SBT Margins GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/sbt/margins — the defaults + master switch. Every value
// validated here, never trusted from the page; version +1; change logged.
router.put("/margins", requireSuperAdmin, async (req: any, res: any) => {
  try {
    const parsed = parseMarginInput(req.body);
    if ("error" in parsed) return res.status(400).json({ ok: false, error: parsed.error });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, MAX_REASON) : "";
    const userId = actorOf(req);
    const prev = (await SBTConfig.findOne({ key: "margins" }).lean()) as any;
    const before = prev?.value ?? null;
    const value: MarginConfig = {
      ...parsed.value,
      version: (Number(before?.version) || 0) + 1,
      updatedBy: userId,
      updatedAt: new Date().toISOString(),
    } as any;

    await SBTConfig.findOneAndUpdate(
      { key: "margins" },
      { $set: { value, updatedBy: userId } },
      { upsert: true, new: true },
    );
    await logChange(req, {
      scope: "DEFAULTS", action: "UPDATE",
      before: before ? { enabled: before.enabled, ...fourOf(before), version: before.version ?? 0 } : null,
      after: { enabled: value.enabled, ...fourOf(value), version: value.version },
      reason,
    });

    invalidateMarginCache();
    res.json({ ok: true, margins: await withUpdatedByName(value) });
  } catch (err: any) {
    console.error("[Admin SBT Margins PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sbt/margins/companies?q= — companies to add an override for
router.get("/margins/companies", requireSuperAdmin, async (req: any, res: any) => {
  try {
    const q = String(req.query?.q || "").trim().slice(0, 80);
    const filter: any = { status: { $ne: "DELETED" } };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ companyName: rx }, { customerId: rx }];
    }
    const rows = (await CustomerWorkspace.find(filter).select("companyName customerId").sort({ companyName: 1 }).limit(20).lean()) as any[];
    const taken = new Set(
      ((await SBTMarginOverride.find({ workspaceId: { $in: rows.map((r) => r._id) } }).select("workspaceId").lean()) as any[])
        .map((r) => String(r.workspaceId)),
    );
    res.json({
      ok: true,
      companies: rows.map((w) => ({
        workspaceId: String(w._id),
        companyName: wsName(w),
        isHouse: String(w._id) === HOUSE_WORKSPACE_ID,
        hasOverride: taken.has(String(w._id)),
      })),
    });
  } catch (err: any) {
    console.error("[Admin SBT Margin companies]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/sbt/margins/overrides/:workspaceId — add or change a company's
// override. Each of the four values is a number in [−10, 50] or null (= use
// the default); at least one must be set; reason required; validUntil optional.
router.put("/margins/overrides/:workspaceId", requireSuperAdmin, async (req: any, res: any) => {
  try {
    const wsId = String(req.params.workspaceId || "");
    if (!mongoose.Types.ObjectId.isValid(wsId)) return res.status(400).json({ ok: false, error: "Unknown company" });
    const ws = (await CustomerWorkspace.findById(wsId).select("companyName customerId").lean()) as any;
    if (!ws) return res.status(404).json({ ok: false, error: "Unknown company" });

    const b = req.body || {};
    const values = fourOf(null) as any;
    let anySet = false;
    for (const product of ["flight", "hotel"] as const) {
      for (const region of ["domestic", "international"] as const) {
        const v = b?.[product]?.[region];
        if (v === null || v === undefined) continue;
        if (!isValidMarginPct(v)) {
          return res.status(400).json({
            ok: false,
            error: `${product} ${region} margin must be a number between ${MARGIN_MIN_PCT} and ${MARGIN_MAX_PCT}, or left as the default`,
          });
        }
        values[product][region] = v;
        anySet = true;
      }
    }
    if (!anySet) return res.status(400).json({ ok: false, error: "Set at least one margin, or remove the override" });
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!reason) return res.status(400).json({ ok: false, error: "A reason is required" });
    if (reason.length > MAX_REASON) return res.status(400).json({ ok: false, error: `Keep the reason under ${MAX_REASON} characters` });
    const until = parseValidUntil(b.validUntil);
    if ("error" in until) return res.status(400).json({ ok: false, error: until.error });

    const userId = actorOf(req);
    const prev = (await SBTMarginOverride.findOne({ workspaceId: wsId }).lean()) as any;
    const row = await SBTMarginOverride.findOneAndUpdate(
      { workspaceId: wsId },
      {
        $set: { ...values, reason, validUntil: until.value, updatedBy: userId },
        $setOnInsert: { createdBy: userId },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    await logChange(req, {
      scope: "WORKSPACE", action: prev ? "UPDATE" : "CREATE", workspaceId: wsId, workspaceName: wsName(ws),
      before: prev ? { ...fourOf(prev), validUntil: prev.validUntil ?? null } : null,
      after: { ...values, validUntil: until.value },
      reason,
    });
    invalidateOverrideCache();
    res.json({ ok: true, override: { id: String((row as any)?._id), workspaceId: wsId, ...values, reason, validUntil: until.value } });
  } catch (err: any) {
    console.error("[Admin SBT Margin override PUT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/sbt/margins/overrides/:workspaceId — the company goes back
// to the defaults. Reason required; logged.
router.delete("/margins/overrides/:workspaceId", requireSuperAdmin, async (req: any, res: any) => {
  try {
    const wsId = String(req.params.workspaceId || "");
    if (!mongoose.Types.ObjectId.isValid(wsId)) return res.status(400).json({ ok: false, error: "Unknown company" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) return res.status(400).json({ ok: false, error: "A reason is required" });
    const prev = (await SBTMarginOverride.findOneAndDelete({ workspaceId: wsId }).lean()) as any;
    if (!prev) return res.status(404).json({ ok: false, error: "This company has no override" });
    const ws = (await CustomerWorkspace.findById(wsId).select("companyName customerId").lean()) as any;
    await logChange(req, {
      scope: "WORKSPACE", action: "REMOVE", workspaceId: wsId, workspaceName: wsName(ws),
      before: { ...fourOf(prev), validUntil: prev.validUntil ?? null, reason: prev.reason }, after: null,
      reason: reason.slice(0, MAX_REASON),
    });
    invalidateOverrideCache();
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[Admin SBT Margin override DELETE]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/sbt/margins/history?workspaceId= — the change log, newest first
router.get("/margins/history", requireSuperAdmin, async (req: any, res: any) => {
  try {
    const filter: any = {};
    const wsId = String(req.query?.workspaceId || "");
    if (wsId) {
      if (!mongoose.Types.ObjectId.isValid(wsId)) return res.json({ ok: true, changes: [] });
      filter.workspaceId = new mongoose.Types.ObjectId(wsId);
    }
    const rows = (await SBTMarginChange.find(filter).sort({ at: -1, _id: -1 }).limit(300).lean()) as any[];
    res.json({
      ok: true,
      changes: rows.map((r) => ({
        id: String(r._id), scope: r.scope, action: r.action,
        workspaceId: r.workspaceId ? String(r.workspaceId) : null, workspaceName: r.workspaceName,
        before: r.before, after: r.after, reason: r.reason, actorName: r.actorName, at: r.at,
      })),
    });
  } catch (err: any) {
    console.error("[Admin SBT Margin history]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
