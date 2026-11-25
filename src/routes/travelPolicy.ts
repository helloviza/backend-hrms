// apps/backend/src/routes/travelPolicy.ts
//
// Travel Policy module — ONE handler set, TWO entry points
// (docs/audits/travel-policy-audit.md, decisions D5/D6):
//
//   Client  /api/workspace/travel-policy/*            (requireAuth + requireWorkspace)
//     • the caller's OWN workspace only (requireWorkspace resolves it; never
//       from the body/query)
//     • config.features.travelPolicyEnabled must be on (default off; staff toggle)
//     • WORKSPACE_LEADER or TENANT_ADMIN (role) or a CustomerMember leader → edit
//     • APPROVER (role or member) → read-only, and never the draft (only the
//       version in force, plus "a draft is being prepared")
//     • staff appear by name only: their email and roles are stripped here
//     • Plumtrips staff never use this entry (HOUSE resolves to HOUSE → refused)
//
//   Staff   /api/admin/travel-policy/workspaces            (picker)
//           /api/admin/travel-policy/w/:workspaceId/*      (requireAuth)
//     • SUPERADMIN, or a HOUSE user holding the Access Console key
//       `travelPolicy` (READ = view, the draft and its audit included; WRITE+ = edit). TENANT_ADMIN never passes
//       (not HOUSE), whatever their grant says.
//     • the HOUSE workspace itself is not a valid target.
//     • works whether or not the client's feature flag is on, so staff can
//       prepare a policy before switching the client on.
//
// Every write records the real actor (TravelPolicyAudit.actor.kind =
// CLIENT_ADMIN | PLUMTRIPS_STAFF).
import express, { type Request, type Response, type NextFunction } from "express";
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import User from "../models/User.js";
import type { PolicyActor } from "../models/TravelPolicyVersion.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { HOUSE_WORKSPACE_ID, isHouseUser } from "../middleware/requirePlatformAdmin.js";
import { holdsCapability } from "../services/capabilityProbe.js";
import logger from "../utils/logger.js";
import { readUploadedSheet, sendSheet, sheetUpload } from "../utils/sheetImport.js";
import { PolicyInputError, istToday, versionState } from "../services/travelPolicy/core.js";
import {
  TravelPolicyError,
  cancelScheduled,
  createCity,
  createDraft,
  discardDraft,
  getLookups,
  getMapping,
  getOverview,
  getVersion,
  listAudit,
  listCities,
  openDraftId,
  previewPublish,
  publishDraft,
  saveDraft,
  seedCitiesIfEmpty,
  setAssignments,
  setDomesticBasis,
  summarizeVersion,
  updateCity,
} from "../services/travelPolicy.service.js";
import { createDesignation, listDesignations, updateDesignation } from "../services/travelPolicy/designations.js";
import { IMPORT_COLUMNS, IMPORT_MAX_ROWS, applyImport, planImport } from "../services/travelPolicy/travellerImport.js";

export const TRAVEL_POLICY_KEY = "travelPolicy";

interface TpContext {
  workspaceId: mongoose.Types.ObjectId;
  canWrite: boolean;
  /** May see the open draft: anyone who can edit, and Plumtrips staff with READ (read-only). Never a client approver. */
  seesDraft: boolean;
  actor: PolicyActor;
  entry: "CLIENT" | "STAFF";
}

const upperRoles = (user: any): string[] =>
  (Array.isArray(user?.roles) ? user.roles : [user?.role]).filter(Boolean).map((r: any) => String(r).toUpperCase().replace(/[\s-]/g, "_"));

async function actorFrom(req: any, kind: PolicyActor["kind"]): Promise<PolicyActor> {
  const id = String(req.user?._id || req.user?.id || req.user?.sub || "");
  let name = String(req.user?.name || "").trim();
  let email = String(req.user?.email || "").trim();
  if (mongoose.isValidObjectId(id) && (!name || !email)) {
    const u: any = await User.findById(id).select("name firstName lastName email").lean();
    if (u) {
      name = name || String(u.name || [u.firstName, u.lastName].filter(Boolean).join(" ")).trim();
      email = email || String(u.email || "");
    }
  }
  return { id, name: name || email, email, kind, roles: upperRoles(req.user) };
}

