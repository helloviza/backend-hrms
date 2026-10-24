// apps/backend/src/routes/admin.partnerLinks.ts
//
// Ops management of partner lead links, mounted at /api/admin/partner-links
// behind requireAuth + requireWorkspace + requireHouse (server.ts), and
// ADMIN / SUPERADMIN here. Links are created for a partner workspace,
// edited, and deactivated — never deleted: cases keep pointing at their link.
//
//   GET    /                 list (optionally ?workspaceId=)
//   GET    /partners?q=      the create form's partner picker: active workspaces by name
//   POST   /                 create — the code is generated here, never sent
//   PATCH  /:id              edit label / placement / services / embed / origins / UTM / cap
//   POST   /:id/deactivate   stop it resolving; resolve and submit then 404
//
// The link's customerId is copied from the workspace at create; the public
// side re-checks it against the live workspace on every resolve and submit.
import { Router } from "express";
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import PartnerLink, { DEFAULT_DAILY_CAP, newPartnerLinkCode, PARTNER_LINK_SERVICES } from "../models/PartnerLink.js";
import { normaliseUtm, isUtmEmpty } from "../models/visaUtm.js";
import { requireRoles } from "../middleware/roles.js";

type AnyObj = Record<string, any>;
const router = Router();
router.use(requireRoles("ADMIN", "SUPERADMIN"));

const str = (v: any, max = 200) => String(v ?? "").trim().slice(0, max);

class LinkInputError extends Error {}

function servicesOf(v: any): string[] {
  if (v === undefined) return [...PARTNER_LINK_SERVICES];
  const list = Array.isArray(v) ? v.map((s) => str(s).toLowerCase()) : [];
  const bad = list.filter((s) => !(PARTNER_LINK_SERVICES as readonly string[]).includes(s));
  if (!list.length || bad.length) throw new LinkInputError(`services must be one or more of: ${PARTNER_LINK_SERVICES.join(", ")}`);
  return Array.from(new Set(list));
}

/** Exact https origins ("https://amberstudent.com"), no paths, no wildcards. */
function originsOf(v: any): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new LinkInputError("allowedOrigins must be a list");
  return Array.from(
    new Set(
      v.map((o) => {
        const raw = str(o, 200);
        let url: URL | null = null;
        try {
          url = new URL(raw);
        } catch {
          url = null;
        }
        if (!url || url.protocol !== "https:" || url.origin !== raw || url.hostname.includes("*")) throw new LinkInputError(`Not an exact https origin: ${raw}`);
        return raw;
      }),
    ),
  );
}

function capOf(v: any): number {
  if (v === undefined) return DEFAULT_DAILY_CAP;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw new LinkInputError("dailyCap must be a whole number from 1 to 10000");
  return n;
}

/** What ops see of a link. */
function view(l: AnyObj, partnerName = "") {
  return {
    id: String(l._id),
    code: l.code,
    workspaceId: String(l.workspaceId),
    partnerName,
    label: l.label,
    placement: l.placement || "",
    services: l.services || [],
    active: l.active !== false,
    embedAllowed: !!l.embedAllowed,
    allowedOrigins: l.allowedOrigins || [],
    utmDefaults: l.utmDefaults || null,
    dailyCap: l.dailyCap,
    clicks: l.clicks || 0,
    submissions: l.submissions || 0,
    createdByEmail: l.createdByEmail || "",
    createdAt: l.createdAt,
    deactivatedAt: l.deactivatedAt || null,
  };
}

async function partnerNames(workspaceIds: any[]): Promise<Map<string, string>> {
  const rows: any[] = await CustomerWorkspace.find({ _id: { $in: workspaceIds } }).select("_id companyName").lean();
  return new Map(rows.map((w) => [String(w._id), str(w.companyName)]));
}

