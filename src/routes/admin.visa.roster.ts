// apps/backend/src/routes/admin.visa.roster.ts
//
// Cross-workspace ROSTER for the concierge/ops team — the admin-side
// counterpart to the customer's /visa/workspace dashboard.
//
// ══════════════════════════════════════════════════════════════════════
// SECURITY: THIS ROUTER INVERTS THE CUSTOMER DASHBOARD'S SCOPING RULE.
// ══════════════════════════════════════════════════════════════════════
//
// The customer surface (routes/visa.ts GET /travellers, read by
// pages/visa/workspace/) resolves the workspace from the SESSION and
// refuses to be told otherwise: middleware/requireWorkspace.ts's
// resolveWorkspaceForUser goes through the caller's own customerId, and
// the page's own guard additionally refuses HOUSE so a customer can never
// see the house org. The caller cannot name a workspace; identity picks it.
//
// Here that is deliberately reversed. An admin NAMES any workspaceId and
// this router reads it. Nothing about the caller's own workspace
// constrains the result — which means the ONLY thing standing between a
// request and every tenant's roster is the gate below. There is no second
// line of defence downstream, by design: a per-workspace re-check would
// be meaningless when the whole point is cross-workspace access.
//
// Therefore:
//   1. The gate is router-level (router.use), NOT per-handler, so no
//      handler can ever be added later that forgets it.
//   2. It is registered BEFORE any route in this file, so it runs before
//      a single document is read.
//   3. requirePermission("visaApplication", "READ") is the same gate the
//      rest of the Visa Console uses (admin.visa.ts, .dashboard.ts,
//      .reports.ts). SUPERADMIN bypasses it; everyone else needs an
//      explicit UserPermission grant. Confirmed with the requester
//      2026-08-09 before wiring.
//   4. requireRoles("ADMIN") is DELIBERATELY NOT USED. Its ROLE_ALIASES
//      expands ADMIN -> ["ADMIN","WORKSPACE_ADMIN","TENANT_ADMIN"], and
//      TENANT_ADMIN is a SaaS-HRMS tenant's OWN admin. Admitting one here
//      would let a tenant admin read every other customer's travellers —
//      a tenant-isolation break, not a widening.
//
// Once past the gate, every query still names ONE workspaceId explicitly.
// There is no wildcard read of TravellerProfile anywhere in this file:
// the overview aggregates per workspace and the drill-in filters to the
// single id it was given, so a bug cannot degrade into "every traveller
// in every tenant".
//
// HONESTY — the same exclusions the customer dashboard documents, for the
// same reasons, because the data has not changed:
//   - No AURA / visa-score column. The engine does not exist; a mocked
//     score is a false approval prediction.
//   - No "active visa holdings". There is no holdings model, and not one
//     application in production has ever reached an issued outcome.
//   - No "zero unencrypted MRZ storage" or "0% consular rejection" badge.
//     The first is false, the second is a guarantee nobody can make.
// Every number below is counted from rows that exist.

import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import TravellerProfile from "../models/TravellerProfile.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaApplication from "../models/VisaApplication.js";
import Department from "../models/Department.js";
import { maskTailId } from "../utils/piiMask.js";
// The dossier is computed by the SAME helpers the workspace-side dossier
// uses, imported rather than reimplemented — a second copy of "what is in
// this record" is exactly how two surfaces start disagreeing about one row.
import {
  computeDossierHealth,
  resolvePassportVault,
  resolveDossierHeader,
  describeDesignation,
  countryVocabulary,
  mapTripRow,
  mapTravellerDocument,
  identityCaptureState,
} from "./workspace.travellers.js";
import TravellerDocument from "../models/TravellerDocument.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { env } from "../config/env.js";
import { resolveVisaWallet, resolveSchengenBlock } from "../services/visaHolding.service.js";
import TravellerTrip, { TRIP_PURPOSES, TRIP_DATE_PRECISIONS } from "../models/TravellerTrip.js";
import { VISA_ENTRY_TYPES } from "../models/VisaRule.js";

const router = Router();

// ── THE GATE. Both lines run before every handler in this file. ───────
router.use(requireAuth);
router.use(requirePermission("visaApplication", "READ"));