function ctx(res: Response): TpContext {
  return res.locals.tp as TpContext;
}

function requireWrite(_req: Request, res: Response, next: NextFunction) {
  if (ctx(res).canWrite) return next();
  return res.status(403).json({ error: "You can view this travel policy but not change it.", code: "TRAVEL_POLICY_READ_ONLY" });
}

function sendError(res: Response, err: any, where: string) {
  if (err instanceof TravelPolicyError) {
    // `errors` (the list form) is what the frontend api client carries onto the thrown error.
    return res
      .status(err.status)
      .json({ error: err.message, code: err.code, details: err.details, errors: Array.isArray(err.details) ? err.details : undefined });
  }
  if (err instanceof PolicyInputError) {
    return res.status(400).json({ error: "Some values are not valid", code: "INVALID_INPUT", details: err.errors, errors: err.errors });
  }
  logger.error(`[travelPolicy] ${where} failed`, { message: err?.message });
  return res.status(500).json({ error: "Something went wrong. Please try again." });
}

const wrap =
  (where: string, fn: (req: any, res: Response) => Promise<any>) =>
  async (req: any, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      sendError(res, err, where);
    }
  };

/** One uploaded sheet. Multer's own refusals (too large, wrong field) become a plain 400. */
function oneFile(req: any, res: Response, next: NextFunction) {
  sheetUpload.single("file")(req, res, (err: any) => {
    if (!err) return next();
    res.status(400).json({ error: err?.code === "LIMIT_FILE_SIZE" ? "The file is larger than 5 MB" : "The file could not be uploaded" });
  });
}

async function sheetRows(file: any): Promise<Record<string, any>[]> {
  let sheet: Awaited<ReturnType<typeof readUploadedSheet>>;
  try {
    sheet = await readUploadedSheet(file, IMPORT_MAX_ROWS);
  } catch {
    throw new TravelPolicyError(400, "The file could not be read. Use the CSV or XLSX template.");
  }
  if (sheet.error !== undefined) throw new TravelPolicyError(400, sheet.error);
  return sheet.rows;
}

/**
 * What a client may see of a Plumtrips staff member: their name, never an
 * email or roles (decision 4, 2026-11-25). Walks the whole response, so no
 * endpoint can forget.
 */
export function maskStaffForClient<T>(body: T): T {
  return JSON.parse(JSON.stringify(body ?? null), (_k, v) =>
    v && typeof v === "object" && v.kind === "PLUMTRIPS_STAFF"
      ? { ...v, name: String(v.name ?? "").includes("@") ? "" : v.name, ...("email" in v ? { email: "" } : {}), ...("roles" in v ? { roles: [] } : {}) }
      : v,
  );
}

/* ── Shared handlers (mounted under both entry points) ────────────────── */