router.get("/", async (req: any, res) => {
  try {
    const filter: AnyObj = {};
    if (req.query.workspaceId) {
      if (!mongoose.isValidObjectId(String(req.query.workspaceId))) return res.status(400).json({ error: "Invalid workspaceId" });
      filter.workspaceId = new mongoose.Types.ObjectId(String(req.query.workspaceId));
    }
    const links: any[] = await PartnerLink.find(filter).sort({ createdAt: -1 }).lean();
    const names = await partnerNames(links.map((l) => l.workspaceId));
    res.json({ ok: true, links: links.map((l) => view(l, names.get(String(l.workspaceId)) || "")) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to list partner links" });
  }
});

const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

router.get("/partners", async (req: any, res) => {
  try {
    const q = str(req.query.q, 60);
    if (q.length < 2) return res.json({ ok: true, partners: [] });
    const rows: any[] = await CustomerWorkspace.find({
      companyName: { $regex: escapeRegex(q), $options: "i" },
      status: "ACTIVE",
      _id: { $ne: new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID) },
    })
      .select("_id companyName")
      .sort({ companyName: 1 })
      .limit(20)
      .lean();
    res.json({ ok: true, partners: rows.map((w) => ({ workspaceId: String(w._id), name: str(w.companyName) })) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to search partners" });
  }
});

router.post("/", async (req: any, res) => {
  try {
    const b = req.body || {};
    const wsId = str(b.workspaceId, 40);
    if (!mongoose.isValidObjectId(wsId)) return res.status(400).json({ error: "workspaceId is required" });
    const ws: any = await CustomerWorkspace.findById(wsId).select("_id customerId companyName status").lean();
    if (!ws || String(ws.status || "ACTIVE") !== "ACTIVE") return res.status(400).json({ error: "Partner workspace not found or not active" });
    if (!str(ws.customerId)) return res.status(400).json({ error: "Partner workspace has no customer" });
    const label = str(b.label, 120);
    if (!label) return res.status(400).json({ error: "label is required" });

    const utm = normaliseUtm(b.utmDefaults || {});
    const fields = {
      workspaceId: ws._id,
      customerId: String(ws.customerId),
      label,
      placement: str(b.placement, 80),
      services: servicesOf(b.services),
      embedAllowed: b.embedAllowed === true,
      allowedOrigins: originsOf(b.allowedOrigins),
      ...(isUtmEmpty(utm) ? {} : { utmDefaults: utm }),
      dailyCap: capOf(b.dailyCap),
      createdBy: String(req.user?.sub || req.user?._id || req.user?.id || ""),
      createdByEmail: String(req.user?.email || "").toLowerCase(),
    };
    let link: any = null;
    for (let attempt = 0; attempt < 5 && !link; attempt++) {
      try {
        link = await PartnerLink.create({ ...fields, code: newPartnerLinkCode() });
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
      }
    }
    if (!link) return res.status(500).json({ error: "Could not allocate a link code" });
    res.status(201).json({ ok: true, link: view(link.toObject(), str(ws.companyName)) });
  } catch (err: any) {
    if (err instanceof LinkInputError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err?.message || "Failed to create partner link" });
  }
});

router.patch("/:id", async (req: any, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const b = req.body || {};
    const $set: AnyObj = {};
    if (b.label !== undefined) {
      const label = str(b.label, 120);
      if (!label) return res.status(400).json({ error: "label is required" });
      $set.label = label;
    }
    if (b.placement !== undefined) $set.placement = str(b.placement, 80);
    if (b.services !== undefined) $set.services = servicesOf(b.services);
    if (b.embedAllowed !== undefined) $set.embedAllowed = b.embedAllowed === true;
    if (b.allowedOrigins !== undefined) $set.allowedOrigins = originsOf(b.allowedOrigins);
    if (b.utmDefaults !== undefined) $set.utmDefaults = normaliseUtm(b.utmDefaults || {});
    if (b.dailyCap !== undefined) $set.dailyCap = capOf(b.dailyCap);
    if (!Object.keys($set).length) return res.status(400).json({ error: "Nothing to change" });
    const link: any = await PartnerLink.findByIdAndUpdate(req.params.id, { $set }, { new: true }).lean();
    if (!link) return res.status(404).json({ error: "Not found" });
    const names = await partnerNames([link.workspaceId]);
    res.json({ ok: true, link: view(link, names.get(String(link.workspaceId)) || "") });
  } catch (err: any) {
    if (err instanceof LinkInputError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err?.message || "Failed to update partner link" });
  }
});

router.post("/:id/deactivate", async (req: any, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Not found" });
    const link: any = await PartnerLink.findOneAndUpdate(
      { _id: req.params.id, active: true },
      { $set: { active: false, deactivatedAt: new Date(), deactivatedBy: String(req.user?.email || "").toLowerCase() } },
      { new: true },
    ).lean();
    if (!link) {
      const exists = await PartnerLink.exists({ _id: req.params.id });
      return exists ? res.status(400).json({ error: "Already deactivated" }) : res.status(404).json({ error: "Not found" });
    }
    const names = await partnerNames([link.workspaceId]);
    res.json({ ok: true, link: view(link, names.get(String(link.workspaceId)) || "") });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to deactivate partner link" });
  }
});

export default router;