// Mirrors pages/visa/workspace/rosterModel.ts's IN_FLIGHT_STATUSES exactly
// — the admin overview's "in flight" must mean what the customer's own
// dashboard means, or the same workspace reads differently on two screens.
// THE GATE, by construction: this is an allow-list, so "pending_approval"
// is excluded simply by not appearing — a case held at the customer's own
// approval gate is not in flight with Plumtrips. Do NOT add it here.
const IN_FLIGHT_STATUSES = [
  "submitted",
  "docs_under_review",
  "action_required",
  "cost_confirmed",
  "lodged",
  "decision_received",
];

// Six months, same window as rosterModel.PASSPORT_ALERT_WINDOW_DAYS.
const PASSPORT_ALERT_WINDOW_DAYS = 183;

/** "YYYY-MM-DD" -> UTC midnight. Never `new Date(str)` on a raw value —
 *  this codebase has a documented timezone-shift history on plain dates. */
function parsePlainDate(value: any): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? "").trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Expired OR inside the six-month window. Travellers with no expiry on
 *  file are NOT counted — that is a record to complete, not a document to
 *  renew, and conflating them inflates a renewal number. Same split the
 *  customer dashboard makes. */
function isPassportAlert(expiry: any, today: number): boolean {
  const exp = parsePlainDate(expiry);
  if (!exp) return false;
  const days = Math.round((exp.getTime() - today) / 86400000);
  return days <= PASSPORT_ALERT_WINDOW_DAYS;
}