function coreRouter() {
  const r = express.Router({ mergeParams: true });

  r.get(
    "/",
    wrap("overview", async (_req, res) => {
      const c = ctx(res);
      const overview = await getOverview(c.workspaceId, istToday(), { showDraft: c.seesDraft, canWrite: c.canWrite, entry: c.entry });
      res.json({ ...overview, access: { canWrite: c.canWrite, entry: c.entry } });
    }),
  );

  r.get("/lookups", wrap("lookups", async (_req, res) => res.json(await getLookups(ctx(res).workspaceId))));

  r.get(
    "/versions/:id",
    wrap("version", async (req, res) => {
      const v: any = await getVersion(ctx(res).workspaceId, req.params.id);
      // A draft is not a policy: client approvers are shown the version in force instead.
      if (v.status === "DRAFT" && !ctx(res).seesDraft) throw new TravelPolicyError(404, "Version not found");
      res.json({ version: { ...v, state: versionState(v, istToday()) } });
    }),
  );

  r.post(
    "/draft",
    requireWrite,
    wrap("create draft", async (req, res) => {
      const c = ctx(res);
      const doc = await createDraft(c.workspaceId, c.actor, { from: req.body?.from, versionId: req.body?.versionId });
      res.status(201).json({ version: doc });
    }),
  );

  r.put(
    "/draft",
    requireWrite,
    wrap("save draft", async (req, res) => {
      const c = ctx(res);
      const doc = await saveDraft(c.workspaceId, c.actor, req.body?.content ?? req.body, {
        baseUpdatedAt: req.body?.baseUpdatedAt ?? null,
        reason: req.body?.reason,
      });
      res.json({ version: doc });
    }),
  );

  r.delete(
    "/draft",
    requireWrite,
    wrap("discard draft", async (req, res) => {
      const c = ctx(res);
      await discardDraft(c.workspaceId, c.actor, String(req.body?.reason ?? req.query?.reason ?? ""));
      res.json({ ok: true });
    }),
  );

  r.post(
    "/draft/preview",
    requireWrite,
    wrap("preview", async (req, res) => res.json(await previewPublish(ctx(res).workspaceId, req.body?.effectiveFrom ?? null, istToday(), req.body?.content))),
  );

  r.post(
    "/draft/publish",
    requireWrite,
    wrap("publish", async (req, res) => {
      const c = ctx(res);
      const v = await publishDraft(c.workspaceId, c.actor, {
        effectiveFrom: req.body?.effectiveFrom ?? null,
        reason: req.body?.reason,
        changeSummary: req.body?.changeSummary,
        baseUpdatedAt: req.body?.baseUpdatedAt ?? null,
        content: req.body?.content,
        acknowledgeGaps: req.body?.acknowledgeGaps === true,
        confirmValues: req.body?.confirmValues === true,
      });
      res.json({ version: summarizeVersion(v, istToday()) });
    }),
  );

  r.post(
    "/versions/:id/cancel",
    requireWrite,
    wrap("cancel scheduled", async (req, res) => {
      const c = ctx(res);
      const v = await cancelScheduled(c.workspaceId, c.actor, req.params.id, String(req.body?.reason ?? ""));
      res.json({ version: summarizeVersion(v, istToday()) });
    }),
  );

  r.get(
    "/audit",
    wrap("audit", async (req, res) => {
      const c = ctx(res);
      res.json(
        await listAudit(c.workspaceId, {
          category: req.query.category,
          actor: req.query.actor,
          versionId: req.query.versionId,
          from: req.query.from,
          to: req.query.to,
          limit: req.query.limit,
          before: req.query.before,
          hideVersionId: c.seesDraft ? null : await openDraftId(c.workspaceId),
        }),
      );
    }),
  );

  r.put(
    "/settings",
    requireWrite,
    wrap("settings", async (req, res) => {
      const c = ctx(res);
      res.json({ settings: await setDomesticBasis(c.workspaceId, c.actor, req.body?.domesticBasis, req.body?.reason) });
    }),
  );

  r.get("/cities", wrap("cities", async (_req, res) => res.json({ cities: await listCities(ctx(res).workspaceId) })));
  r.post(
    "/cities/seed",
    requireWrite,
    wrap("seed cities", async (_req, res) => {
      const c = ctx(res);
      const seeded = await seedCitiesIfEmpty(c.workspaceId, c.actor);
      res.json({ seeded });
    }),
  );
  r.post(
    "/cities",
    requireWrite,
    wrap("create city", async (req, res) => {
      const c = ctx(res);
      res.status(201).json({ city: await createCity(c.workspaceId, c.actor, req.body ?? {}) });
    }),
  );
  r.patch(
    "/cities/:id",
    requireWrite,
    wrap("update city", async (req, res) => {
      const c = ctx(res);
      res.json({ city: await updateCity(c.workspaceId, c.actor, req.params.id, req.body ?? {}) });
    }),
  );

  r.get("/mapping", wrap("mapping", async (_req, res) => res.json(await getMapping(ctx(res).workspaceId, istToday(), ctx(res).seesDraft))));
  r.post(
    "/mapping",
    requireWrite,
    wrap("set mapping", async (req, res) => {
      const c = ctx(res);
      res.json(await setAssignments(c.workspaceId, c.actor, req.body ?? {}));
    }),
  );

  /* Traveller import (leader / staff with write): template → preview (no writes) → apply (same file again). */
  r.get(
    "/mapping/import/template",
    requireWrite,
    wrap("import template", async (req, res) => {
      await sendSheet(res, {
        format: req.query.format === "xlsx" ? "xlsx" : "csv",
        filename: "travel-policy-travellers",
        sheetName: "Travellers",
        columns: IMPORT_COLUMNS,
        textColumns: [0],
      });
    }),
  );
  r.post(
    "/mapping/import/preview",
    requireWrite,
    oneFile,
    wrap("import preview", async (req, res) => res.json(await planImport(ctx(res).workspaceId, await sheetRows(req.file)))),
  );
  r.post(
    "/mapping/import/apply",
    requireWrite,
    oneFile,
    wrap("import apply", async (req, res) => {
      const c = ctx(res);
      res.json(
        await applyImport(c.workspaceId, c.actor, await sheetRows(req.file), {
          planId: String(req.body?.planId ?? ""),
          fileName: String(req.file?.originalname ?? ""),
          reason: String(req.body?.reason ?? ""),
        }),
      );
    }),
  );

  r.get("/designations", wrap("designations", async (_req, res) => res.json({ designations: await listDesignations(ctx(res).workspaceId) })));
  r.post(
    "/designations",
    requireWrite,
    wrap("create designation", async (req, res) => {
      const c = ctx(res);
      res.status(201).json({ designation: await createDesignation(c.workspaceId, c.actor, req.body ?? {}) });
    }),
  );
  r.patch(
    "/designations/:id",
    requireWrite,
    wrap("update designation", async (req, res) => {
      const c = ctx(res);
      res.json(await updateDesignation(c.workspaceId, c.actor, String(req.params.id), req.body ?? {}));
    }),
  );

  return r;
}

