// apps/backend/src/routes/admin.loyalty.ts
//
// Loyalty Points — staff admin (Phase 1). No client-facing endpoint here.
// Mounted in server.ts as
//   app.use("/api/admin/loyalty", requireAuth, requireWorkspace, requireHouse, adminLoyaltyRouter)
// and every route additionally needs the per-person `loyalty` capability
// (models/UserPermission.ts): READ to view, FULL to change settings, link
// customers, reconcile or adjust. SUPERADMIN bypasses (holdsCapability).
//
//   GET    /settings                       settings + change log
//   PUT    /settings                       change settings (FULL; enrolment rule Super Admin + reason)
//   POST   /settings/rates                 add an earn rate (Super Admin, reason, effectiveFrom >= now)
//   GET    /accounts?eligible=yes|no&q=    accounts list
//   GET    /accounts/:id                   account, members, ledger, PAN suggestions
//   PATCH  /accounts/:id                   name / enabled / startDateOverride / capPctOverride (FULL;
//                                          disabling needs a reason and logs the points it removes)
//   GET    /accounts/:id/disable-preview   points a disable would remove, per bucket
//   POST   /accounts/:id/reconcile         reconcile now (FULL)
//   POST   /accounts/:id/link              { customerId } (FULL)
//   POST   /accounts/:id/unlink            { customerId } (FULL)
//   POST   /accounts/:id/adjust            { points, reason, idempotencyKey } (FULL; bucket follows eligibility)
//   GET    /customers/search?q=            customer picker for linking
//   GET    /customers/:customerId          the customer's account (Business Master "Rewards")
//   POST   /customers/:customerId/account  create the customer's account now (FULL)
//
// Start-date rule: a change to an effective start date (settings.launchDate,
// or an account's startDateOverride) needs a Super Admin and a reason when the
// NEW start is earlier than now (it would grant points back in time) or the
// OLD start has already passed. Moving a future start further into the future
// stays open to FULL. Earn rates are effective-dated (never retroactive) and
// Super Admin only; so is the enrolment rule, which reaches back to the start
// date. Every change is written to the change log.
import { Router, type Request, type Response, type NextFunction } from "express";
import mongoose from "mongoose";
import Customer from "../models/Customer.js";
import LoyaltySettings from "../models/LoyaltySettings.js";
import LoyaltyAccount from "../models/LoyaltyAccount.js";
import LoyaltyLedger from "../models/LoyaltyLedger.js";
import Invoice from "../models/Invoice.js";
import { holdsCapability } from "../services/capabilityProbe.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import {
  getLoyaltySettings, effectiveStartDate, isEnrolled, reconcileAccount, linkCustomer, unlinkCustomer,
  manualAdjust, panSuggestions, ensureAccountForCustomer, loyaltyReconcileAllInBackground, LoyaltyError,
  invoiceHoldings,
} from "../services/loyalty.js";
import { parseISTStart } from "../utils/dateIST.js";
import logger from "../utils/logger.js";

const router = Router();

router.use(async (req, res, next) => {
  try {
    if (await holdsCapability(req, "loyalty", "READ")) return next();
    return res.status(403).json({ success: false, message: "Module access not granted", module: "loyalty", required: "READ" });
  } catch (err: any) {
    logger.error("loyalty gate error", { err: err?.message });
    return res.status(500).json({ error: "Could not check access" });
  }
});

async function requireFull(req: Request, res: Response, next: NextFunction) {
  try {
    if (await holdsCapability(req, "loyalty", "FULL")) return next();
    return res.status(403).json({ success: false, message: "Module access not granted", module: "loyalty", required: "FULL" });
  } catch (err: any) {
    logger.error("loyalty FULL gate error", { err: err?.message });
    return res.status(500).json({ error: "Could not check access" });
  }
}

const actorOf = (req: any) => String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? "unknown");
const isOid = (v: unknown) => mongoose.Types.ObjectId.isValid(String(v ?? "")) && String(v).length === 24;

function fail(res: Response, err: any, label: string) {
  if (err instanceof LoyaltyError) return res.status(err.httpStatus).json({ error: err.message });
  logger.error(`[Loyalty ${label}]`, { message: err?.message });
  return res.status(500).json({ error: err?.message || "Loyalty request failed" });
}