function utcToday(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /workspaces — the overview.
 *
 * Every CUSTOMER workspace with its real KPIs. SAAS_HRMS tenants are
 * excluded: they are HRMS-only and have no visa module, so listing them
 * would pad the page with rows that can never have a roster.
 *
 * HOUSE (the Plumtrips workspace) IS included and flagged isInternal.
 * The customer dashboard refuses HOUSE because a customer must never see
 * the house org; an ADMIN overview whose premise is "every workspace"
 * must show it — and in production it currently holds every single visa
 * request, so hiding it would show an empty pipeline.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/workspaces", async (req: any, res: any) => {
  try {
    const today = utcToday();

    const workspaces: any[] = await CustomerWorkspace.find({
      tenantType: { $ne: "SAAS_HRMS" },
    })
      .select("_id companyName customerId status tenantType")
      .sort({ companyName: 1 })
      .lean();

    const wsIds = workspaces.map((w) => w._id);

    // Three grouped aggregates rather than 3xN per-workspace queries.
    const travellerAgg = await TravellerProfile.aggregate([
      { $match: { workspaceId: { $in: wsIds }, isActive: true } },
      { $group: { _id: "$workspaceId", n: { $sum: 1 }, expiries: { $push: "$passportExpiry" } } },
    ]);
    const travellerByWs = new Map(travellerAgg.map((t: any) => [String(t._id), t]));

    // In-flight is counted at APPLICATION grain (one request can carry
    // several travellers), excluding cancelled requests — same rule the
    // customer dashboard applies client-side.
    const liveRequests: any[] = await VisaRequest.find({
      workspaceId: { $in: wsIds },
      status: { $ne: "cancelled" },
    })
      .select("_id workspaceId")
      .lean();
    const requestWs = new Map(liveRequests.map((r: any) => [String(r._id), String(r.workspaceId)]));

    const inFlightApps: any[] = await VisaApplication.find({
      requestId: { $in: liveRequests.map((r: any) => r._id) },
      status: { $in: IN_FLIGHT_STATUSES },
    })
      .select("requestId")
      .lean();
    const inFlightByWs = new Map<string, number>();
    for (const a of inFlightApps) {
      const ws = requestWs.get(String(a.requestId));
      if (!ws) continue;
      inFlightByWs.set(ws, (inFlightByWs.get(ws) || 0) + 1);
    }

    const rows = workspaces.map((w) => {
      const key = String(w._id);
      const t = travellerByWs.get(key);
      const expiries: any[] = t?.expiries || [];
      return {
        workspaceId: key,
        companyName: w.companyName || "(unnamed workspace)",
        customerId: w.customerId ? String(w.customerId) : null,
        status: w.status || null,
        // The house org, surfaced rather than hidden — see the route note.
        isInternal: /^plumtrips$/i.test(String(w.companyName || "").trim()),
        rosterCount: t?.n || 0,
        inFlightCount: inFlightByWs.get(key) || 0,
        passportAlertCount: expiries.filter((e) => isPassportAlert(e, today)).length,
      };
    });

    res.json({
      ok: true,
      workspaces: rows,
      totals: {
        workspaces: rows.length,
        roster: rows.reduce((s, r) => s + r.rosterCount, 0),
        inFlight: rows.reduce((s, r) => s + r.inFlightCount, 0),
        passportAlerts: rows.reduce((s, r) => s + r.passportAlertCount, 0),
      },
    });
  } catch (err: any) {
    console.error("[admin.visa.roster GET /workspaces]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load workspaces" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /workspaces/:workspaceId/roster — the drill-in.
 *
 * Returns the SAME two payload shapes the customer dashboard composes
 * (travellers + requests), so the frontend can feed them straight into
 * pages/visa/workspace/rosterModel.ts unchanged rather than reimplement
 * passport-state, in-flight and department-grouping logic a second time.
 *
 * The workspaceId is taken from the URL — explicitly chosen by the admin,
 * never inferred — validated as an ObjectId, and then used as the ONLY
 * scope on every query below. No query in this handler can match a
 * document outside it.
 *
 * Passports stay masked to last-4 via maskTailId, exactly as the customer
 * picker and roster do. Being an admin surface does not make the full
 * number necessary to see who needs a renewal.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/workspaces/:workspaceId/roster", async (req: any, res: any) => {
  try {
    const raw = String(req.params.workspaceId || "");
    if (!mongoose.Types.ObjectId.isValid(raw)) {
      return res.status(400).json({ error: "workspaceId is not a valid id" });
    }
    const workspaceId = new mongoose.Types.ObjectId(raw);

    const workspace: any = await CustomerWorkspace.findById(workspaceId)
      .select("_id companyName customerId status tenantType")
      .lean();
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const docs: any[] = await TravellerProfile.find({ workspaceId, isActive: true })
      .select(
        "firstName middleName lastName dob email nationality passportNo passportExpiry linkedMemberId departmentId",
      )
      .sort({ firstName: 1, lastName: 1 })
      .lean();

    // Department names resolved by id AND workspaceId together, so a
    // stale reference pointing outside this workspace yields no name
    // rather than reading another tenant's Department row.
    const deptIds = [...new Set(docs.map((d) => d.departmentId).filter(Boolean).map(String))];
    const deptNameById = new Map<string, string>();
    if (deptIds.length) {
      const depts: any[] = await Department.find({ _id: { $in: deptIds }, workspaceId })
        .select("_id name")
        .lean();
      for (const d of depts) deptNameById.set(String(d._id), d.name);
    }

    const travellers = docs.map((d) => ({
      id: String(d._id),
      name: [d.firstName, d.middleName, d.lastName].filter(Boolean).join(" "),
      dob: d.dob ?? null,
      email: d.email ?? null,
      nationality: d.nationality ?? null,
      passportMasked: maskTailId(d.passportNo) ?? null,
      passportExpiry: d.passportExpiry ?? null,
      isWorkspaceMember: !!d.linkedMemberId,
      departmentId: d.departmentId ? String(d.departmentId) : null,
      departmentName: d.departmentId ? deptNameById.get(String(d.departmentId)) ?? null : null,
    }));

    // Requests shaped to VisaTrackRequest's contract (the shape
    // rosterModel.buildFilingsByTraveller reads): _id, referenceNumber,
    // status, destinationIso2, and applications[] carrying status +
    // ruleSnapshot.destinationName + traveller.id.
    const requests: any[] = await VisaRequest.find({ workspaceId })
      .select("_id referenceNumber status destinationIso2 purpose travelDateFrom travelDateTo createdAt")
      .sort({ createdAt: -1 })
      .lean();

    // THE GATE. This is the one roster read with no status filter at all —
    // it shapes EVERY application of every request in the workspace onto the
    // admin roster view, so without this a pending_approval filing would be
    // listed against its traveller by name.
    //
    // Excludes "pending_approval" ONLY, not the whole
    // VISA_OPS_HIDDEN_STATUSES set: this view deliberately shows drafts
    // (the customer's own in-progress filings are part of what an admin
    // reads a roster for), and the IN_FLIGHT_STATUSES count above is what
    // separates real activity from them.
    const apps: any[] = requests.length
      ? await VisaApplication.find({
          requestId: { $in: requests.map((r) => r._id) },
          status: { $ne: "pending_approval" },
        })
          .select("_id requestId status outcome travellerProfileId ruleSnapshot.destinationName")
          .lean()
      : [];
    const appsByRequest = new Map<string, any[]>();
    for (const a of apps) {
      const key = String(a.requestId);
      const list = appsByRequest.get(key) || [];
      list.push(a);
      appsByRequest.set(key, list);
    }
    const travellerNameById = new Map(travellers.map((t) => [t.id, t.name]));

    const shapedRequests = requests.map((r) => ({
      _id: String(r._id),
      referenceNumber: r.referenceNumber,
      status: r.status,
      destinationIso2: r.destinationIso2,
      purpose: r.purpose,
      travelDateFrom: r.travelDateFrom ?? undefined,
      travelDateTo: r.travelDateTo ?? undefined,
      createdAt: r.createdAt ?? undefined,
      applications: (appsByRequest.get(String(r._id)) || []).map((a) => ({
        _id: String(a._id),
        status: a.status,
        outcome: a.outcome ?? undefined,
        ruleSnapshot: { destinationName: a.ruleSnapshot?.destinationName || r.destinationIso2 },
        traveller: a.travellerProfileId
          ? {
              id: String(a.travellerProfileId),
              // Null for a traveller who was erased or deactivated — the
              // roster row simply won't match, exactly as on the customer
              // dashboard.
              name: travellerNameById.get(String(a.travellerProfileId)) || "",
            }
          : null,
      })),
    }));

    res.json({
      ok: true,
      workspace: {
        workspaceId: String(workspace._id),
        companyName: workspace.companyName || "(unnamed workspace)",
        customerId: workspace.customerId ? String(workspace.customerId) : null,
        status: workspace.status || null,
        isInternal: /^plumtrips$/i.test(String(workspace.companyName || "").trim()),
      },
      travellers,
      requests: shapedRequests,
    });
  } catch (err: any) {
    console.error("[admin.visa.roster GET /workspaces/:id/roster]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load roster" });
  }
});