/* ── Client entry ─────────────────────────────────────────────────────── */

/**
 * Client access for the caller's own workspace. Exported for tests.
 * Returns null after sending the refusal.
 */
export async function resolveClientAccess(req: any, res: Response): Promise<TpContext | null> {
  const ws: any = req.workspace;
  const wsId = String(req.workspaceObjectId || ws?._id || "");
  if (!wsId || !mongoose.isValidObjectId(wsId)) {
    res.status(403).json({ error: "Workspace context required" });
    return null;
  }
  if (isSuperAdmin(req) || wsId === HOUSE_WORKSPACE_ID) {
    res.status(403).json({ error: "Plumtrips staff manage client policies from Admin → Travel Policy.", code: "USE_STAFF_ENTRY" });
    return null;
  }
  const full: any =
    ws?.config?.features !== undefined ? ws : await CustomerWorkspace.findById(wsId).select("customerId status config.features").lean();
  if (!full?.config?.features?.travelPolicyEnabled) {
    res.status(403).json({ error: "Travel Policy is not enabled for this workspace.", code: "FEATURE_OFF" });
    return null;
  }

  const roles = upperRoles(req.user);
  const norm = (r: string) => r.replace(/[^A-Z]/g, "");
  let leader = roles.some((r) => ["WORKSPACELEADER", "TENANTADMIN"].includes(norm(r)));
  let approver = roles.some((r) => norm(r) === "APPROVER");
  const jwtMemberRole = norm(String(req.user?.customerMemberRole || "").toUpperCase());
  if (jwtMemberRole === "WORKSPACELEADER") leader = true;
  if (jwtMemberRole === "APPROVER") approver = true;
  // The member row is read for every caller (not only when the roles fall
  // short): a member the company DEACTIVATED is refused even if their token
  // still carries a leader role — same rule as requireActiveMember in
  // routes/workspace.travellers.ts.
  if (full?.customerId && req.user?.email) {
    const member: any = await CustomerMember.findOne({
      customerId: String(full.customerId),
      email: String(req.user.email).trim().toLowerCase(),
    })
      .select("role isActive")
      .lean();
    if (member && member.isActive === false) {
      res.status(403).json({ error: "Not a member of this workspace", code: "NOT_ALLOWED" });
      return null;
    }
    if (member) {
      const mr = norm(String(member.role || "").toUpperCase());
      if (mr === "WORKSPACELEADER") leader = true;
      if (mr === "APPROVER") approver = true;
    }
  }
  if (!leader && !approver) {
    res.status(403).json({ error: "Only a workspace leader or approver can open Travel Policy.", code: "NOT_ALLOWED" });
    return null;
  }
  return {
    workspaceId: new mongoose.Types.ObjectId(wsId),
    canWrite: leader,
    seesDraft: leader,
    actor: await actorFrom(req, leader ? "CLIENT_ADMIN" : "CLIENT_MEMBER"),
    entry: "CLIENT",
  };
}