/** "YYYY-MM-DD" = 00:00 IST of that day; a full ISO instant is taken as is. */
function parseDateInput(v: unknown): Date | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? parseISTStart(s) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const sameInstant = (a: Date | null | undefined, b: Date | null | undefined) =>
  (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

/** The start-date rule, shared by settings and accounts. Returns [httpStatus, message] or null. */
function startDateLockError(req: Request, oldEffective: Date, newEffective: Date, reason: string): [number, string] | null {
  const now = Date.now();
  const why = newEffective.getTime() < now
    ? "The new start date is earlier than now"
    : oldEffective.getTime() <= now ? "The start date has already passed" : null;
  if (!why) return null;
  if (!isSuperAdmin(req)) return [403, why + "; only a Super Admin can make this change."];
  if (!reason) return [400, why + "; a reason is required."];
  return null;
}

/** Super Admin + reason, for the settings that reach back in time (enrolment rule, earn rate). */
function superAdminReasonError(req: Request, what: string, reason: string): [number, string] | null {
  if (!isSuperAdmin(req)) return [403, "Only a Super Admin can change " + what + "."];
  if (!reason) return [400, "A reason is required to change " + what + "."];
  return null;
}

async function customerNames(ids: string[]): Promise<Map<string, any>> {
  const oids = ids.filter(isOid).map((c) => new mongoose.Types.ObjectId(c));
  const rows: any[] = oids.length
    ? await Customer.collection.find({ _id: { $in: oids } }, {
        projection: { name: 1, legalName: 1, companyName: 1, gstNumber: 1, gstin: 1, gstStatus: 1, panNumber: 1, customerCode: 1 },
      }).toArray()
    : [];
  return new Map(rows.map((r) => [String(r._id), r]));
}

const displayName = (c: any, id: string) => String(c?.legalName || c?.companyName || c?.name || id);

/* ── Settings ──────────────────────────────────────────────────────── */

router.get("/settings", async (_req, res) => {
  try {
    const s = await getLoyaltySettings();
    res.json({ ok: true, settings: s, changeLog: [...(s.changeLog || [])].reverse() });
  } catch (err) { fail(res, err, "settings"); }
});

const NUMBER_FIELDS: Record<string, { min: number; max?: number; integer?: boolean; minExclusive?: boolean }> = {
  thresholdInr: { min: 0 },
  minRedemption: { min: 0, integer: true },
  defaultCapPct: { min: 0, max: 100 },
  validityMonths: { min: 1, integer: true },
};
const BOOL_FIELDS = ["programmeEnabled", "enrolBusinessesOnly"];
/** Fields whose change alters points, so every account is reconciled after it. */
const RECOMPUTE_FIELDS = new Set(["programmeEnabled", "launchDate", "thresholdInr", "enrolBusinessesOnly"]);

router.put("/settings", requireFull, async (req: any, res) => {
  try {
    const body = req.body || {};
    const reason = String(body.reason ?? "").trim();
    const current = await getLoyaltySettings();
    const set: Record<string, unknown> = {};
    const log: any[] = [];
    const at = new Date();
    const by = actorOf(req);

    if (body.pointsPer100 !== undefined || body.rateHistory !== undefined) {
      return res.status(400).json({ error: "Earn rates are effective-dated: add one with POST /api/admin/loyalty/settings/rates." });
    }
    for (const f of BOOL_FIELDS) {
      if (body[f] === undefined) continue;
      if (typeof body[f] !== "boolean") return res.status(400).json({ error: `${f} must be true or false.` });
      if (body[f] !== (current as any)[f]) set[f] = body[f];
    }
    if (set.enrolBusinessesOnly !== undefined) {
      const lock = superAdminReasonError(req, "the enrolment rule (it applies to invoices back to the start date)", reason);
      if (lock) return res.status(lock[0]).json({ error: lock[1] });
    }
    for (const [f, rule] of Object.entries(NUMBER_FIELDS)) {
      if (body[f] === undefined) continue;
      const n = Number(body[f]);
      const bad = !Number.isFinite(n) || n < rule.min || (rule.minExclusive && n === rule.min) ||
        (rule.max !== undefined && n > rule.max) || (rule.integer && !Number.isInteger(n));
      if (bad) return res.status(400).json({ error: `${f} is out of range.` });
      if (n !== (current as any)[f]) set[f] = n;
    }
    if (body.launchDate !== undefined) {
      const d = parseDateInput(body.launchDate);
      if (!d) return res.status(400).json({ error: "launchDate is not a valid date." });
      if (!sameInstant(d, current.launchDate)) {
        const lock = startDateLockError(req, new Date(current.launchDate), d, reason);
        if (lock) return res.status(lock[0]).json({ error: lock[1] });
        set.launchDate = d;
      }
    }
    if (!Object.keys(set).length) return res.json({ ok: true, changed: [], settings: current });

    for (const [field, v] of Object.entries(set)) {
      log.push({ at, by, field, old: (current as any)[field] ?? null, new: v, ...(reason ? { reason } : {}) });
    }
    await LoyaltySettings.updateOne({ key: "global" }, { $set: set, $push: { changeLog: { $each: log } } });
    if (Object.keys(set).some((f) => RECOMPUTE_FIELDS.has(f))) loyaltyReconcileAllInBackground(by);
    const settings = await getLoyaltySettings();
    res.json({ ok: true, changed: Object.keys(set), settings });
  } catch (err) { fail(res, err, "settings PUT"); }
});

// A new earn rate. It applies only to invoices CREATED on/after effectiveFrom,
// so it can never change points already earned: effectiveFrom >= now (omit it
// for "from now"), Super Admin only, reason required.
router.post("/settings/rates", requireFull, async (req: any, res) => {
  try {
    const reason = String(req.body?.reason ?? "").trim();
    const lock = superAdminReasonError(req, "the earn rate", reason);
    if (lock) return res.status(lock[0]).json({ error: lock[1] });
    const rate = Number(req.body?.pointsPer100);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100) return res.status(400).json({ error: "pointsPer100 must be more than 0 (and at most 100)." });
    const now = new Date();
    const raw = req.body?.effectiveFrom;
    const from = raw === undefined || raw === null || raw === "" ? now : parseDateInput(raw);
    if (!from) return res.status(400).json({ error: "effectiveFrom is not a valid date." });
    // A minute of slack for "now" sent from a browser clock.
    if (from.getTime() < now.getTime() - 60_000) {
      return res.status(400).json({ error: "A rate cannot be back-dated: effectiveFrom must be now or later." });
    }
    // History stays in effective-date order: the seeded launch rate is the base
    // rate for anything before every entry (services/loyalty.ts rateAt), so a
    // new entry dated before an existing one would re-price older invoices.
    const current = await getLoyaltySettings();
    const latest = Math.max(...current.rateHistory.map((r) => new Date(r.effectiveFrom).getTime()));
    if (from.getTime() < latest) {
      return res.status(400).json({ error: `A new rate must take effect on or after the latest rate's date (${new Date(latest).toISOString()}).` });
    }
    const by = actorOf(req);
    const entry = { pointsPer100: rate, effectiveFrom: from, setBy: by, setAt: now, reason };
    await LoyaltySettings.updateOne({ key: "global" }, {
      $push: { rateHistory: entry, changeLog: { at: now, by, field: "rateHistory", old: null, new: { pointsPer100: rate, effectiveFrom: from }, reason } },
    });
    res.json({ ok: true, rate: entry, settings: await getLoyaltySettings() });
  } catch (err) { fail(res, err, "rates"); }
});