/* ═════════════════════════════════════════════════════════════════════
 * OPS → TRAVELLER DOSSIER (2026-08-12)
 *
 * The six-tab dossier had no route from any ops surface: the roster
 * drill-in and the case views name a traveller and dead-end there, so an
 * agent working a case could not open the record the case is about.
 *
 * WHY THESE LIVE HERE AND NOT ON /workspace/travellers. That router is
 * membership-gated end to end — requireActiveMember admits only an active
 * CustomerMember of the workspace, bypassed for SUPERADMIN alone, and
 * requireWorkspace pins a non-SUPERADMIN staff user to their OWN workspace.
 * So visaApplication authorises NOTHING there: an L6 ops admin holding it
 * gets 403 "Not a member of this workspace" on every tenant they operate
 * on. Admitting ops inside requireActiveMember would have been the small
 * diff and the wrong one — it is shared with ~40 routes including every
 * write, so it would have handed ops edit rights over customer rosters to
 * fix a read gap.
 *
 * These three reads sit behind THIS file's existing router-level
 * requirePermission("visaApplication", "READ") — the same gate that already
 * lets ops read these very TravellerProfile rows for the roster above. No
 * new gate, nothing loosened, and the customer's own WL path is untouched.
 *
 * READ-ONLY BY CONSTRUCTION. Each returns the same payload shape its
 * /workspace/travellers twin returns, computed by the SAME exported helpers
 * so the two cannot drift, but with canManage/canEdit false and
 * editableFields empty. That is not a new read-only mode: TravellerForm
 * already locks every field the server omits from editableFields, and both
 * panels already hide their add/edit/delete on capabilities.canEdit — the
 * wallet route's own comment anticipates exactly this variant.
 *
 * THE CONSENT LEDGER IS DELIBERATELY ABSENT. There is no ops equivalent of
 * GET /:id/consents. That route is gated at EDIT level with an explicit
 * rationale — "a consent ledger is a record of what a named person legally
 * agreed to, squarely in the class of dossier a colleague has no business
 * browsing". A customer's own REQUESTER cannot read it; extending it to
 * cross-tenant ops would overturn a documented privacy decision, which is a
 * ruling to take deliberately and not a wiring gap to close in passing. The
 * tab renders as withheld on the ops surface.
 *
 * PASSPORT NUMBERS ARE MASKED, matching the roster above. A new surface
 * starts masked; nothing here has ever shown the full number, so there is
 * no behaviour to preserve.
 * ═════════════════════════════════════════════════════════════════════ */