export const clientTravelPolicyRouter = express.Router();
clientTravelPolicyRouter.use(async (req: any, res, next) => {
  try {
    const c = await resolveClientAccess(req, res);
    if (!c) return;
    res.locals.tp = c;
    const send = res.json.bind(res);
    res.json = (body: any) => send(maskStaffForClient(body));
    next();
  } catch (err) {
    sendError(res, err, "client gate");
  }
});
clientTravelPolicyRouter.use(coreRouter());

/* ── Staff entry ──────────────────────────────────────────────────────── */

/** SUPERADMIN, or a HOUSE user holding `travelPolicy` at `min`. Exported for tests. */
export async function canStaffManageTravelPolicy(req: any, min: "READ" | "WRITE"): Promise<boolean> {
  if (isSuperAdmin(req)) return true;
  const user = req?.user;
  if (!user || user._demoImpersonation || !isHouseUser(user)) return false;
  return holdsCapability(req, TRAVEL_POLICY_KEY, min);
}

export const staffTravelPolicyRouter = express.Router();

staffTravelPolicyRouter.use(async (req: any, res, next) => {
  try {
    if (await canStaffManageTravelPolicy(req, "READ")) return next();
    return res.status(403).json({
      error: "Managing client travel policies needs the Travel Policy grant (Access Console).",
      code: "TRAVEL_POLICY_ACCESS_REQUIRED",
      module: TRAVEL_POLICY_KEY,
    });
  } catch (err) {
    sendError(res, err, "staff gate");
  }
});

const PICKER_LIMIT = 50;

staffTravelPolicyRouter.get(
  "/workspaces",
  wrap("workspace picker", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const filter: any = { _id: { $ne: new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID) }, status: { $ne: "DELETED" } };
    if (q) filter.companyName = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    const total = await CustomerWorkspace.countDocuments(filter);
    const rows: any[] = await CustomerWorkspace.find(filter)
      .select("companyName customerId status config.features.travelPolicyEnabled config.features.cstepEnabled")
      .collation({ locale: "en", strength: 2 }) // A–Z without capitals first
      .sort({ companyName: 1 })
      .limit(PICKER_LIMIT + (q ? 0 : 20))
      .lean();
    // Workspaces without a name sort first in the database; nobody looks for them first.
    const named = [...rows.filter((w) => w.companyName), ...rows.filter((w) => !w.companyName)].slice(0, PICKER_LIMIT);
    res.json({
      total,
      workspaces: named.map((w) => ({
        _id: String(w._id),
        name: w.companyName || `No name (${String(w._id).slice(-6)})`,
        status: w.status,
        travelPolicyEnabled: !!w.config?.features?.travelPolicyEnabled,
        cstepEnabled: !!w.config?.features?.cstepEnabled,
      })),
    });
  }),
);

staffTravelPolicyRouter.use(
  "/w/:workspaceId",
  async (req: any, res, next) => {
    try {
      const id = String(req.params.workspaceId || "");
      if (!mongoose.isValidObjectId(id) || id === HOUSE_WORKSPACE_ID) {
        return res.status(404).json({ error: "Workspace not found" });
      }
      const ws: any = await CustomerWorkspace.findById(id).select("_id status").lean();
      if (!ws || ws.status === "DELETED") return res.status(404).json({ error: "Workspace not found" });
      res.locals.tp = {
        workspaceId: new mongoose.Types.ObjectId(id),
        canWrite: await canStaffManageTravelPolicy(req, "WRITE"),
        seesDraft: true, // READ got them past the gate
        actor: await actorFrom(req, "PLUMTRIPS_STAFF"),
        entry: "STAFF",
      } satisfies TpContext;
      next();
    } catch (err) {
      sendError(res, err, "staff workspace");
    }
  },
  coreRouter(),
);