/* ── Accounts ──────────────────────────────────────────────────────── */

router.get("/accounts", async (req, res) => {
  try {
    const filter: Record<string, unknown> = {};
    const elig = String(req.query.eligible ?? "");
    if (elig === "yes") filter.eligibleAt = { $ne: null };
    if (elig === "no") filter.eligibleAt = null;
    const q = String(req.query.q ?? "").trim();
    if (q) filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    const [accounts, settings] = await Promise.all([
      LoyaltyAccount.find(filter).select("-changeLog -lockOwner").sort({ cumulativeInr: -1 }).limit(1000).lean(),
      getLoyaltySettings(),
    ]);
    const names = await customerNames(accounts.flatMap((a: any) => a.memberCustomerIds));
    res.json({
      ok: true,
      thresholdInr: settings.thresholdInr,
      accounts: accounts.map((a: any) => ({
        ...a,
        startDate: effectiveStartDate(a, settings),
        members: a.memberCustomerIds.map((c: string) => ({ customerId: c, name: displayName(names.get(c), c) })),
      })),
    });
  } catch (err) { fail(res, err, "accounts"); }
});

router.get("/accounts/:id", async (req, res) => {
  try {
    if (!isOid(req.params.id)) return res.status(404).json({ error: "Account not found" });
    const account: any = await LoyaltyAccount.findById(req.params.id).select("-lockOwner").lean();
    if (!account) return res.status(404).json({ error: "Account not found" });
    const settings = await getLoyaltySettings();
    const [names, ledger, suggestions] = await Promise.all([
      customerNames(account.memberCustomerIds),
      LoyaltyLedger.find({ accountId: String(account._id) }).sort({ createdAt: -1, _id: -1 }).limit(500).lean(),
      panSuggestions(account.memberCustomerIds),
    ]);
    // Current invoice numbers for linked rows (the row's own invoiceNo is a snapshot).
    const invIds = [...new Set(ledger.map((l: any) => l.invoiceId).filter(isOid))];
    const invs: any[] = invIds.length
      ? await Invoice.collection.find({ _id: { $in: invIds.map((i) => new mongoose.Types.ObjectId(i)) } },
          { projection: { invoiceNo: 1, status: 1 } }).toArray()
      : [];
    const invById = new Map(invs.map((i) => [String(i._id), i]));
    res.json({
      ok: true,
      thresholdInr: settings.thresholdInr,
      account: {
        ...account,
        startDate: effectiveStartDate(account, settings),
        changeLog: [...(account.changeLog || [])].reverse(),
        members: account.memberCustomerIds.map((c: string) => {
          const cust = names.get(c);
          return {
            customerId: c, name: displayName(cust, c), customerCode: cust?.customerCode ?? null,
            gstin: cust?.gstNumber || cust?.gstin || "", gstStatus: cust?.gstStatus || "NOT_SET",
            enrolled: isEnrolled(cust, settings),
          };
        }),
      },
      ledger: ledger.map((l: any) => ({
        ...l,
        currentInvoiceNo: l.invoiceId ? invById.get(String(l.invoiceId))?.invoiceNo ?? null : null,
        currentInvoiceStatus: l.invoiceId ? invById.get(String(l.invoiceId))?.status ?? null : null,
      })),
      suggestions,
    });
  } catch (err) { fail(res, err, "account"); }
});