/** Resolves and scopes the traveller, or answers the request. */
async function opsTraveller(req: any, res: any): Promise<any | null> {
  const { workspaceId, travellerId } = req.params;
  if (!mongoose.isValidObjectId(workspaceId) || !mongoose.isValidObjectId(travellerId)) {
    res.status(400).json({ error: "workspaceId and travellerId must be valid ids" });
    return null;
  }
  // Scoped by BOTH ids, like every other query in this file — a traveller id
  // alone must never be enough to read across into another tenant.
  const traveller: any = await TravellerProfile.findOne({
    _id: travellerId,
    workspaceId,
  }).lean();
  if (!traveller) {
    res.status(404).json({ error: "Traveller not found in this workspace" });
    return null;
  }
  return traveller;
}

router.get("/workspaces/:workspaceId/travellers/:travellerId", async (req: any, res: any) => {
  try {
    const traveller = await opsTraveller(req, res);
    if (!traveller) return;
    const workspaceId = new mongoose.Types.ObjectId(req.params.workspaceId);

    const [header, designation, passportVault] = await Promise.all([
      resolveDossierHeader(traveller, workspaceId),
      describeDesignation(traveller, workspaceId),
      resolvePassportVault(traveller, workspaceId),
    ]);

    res.json({
      ok: true,
      traveller: { ...traveller, passportNo: maskTailId(traveller.passportNo) ?? null },
      // Ops reads; ops does not edit a customer's roster. An empty allowlist
      // is what locks every field in the shared form.
      canManage: false,
      editableFields: [],
      isClaimable: false,
      dossierHealth: computeDossierHealth(traveller),
      header,
      designation,
      passportVault: {
        ...passportVault,
        // The vault echoes the number back for the MRZ/mismatch panels; mask
        // it there too, or the tab would hand back what the row above hid.
        passportNo: maskTailId((passportVault as any)?.passportNo) ?? null,
      },
      // Named so the client renders an honest withheld state rather than an
      // empty tab that looks like "this person consented to nothing".
      consentLedger: {
        available: false,
        reason:
          "The consent ledger is not visible from the ops console — it records what a named " +
          "person legally agreed to, and is readable only inside their own workspace.",
      },
    });
  } catch (err: any) {
    console.error("[admin.visa.roster GET traveller dossier]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load dossier" });
  }
});

router.get("/workspaces/:workspaceId/travellers/:travellerId/visa-holdings", async (req: any, res: any) => {
  try {
    const traveller = await opsTraveller(req, res);
    if (!traveller) return;
    const workspaceId = new mongoose.Types.ObjectId(req.params.workspaceId);

    const { rows, summary } = await resolveVisaWallet(traveller._id, workspaceId);
    res.json({
      ok: true,
      holdings: rows,
      summary,
      schengen: resolveSchengenBlock(rows),
      capabilities: { canEdit: false, canAttachStamp: false, stampReason: "Read-only from the ops console." },
      vocabularies: { entryTypes: VISA_ENTRY_TYPES, countries: countryVocabulary() },
    });
  } catch (err: any) {
    console.error("[admin.visa.roster GET traveller visa-holdings]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load visa wallet" });
  }
});

router.get("/workspaces/:workspaceId/travellers/:travellerId/trips", async (req: any, res: any) => {
  try {
    const traveller = await opsTraveller(req, res);
    if (!traveller) return;
    const workspaceId = new mongoose.Types.ObjectId(req.params.workspaceId);

    const docs: any[] = await TravellerTrip.find({
      workspaceId,
      travellerProfileId: traveller._id,
      deletedAt: null,
    })
      .sort({ startDate: -1, tripMonth: -1, createdAt: -1 })
      .lean();

    const trips = docs.map(mapTripRow);
    res.json({
      ok: true,
      trips,
      summary: { recorded: trips.length, countries: new Set(trips.map((t) => t.countryIso2)).size },
      capabilities: { canEdit: false },
      vocabularies: { purposes: TRIP_PURPOSES, datePrecisions: TRIP_DATE_PRECISIONS, countries: countryVocabulary() },
    });
  } catch (err: any) {
    console.error("[admin.visa.roster GET traveller trips]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load travel history" });
  }
});