router.patch("/accounts/:id", requireFull, async (req: any, res) => {
  try {
    if (!isOid(req.params.id)) return res.status(404).json({ error: "Account not found" });
    const account: any = await LoyaltyAccount.findById(req.params.id).lean();
    if (!account) return res.status(404).json({ error: "Account not found" });
    const settings = await getLoyaltySettings();
    const body = req.body || {};
    const reason = String(body.reason ?? "").trim();
    const set: Record<string, unknown> = {};

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return res.status(400).json({ error: "Name cannot be empty." });
      if (name !== account.name) set.name = name;
    }
    let disableDetail: unknown;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false." });
      if (body.enabled !== account.enabled) {
        if (body.enabled === false) {
          if (!reason) return res.status(400).json({ error: "A reason is required to disable an account." });
          disableDetail = { pointsRemoved: await invoiceHoldings(String(account._id)) };
        }
        set.enabled = body.enabled;
      }
    }
    if (body.capPctOverride !== undefined) {
      const v = body.capPctOverride === null || body.capPctOverride === "" ? null : Number(body.capPctOverride);
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > 100)) return res.status(400).json({ error: "Cap % must be between 0 and 100." });
      if (v !== (account.capPctOverride ?? null)) set.capPctOverride = v;
    }
    if (body.startDateOverride !== undefined) {
      const v = body.startDateOverride === null || body.startDateOverride === "" ? null : parseDateInput(body.startDateOverride);
      if (body.startDateOverride && !v) return res.status(400).json({ error: "Start date is not a valid date." });
      const oldEffective = effectiveStartDate(account, settings);
      const newEffective = effectiveStartDate({ startDateOverride: v }, settings);
      if (!sameInstant(v, account.startDateOverride ?? null)) {
        if (!sameInstant(oldEffective, newEffective)) {
          const lock = startDateLockError(req, oldEffective, newEffective, reason);
          if (lock) return res.status(lock[0]).json({ error: lock[1] });
        }
        set.startDateOverride = v;
      }
    }
    if (!Object.keys(set).length) return res.json({ ok: true, changed: [] });

    const at = new Date();
    const by = actorOf(req);
    const log = Object.entries(set).map(([field, v]) => ({
      at, by, field, old: account[field] ?? null, new: v, ...(reason ? { reason } : {}),
      ...(field === "enabled" && disableDetail ? { detail: disableDetail } : {}),
    }));
    await LoyaltyAccount.updateOne({ _id: account._id }, { $set: set, $push: { changeLog: { $each: log } } });
    const result = Object.keys(set).some((f) => f !== "name" && f !== "capPctOverride")
      ? await reconcileAccount(account._id, { actor: by, settings })
      : null;
    res.json({ ok: true, changed: Object.keys(set), reconcile: result });
  } catch (err) { fail(res, err, "account PATCH"); }
});