/* ═════════════════════════════════════════════════════════════════════
 * PROFILE DOCUMENTS (2026-08-12) — the passport scans, read-only.
 *
 * The fourth ops read, added for the same reason as the three above: the
 * dossier now opens from ops, and an agent working a case could see every
 * passport FIELD on the record but not the scan those fields were typed
 * from — which is the one thing worth checking when a case is stuck on a
 * document.
 *
 * WHY HERE AND NOT ON /workspace/travellers, again. Those routes run
 * requireTravellerSubResourceAccess, which is requireActiveMember plus an
 * EDIT-level write check — deliberately edit-level even for reads, because
 * "a passport SCAN … is exactly the kind of dossier a colleague has no
 * business browsing". Ops holds neither: it is not a member of the customer's
 * workspace at all. Admitting it there would have meant loosening a gate
 * whose whole point is to be narrow, and would have handed ops the upload and
 * delete verbs sitting behind the same helper.
 *
 * So: same router-level requirePermission("visaApplication", "READ") as the
 * roster and the other three dossier reads, same both-ids scoping via
 * opsTraveller, and READ ONLY — list and presign, no POST, no DELETE.
 *
 * `uploadableKinds: []` is what makes the shared panel read-only. That is not
 * a new mode either: the panel already renders a row without its upload
 * control when the kind is absent from that list, and already keeps the View
 * button for a document that exists. Nothing about read-only is invented on
 * the client.
 *
 * identityCaptureState() is sent unchanged, so the PAN/Aadhaar rows still
 * explain themselves in the platform's own words rather than looking merely
 * empty on this surface.
 * ═════════════════════════════════════════════════════════════════════ */

router.get("/workspaces/:workspaceId/travellers/:travellerId/documents", async (req: any, res: any) => {
  try {
    const traveller = await opsTraveller(req, res);
    if (!traveller) return;
    const workspaceId = new mongoose.Types.ObjectId(req.params.workspaceId);

    const docs: any[] = await TravellerDocument.find({
      workspaceId,
      travellerProfileId: traveller._id,
      deletedAt: null,
    })
      .sort({ docKind: 1, version: -1 })
      .lean();

    // First row per kind wins — same "latest version of each kind" reduction
    // the workspace route performs on the same sort.
    const latestByKind = new Map<string, any>();
    for (const d of docs) {
      if (!latestByKind.has(d.docKind)) latestByKind.set(d.docKind, d);
    }

    res.json({
      ok: true,
      documents: [...latestByKind.values()].map(mapTravellerDocument),
      // Ops reads; ops does not manage a customer's scans. An empty allowlist
      // is what removes every upload/replace/delete control in the shared panel.
      capabilities: { uploadableKinds: [] },
      identityCapture: identityCaptureState(),
    });
  } catch (err: any) {
    console.error("[admin.visa.roster GET traveller documents]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load documents" });
  }
});

router.get(
  "/workspaces/:workspaceId/travellers/:travellerId/documents/:documentId/url",
  async (req: any, res: any) => {
    try {
      const traveller = await opsTraveller(req, res);
      if (!traveller) return;
      const workspaceId = new mongoose.Types.ObjectId(req.params.workspaceId);

      if (!mongoose.isValidObjectId(req.params.documentId)) {
        return res.status(400).json({ error: "documentId is not a valid id" });
      }

      // All three ids in the filter, never checked afterwards — a documentId
      // from another profile or another tenant resolves to nothing rather
      // than to somebody else's passport scan. Same idiom as the workspace
      // route, with workspaceId taken from the path instead of the session.
      const doc: any = await TravellerDocument.findOne({
        _id: req.params.documentId,
        workspaceId,
        travellerProfileId: traveller._id,
        deletedAt: null,
      }).lean();
      if (!doc) return res.status(404).json({ error: "Document not found" });

      const url = await presignGetObject({
        bucket: env.S3_BUCKET,
        key: doc.s3Key,
        filename: doc.originalFilename,
        view: true,
        contentType: doc.mimeType,
      });

      res.json({ ok: true, url });
    } catch (err: any) {
      console.error("[admin.visa.roster GET traveller document url]", err?.message);
      res.status(500).json({ error: err?.message || "Failed to open document" });
    }
  },
);

export default router;