router.get("/accounts/:id/disable-preview", async (req, res) => {
  try {
    if (!isOid(req.params.id) || !(await LoyaltyAccount.exists({ _id: req.params.id }))) return res.status(404).json({ error: "Account not found" });
    res.json({ ok: true, pointsRemoved: await invoiceHoldings(String(req.params.id)) });
  } catch (err) { fail(res, err, "disable preview"); }
});

router.post("/accounts/:id/reconcile", requireFull, async (req: any, res) => {
  try {
    if (!isOid(req.params.id)) return res.status(404).json({ error: "Account not found" });
    const r = await reconcileAccount(req.params.id, { actor: actorOf(req) });
    if (r.skipped === "not-found") return res.status(404).json({ error: "Account not found" });
    res.json({ ok: true, result: r });
  } catch (err) { fail(res, err, "reconcile"); }
});

router.post("/accounts/:id/link", requireFull, async (req: any, res) => {
  try {
    const r = await linkCustomer(String(req.params.id), String(req.body?.customerId ?? ""), actorOf(req));
    res.json({ ok: true, ...r });
  } catch (err) { fail(res, err, "link"); }
});

router.post("/accounts/:id/unlink", requireFull, async (req: any, res) => {
  try {
    const r = await unlinkCustomer(String(req.params.id), String(req.body?.customerId ?? ""), actorOf(req));
    res.json({ ok: true, ...r });
  } catch (err) { fail(res, err, "unlink"); }
});

router.post("/accounts/:id/adjust", requireFull, async (req: any, res) => {
  try {
    const r = await manualAdjust(String(req.params.id), req.body || {}, actorOf(req));
    const account = await LoyaltyAccount.findById(req.params.id).select("balances").lean();
    res.json({ ok: true, duplicate: r.duplicate, moves: r.moves, balances: (account as any)?.balances });
  } catch (err) { fail(res, err, "adjust"); }
});

/* ── Customers ─────────────────────────────────────────────────────── */

router.get("/customers/search", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json({ ok: true, customers: [] });
    const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    const rows: any[] = await Customer.collection
      .find({ $or: [{ name: rx }, { legalName: rx }, { companyName: rx }, { gstNumber: rx }, { customerCode: rx }] },
        { projection: { name: 1, legalName: 1, companyName: 1, gstNumber: 1, customerCode: 1 } })
      .limit(20)
      .toArray();
    const accounts: any[] = await LoyaltyAccount.find({ memberCustomerIds: { $in: rows.map((r) => String(r._id)) } })
      .select("_id name memberCustomerIds").lean();
    const accountOf = new Map<string, any>();
    for (const a of accounts) for (const m of a.memberCustomerIds) accountOf.set(String(m), a);
    res.json({
      ok: true,
      customers: rows.map((r) => ({
        customerId: String(r._id), name: displayName(r, String(r._id)), gstin: r.gstNumber || "", customerCode: r.customerCode || null,
        accountId: accountOf.get(String(r._id))?._id ?? null, accountName: accountOf.get(String(r._id))?.name ?? null,
      })),
    });
  } catch (err) { fail(res, err, "customer search"); }
});

router.get("/customers/:customerId", async (req, res) => {
  try {
    const cid = String(req.params.customerId);
    if (!isOid(cid)) return res.status(404).json({ error: "Customer not found" });
    const cust: any = await Customer.collection.findOne({ _id: new mongoose.Types.ObjectId(cid) });
    if (!cust) return res.status(404).json({ error: "Customer not found" });
    const settings = await getLoyaltySettings();
    const account: any = await LoyaltyAccount.findOne({ memberCustomerIds: cid }).select("-changeLog -lockOwner").lean();
    res.json({
      ok: true,
      customer: { customerId: cid, name: displayName(cust, cid), enrolled: isEnrolled(cust, settings) },
      settings: { launchDate: settings.launchDate, defaultCapPct: settings.defaultCapPct, programmeEnabled: settings.programmeEnabled },
      account: account ? { ...account, startDate: effectiveStartDate(account, settings) } : null,
    });
  } catch (err) { fail(res, err, "customer"); }
});

router.post("/customers/:customerId/account", requireFull, async (req: any, res) => {
  try {
    const cid = String(req.params.customerId);
    if (!isOid(cid) || !(await Customer.exists({ _id: cid }))) return res.status(404).json({ error: "Customer not found" });
    const account = await ensureAccountForCustomer(cid, actorOf(req));
    if (!account) return res.status(400).json({ error: "This customer cannot have a loyalty account." });
    const r = await reconcileAccount(account._id, { actor: actorOf(req) });
    res.json({ ok: true, accountId: String(account._id), result: r });
  } catch (err) { fail(res, err, "customer account"); }
});

export default router;
