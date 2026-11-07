// apps/backend/src/services/gstRegistrations.ts
//
// THE ONLY WRITER of a client company's GST registrations
// (Customer.gstRegistrations) and of the fields that mirror the default one:
//   Customer.gstNumber, gstRegisteredState, gstRegisteredStateCode
//   CustomerWorkspace.gstNumber
// (docs/audits/client-multi-gst-audit.md §9.1; R2 = P1+P2.) Routes and scripts
// call this; a source-text test (gstRegistrations.writers.test.ts) fails when
// anything else writes those fields.
//
// Rules
//  - D1: every registration carries the company PAN (GSTIN chars 3–12). A
//    company with no PAN takes it from its first registration.
//  - State and state code are DERIVED from the GSTIN, never typed.
//  - A GSTIN is immutable; correcting one = deactivate + add (ids will be
//    referenced by bookings and invoices from P3).
//  - Exactly one active default while any registration is active. The default
//    can't be deactivated (set another first), nor the last active one of a
//    REGISTERED company (switch the company to Unregistered instead).
//  - A GSTIN active on another company is refused (the cross-company unique
//    index waits until after P5's merges); it is checked against other
//    companies' registrations and their legacy gstNumber.
//  - D6: an optional Plumtrips seller GSTIN per registration; blank = the
//    company-level Bill From (Customer.defaultSellerGstin).
//  - gstStatus stays company-level (D11): adding a registration to a NOT_SET
//    company makes it REGISTERED; an UNREGISTERED company takes none.
//
// Writes: the Customer is updated in ONE document write guarded by a revision
// counter (gstRegistrationsRev), so registrations and their Customer mirrors can
// never disagree and two concurrent edits can't both win. The workspace mirror
// is a second, idempotent write — syncWorkspaceMirror() can always replay it.
// No multi-document transaction: local dev runs a standalone mongod.
import mongoose from "mongoose";
import Customer from "../models/Customer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import GstRegistrationAudit from "../models/GstRegistrationAudit.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import { normalizeGstStatus, validateRegisteredGstin } from "../utils/customerGst.js";
import { normalizeGstin, panFromGstin, stateFromGstin } from "../utils/gstinState.js";

export type GstRegistration = {
  _id: mongoose.Types.ObjectId;
  gstin: string;
  stateCode: string;
  state: string;
  legalName?: string;
  tradeName?: string;
  address?: { line1?: string; line2?: string; city?: string; pincode?: string; country?: string };
  billingEmail?: string;
  label?: string;
  isDefault: boolean;
  active: boolean;
  defaultSellerGstin?: string;
  isSez?: boolean;
  source?: string;
  createdAt?: Date;
  createdBy?: string;
  deactivatedAt?: Date | null;
  deactivatedBy?: string | null;
};

export class GstRegistrationError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export type Actor = { actorId?: string; source: string };

const EDITABLE = ["legalName", "tradeName", "address", "billingEmail", "label", "defaultSellerGstin", "isSez"] as const;
type Editable = Partial<Pick<GstRegistration, (typeof EDITABLE)[number]>>;

function oid(v: unknown): mongoose.Types.ObjectId {
  const s = String(v ?? "");
  if (!mongoose.Types.ObjectId.isValid(s)) throw new GstRegistrationError(400, "BAD_ID", "Invalid id.");
  return new mongoose.Types.ObjectId(s);
}

function clean(s: unknown, max = 200): string {
  return String(s ?? "").trim().slice(0, max);
}

function cleanAddress(a: any): GstRegistration["address"] {
  if (!a || typeof a !== "object") return undefined;
  const out = {
    line1: clean(a.line1),
    line2: clean(a.line2),
    city: clean(a.city, 100),
    pincode: clean(a.pincode, 12),
    country: clean(a.country, 60) || "India",
  };
  return out.line1 || out.line2 || out.city || out.pincode ? out : undefined;
}

export function defaultRegistration(regs: GstRegistration[] | undefined | null): GstRegistration | null {
  return (regs || []).find((r) => r.active && r.isDefault) || null;
}

/** The Customer fields that mirror the default registration. A company that
 *  has never had registrations keeps its legacy fields untouched ({}). */
export function customerMirror(regs: GstRegistration[] | undefined | null): Record<string, string> {
  if (!regs || regs.length === 0) return {};
  const def = defaultRegistration(regs);
  if (!def) return { gstNumber: "" }; // all deactivated: no GSTIN to bill to
  return { gstNumber: def.gstin, gstRegisteredState: def.state, gstRegisteredStateCode: def.stateCode };
}

async function loadCustomer(customerId: unknown): Promise<any> {
  const c = await Customer.findById(oid(customerId))
    .select("name legalName panNumber gstStatus gstNumber gstin gstRegisteredState gstRegisteredStateCode gstRegistrations gstRegistrationsRev workspaceId status")
    .lean();
  if (!c) throw new GstRegistrationError(404, "CUSTOMER_NOT_FOUND", "Company not found.");
  return c;
}

/** Another company already holding this GSTIN (active registration, or a
 *  legacy gstNumber on a company that has no registrations yet). */
export async function otherCompanyWithGstin(
  gstin: string,
  exceptCustomerId?: unknown,
): Promise<{ customerId: string; name: string } | null> {
  const g = normalizeGstin(gstin);
  const except = exceptCustomerId ? { _id: { $ne: oid(exceptCustomerId) } } : {};
  const hit: any = await Customer.findOne({
    ...except,
    status: { $ne: "MERGED" },
    $or: [
      { gstRegistrations: { $elemMatch: { gstin: g, active: true } } },
      { gstNumber: g, "gstRegistrations.0": { $exists: false } },
    ],
  })
    .select("name legalName")
    .lean();
  return hit ? { customerId: String(hit._id), name: hit.legalName || hit.name || "" } : null;
}

export type GstinCheck = {
  gstin: string;
  ok: boolean;
  state?: string;
  stateCode?: string;
  error?: string;
  code?: string;
  otherCompany?: { customerId: string; name: string };
};

/** Everything that decides whether `gstin` may be added to `customer`. Used by
 *  add() and by the Business Profiles add-row live check. */
export async function checkGstin(customer: any, gstinRaw: unknown): Promise<GstinCheck> {
  const gstin = normalizeGstin(gstinRaw);
  const st = stateFromGstin(gstin);
  const base: GstinCheck = { gstin, ok: false, ...(st || {}) };
  const formatErr = validateRegisteredGstin(gstin, customer?.panNumber);
  if (formatErr) {
    const code = /PAN/.test(formatErr) ? "PAN_MISMATCH" : "GSTIN_INVALID";
    return { ...base, error: formatErr, code };
  }
  if (!st) {
    return { ...base, code: "STATE_CODE_UNKNOWN", error: `GSTIN "${gstin}" starts with "${gstin.slice(0, 2)}", which is not a current GST state code.` };
  }
  const own = (customer?.gstRegistrations || []).find((r: GstRegistration) => r.gstin === gstin);
  if (own) {
    return {
      ...base,
      code: own.active ? "DUPLICATE_IN_COMPANY" : "INACTIVE_IN_COMPANY",
      error: own.active
        ? `${gstin} is already one of this company's registrations.`
        : `${gstin} is an inactive registration of this company — reactivate it instead.`,
    };
  }
  const other = await otherCompanyWithGstin(gstin, customer?._id);
  if (other) {
    return { ...base, code: "GSTIN_ON_OTHER_COMPANY", error: `${gstin} already belongs to ${other.name || "another company"}.`, otherCompany: other };
  }
  return { ...base, ok: true };
}

async function assertSellerGstin(v: unknown): Promise<string> {
  const g = normalizeGstin(v);
  if (!g) return "";
  const cs: any = await getCompanySettings();
  const active = new Set(((cs?.gstProfiles || []) as any[]).filter((p) => p.active).map((p) => normalizeGstin(p.gstin)));
  if (!active.has(g)) {
    throw new GstRegistrationError(400, "DEFAULT_SELLER_GSTIN_NOT_FOUND", `Plumtrips Bill From "${g}" is not an active Plumtrips GST registration.`);
  }
  return g;
}

/** One guarded write of the Customer: registrations + mirrors (+ extra $set). */
async function commit(
  customer: any,
  regs: GstRegistration[],
  extraSet: Record<string, unknown>,
  audit: { action: string; registrationId?: unknown; gstin?: string; before?: unknown; after?: unknown },
  actor: Actor,
): Promise<GstRegistration[]> {
  const rev = Number(customer.gstRegistrationsRev || 0);
  const res = await Customer.updateOne(
    { _id: customer._id, ...(rev ? { gstRegistrationsRev: rev } : { gstRegistrationsRev: { $in: [null, 0] } }) },
    { $set: { gstRegistrations: regs, gstRegistrationsRev: rev + 1, ...customerMirror(regs), ...extraSet } },
    { runValidators: true },
  );
  if (res.matchedCount === 0) {
    throw new GstRegistrationError(409, "CONCURRENT_EDIT", "Someone else changed this company's GST registrations. Reload and try again.");
  }
  await syncWorkspaceMirror(customer._id, regs);
  await GstRegistrationAudit.create({
    customerId: customer._id,
    registrationId: audit.registrationId,
    gstin: audit.gstin,
    action: audit.action,
    before: audit.before,
    after: audit.after,
    actorId: actor.actorId,
    source: actor.source,
  });
  return regs;
}

/** CustomerWorkspace.gstNumber = the default registration's GSTIN. Idempotent;
 *  a company with no registrations is left as it is. */
export async function syncWorkspaceMirror(customerId: unknown, regs?: GstRegistration[] | null) {
  let list = regs;
  if (list === undefined) {
    const c: any = await Customer.findById(oid(customerId)).select("gstRegistrations").lean();
    list = c?.gstRegistrations;
  }
  if (!list || list.length === 0) return;
  const gstNumber = defaultRegistration(list)?.gstin || "";
  // CustomerWorkspace.customerId is unique: one workspace per company.
  await CustomerWorkspace.updateOne({ customerId: String(customerId) }, { $set: { gstNumber } });
}

function snapshot(r: GstRegistration | undefined | null) {
  if (!r) return undefined;
  const { _id, gstin, state, isDefault, active, legalName, label, defaultSellerGstin } = r;
  return { _id: String(_id), gstin, state, isDefault, active, legalName, label, defaultSellerGstin };
}

/* ───────────────────────── public API ───────────────────────── */

export async function listRegistrations(customerId: unknown) {
  const c = await loadCustomer(customerId);
  return {
    customerId: String(c._id),
    companyName: c.legalName || c.name || "",
    companyPan: c.panNumber || "",
    gstStatus: normalizeGstStatus(c.gstStatus),
    registrations: (c.gstRegistrations || []) as GstRegistration[],
    rev: Number(c.gstRegistrationsRev || 0),
  };
}

export async function addRegistration(
  customerId: unknown,
  input: { gstin: unknown } & Editable & { makeDefault?: boolean },
  actor: Actor,
  action: "ADD" | "LEGACY_FIELD" | "ONBOARDING" | "MIGRATED" = "ADD",
): Promise<GstRegistration> {
  const c = await loadCustomer(customerId);
  const status = normalizeGstStatus(c.gstStatus);
  if (status === "UNREGISTERED") {
    throw new GstRegistrationError(409, "COMPANY_UNREGISTERED", "This company is Unregistered (B2C). Set its GST status to Registered before adding a GSTIN.");
  }
  const chk = await checkGstin(c, input.gstin);
  if (!chk.ok) throw new GstRegistrationError(chk.code === "GSTIN_ON_OTHER_COMPANY" ? 409 : 400, chk.code!, chk.error!, chk.otherCompany ? { otherCompany: chk.otherCompany } : undefined);

  const regs: GstRegistration[] = [...((c.gstRegistrations || []) as GstRegistration[])];
  const hasActive = regs.some((r) => r.active);
  const makeDefault = !hasActive || !!input.makeDefault;
  if (makeDefault) for (const r of regs) r.isDefault = false;
  const reg: GstRegistration = {
    _id: new mongoose.Types.ObjectId(),
    gstin: chk.gstin,
    stateCode: chk.stateCode!,
    state: chk.state!,
    legalName: clean(input.legalName) || c.legalName || c.name || "",
    tradeName: clean(input.tradeName) || undefined,
    address: cleanAddress(input.address),
    billingEmail: clean(input.billingEmail, 120) || undefined,
    label: clean(input.label, 80) || undefined,
    isDefault: makeDefault,
    active: true,
    defaultSellerGstin: await assertSellerGstin(input.defaultSellerGstin),
    isSez: !!input.isSez,
    source: action,
    createdAt: new Date(),
    createdBy: actor.actorId,
  };
  regs.push(reg);
  const extra: Record<string, unknown> = {};
  if (!clean(c.panNumber)) extra.panNumber = panFromGstin(reg.gstin); // D1: PAN from the first GSTIN
  if (status !== "REGISTERED") extra.gstStatus = "REGISTERED";
  await commit(c, regs, extra, { action, registrationId: reg._id, gstin: reg.gstin, after: snapshot(reg) }, actor);
  return reg;
}

export async function updateRegistration(customerId: unknown, registrationId: unknown, patch: Editable & { gstin?: unknown }, actor: Actor) {
  const c = await loadCustomer(customerId);
  const regs: GstRegistration[] = [...(c.gstRegistrations || [])];
  const id = String(oid(registrationId));
  const r = regs.find((x) => String(x._id) === id);
  if (!r) throw new GstRegistrationError(404, "REGISTRATION_NOT_FOUND", "Registration not found.");
  if (patch.gstin !== undefined && normalizeGstin(patch.gstin) !== r.gstin) {
    throw new GstRegistrationError(400, "GSTIN_IMMUTABLE", "A GSTIN can't be edited. Deactivate this registration and add the correct GSTIN.");
  }
  const before = snapshot(r);
  if (patch.legalName !== undefined) r.legalName = clean(patch.legalName) || c.legalName || c.name || "";
  if (patch.tradeName !== undefined) r.tradeName = clean(patch.tradeName) || undefined;
  if (patch.address !== undefined) r.address = cleanAddress(patch.address);
  if (patch.billingEmail !== undefined) r.billingEmail = clean(patch.billingEmail, 120) || undefined;
  if (patch.label !== undefined) r.label = clean(patch.label, 80) || undefined;
  if (patch.isSez !== undefined) r.isSez = !!patch.isSez;
  if (patch.defaultSellerGstin !== undefined) r.defaultSellerGstin = await assertSellerGstin(patch.defaultSellerGstin);
  await commit(c, regs, {}, { action: "UPDATE", registrationId: r._id, gstin: r.gstin, before, after: snapshot(r) }, actor);
  return r;
}

export async function setDefaultRegistration(customerId: unknown, registrationId: unknown, actor: Actor) {
  const c = await loadCustomer(customerId);
  const regs: GstRegistration[] = [...(c.gstRegistrations || [])];
  const id = String(oid(registrationId));
  const r = regs.find((x) => String(x._id) === id);
  if (!r) throw new GstRegistrationError(404, "REGISTRATION_NOT_FOUND", "Registration not found.");
  if (!r.active) throw new GstRegistrationError(409, "REGISTRATION_INACTIVE", "Reactivate this registration before making it the default.");
  const before = snapshot(defaultRegistration(regs));
  for (const x of regs) x.isDefault = String(x._id) === id;
  await commit(c, regs, {}, { action: "SET_DEFAULT", registrationId: r._id, gstin: r.gstin, before, after: snapshot(r) }, actor);
  return r;
}

export async function deactivateRegistration(customerId: unknown, registrationId: unknown, actor: Actor) {
  const c = await loadCustomer(customerId);
  const regs: GstRegistration[] = [...(c.gstRegistrations || [])];
  const id = String(oid(registrationId));
  const r = regs.find((x) => String(x._id) === id);
  if (!r) throw new GstRegistrationError(404, "REGISTRATION_NOT_FOUND", "Registration not found.");
  if (!r.active) return r;
  const activeCount = regs.filter((x) => x.active).length;
  if (activeCount === 1 && normalizeGstStatus(c.gstStatus) === "REGISTERED") {
    throw new GstRegistrationError(409, "LAST_ACTIVE_REGISTRATION", "A registered company needs at least one active GSTIN. To remove it, set the company's GST status to Unregistered.");
  }
  if (r.isDefault && activeCount > 1) {
    throw new GstRegistrationError(409, "DEFAULT_REGISTRATION", "Set another registration as the default before deactivating this one.");
  }
  const before = snapshot(r);
  r.active = false;
  r.isDefault = false;
  r.deactivatedAt = new Date();
  r.deactivatedBy = actor.actorId || null;
  await commit(c, regs, {}, { action: "DEACTIVATE", registrationId: r._id, gstin: r.gstin, before, after: snapshot(r) }, actor);
  return r;
}

export async function reactivateRegistration(customerId: unknown, registrationId: unknown, actor: Actor) {
  const c = await loadCustomer(customerId);
  if (normalizeGstStatus(c.gstStatus) === "UNREGISTERED") {
    throw new GstRegistrationError(409, "COMPANY_UNREGISTERED", "This company is Unregistered (B2C). Set its GST status to Registered first.");
  }
  const regs: GstRegistration[] = [...(c.gstRegistrations || [])];
  const id = String(oid(registrationId));
  const r = regs.find((x) => String(x._id) === id);
  if (!r) throw new GstRegistrationError(404, "REGISTRATION_NOT_FOUND", "Registration not found.");
  if (r.active) return r;
  const other = await otherCompanyWithGstin(r.gstin, c._id);
  if (other) throw new GstRegistrationError(409, "GSTIN_ON_OTHER_COMPANY", `${r.gstin} is now active on ${other.name || "another company"}.`, { otherCompany: other });
  const before = snapshot(r);
  r.active = true;
  r.deactivatedAt = null;
  r.deactivatedBy = null;
  if (!regs.some((x) => x.active && x.isDefault)) r.isDefault = true;
  await commit(c, regs, {}, { action: "REACTIVATE", registrationId: r._id, gstin: r.gstin, before, after: snapshot(r) }, actor);
  return r;
}

/**
 * A pre-registrations writer (the old Business Profiles form, PATCH
 * /customers/:id, PATCH /master-data/:id, staff PATCH /workspace/settings/pan,
 * the Zoho import) says "this company's GSTIN is X". Same meaning here: X
 * becomes the default registration — added if new (validated like any add),
 * made default if it already exists. The previous default stays active.
 * Returns null when X is already the default (nothing to do).
 */
export async function applyLegacyGstin(customerId: unknown, gstinRaw: unknown, actor: Actor): Promise<GstRegistration | null> {
  const gstin = normalizeGstin(gstinRaw);
  if (!gstin) return null; // a blank never clears registrations (deactivate does)
  const c = await loadCustomer(customerId);
  const existing = ((c.gstRegistrations || []) as GstRegistration[]).find((r) => r.gstin === gstin);
  if (existing) {
    if (existing.active && existing.isDefault) return null;
    if (!existing.active) await reactivateRegistration(customerId, existing._id, actor);
    return setDefaultRegistration(customerId, existing._id, actor);
  }
  return addRegistration(customerId, { gstin, makeDefault: true }, actor, "LEGACY_FIELD");
}

/**
 * Onboarding → registration (approval and promote). `strict` (promote): an
 * invalid GSTIN on a REGISTERED form throws, so the caller refuses before any
 * write. Non-strict (approval): skips and reports, never failing the approval.
 * A company that already has registrations keeps them; a form GSTIN that is not
 * among them is refused (strict) or reported (non-strict), never silently
 * swapped in.
 */
export async function preflightOnboardingGstin(customerId: unknown | null, form: any): Promise<GstinCheck | null> {
  const gstin = normalizeGstin(form?.gstNumber || form?.gstin);
  const status = normalizeGstStatus(form?.gstStatus || (gstin ? "REGISTERED" : ""));
  if (!gstin || status === "UNREGISTERED") return null;
  const fake: any = { _id: customerId || undefined, panNumber: form?.panNumber || form?.pan || "", gstRegistrations: [] };
  if (customerId) {
    const c: any = await Customer.findById(oid(customerId)).select("panNumber gstRegistrations").lean();
    if (c?.gstRegistrations?.length) {
      const hit = c.gstRegistrations.find((r: GstRegistration) => r.gstin === gstin);
      if (hit) return { gstin, ok: true, state: hit.state, stateCode: hit.stateCode };
      return {
        gstin,
        ok: false,
        code: "GSTIN_NOT_IN_REGISTRATIONS",
        error: `The form's GSTIN ${gstin} is not one of this company's GST registrations. Add it in Business Profiles → GST registrations first.`,
      };
    }
    fake.panNumber = fake.panNumber || c?.panNumber || "";
  }
  return checkGstin(fake, gstin);
}

export async function ensureRegistrationFromOnboarding(
  customerId: unknown,
  form: any,
  actor: Actor,
  { strict }: { strict: boolean },
): Promise<{ registration?: GstRegistration; skipped?: GstinCheck }> {
  const chk = await preflightOnboardingGstin(customerId, form);
  if (!chk) return {};
  if (!chk.ok) {
    if (strict) throw new GstRegistrationError(422, chk.code || "GSTIN_INVALID", chk.error || "Invalid GSTIN.", chk.otherCompany ? { otherCompany: chk.otherCompany } : undefined);
    console.warn("[gstRegistrations] onboarding GSTIN not registered", { customerId: String(customerId), code: chk.code, gstin: chk.gstin });
    return { skipped: chk };
  }
  const c = await loadCustomer(customerId);
  if (((c.gstRegistrations || []) as GstRegistration[]).some((r) => r.gstin === chk.gstin)) return {};
  const reg = await addRegistration(
    customerId,
    { gstin: chk.gstin, legalName: form?.legalName || form?.companyName, makeDefault: true },
    actor,
    "ONBOARDING",
  );
  return { registration: reg };
}

/** Company-level checks other writers must run before changing gstStatus or
 *  panNumber on a company that has registrations. Throws on a refusal. */
export async function assertCompanyChangeAllowed(customerId: unknown, change: { gstStatus?: unknown; panNumber?: unknown }) {
  const c = await loadCustomer(customerId);
  const active = ((c.gstRegistrations || []) as GstRegistration[]).filter((r) => r.active);
  if (!active.length) return;
  if (change.gstStatus !== undefined && normalizeGstStatus(change.gstStatus) === "UNREGISTERED") {
    throw new GstRegistrationError(409, "ACTIVE_REGISTRATIONS", `This company still has ${active.length} active GST registration(s). Deactivate them before marking it Unregistered.`);
  }
  if (change.panNumber !== undefined) {
    const pan = clean(change.panNumber).toUpperCase();
    if (pan && active.some((r) => panFromGstin(r.gstin) !== pan)) {
      throw new GstRegistrationError(409, "PAN_DIFFERS_FROM_REGISTRATIONS", `PAN ${pan} doesn't match this company's active GST registrations (every GSTIN carries the company PAN).`);
    }
  }
}

/**
 * Adapter for writers that still send the company-level GST fields
 * (gstNumber / gstin, gstRegisteredState / Code) in a Customer update body:
 * PATCH /customers/:id, PATCH /master-data/:id (Customer sync), staff
 * PATCH /workspace/settings/pan. It runs the company checks, applies a sent
 * GSTIN through applyLegacyGstin(), and REMOVES the GST keys it handled from
 * `body`, so the caller's own $set can never write them raw. Nothing is
 * silently dropped: input that contradicts the registrations is refused.
 *
 * Returns the company's default GSTIN after the change (for callers that
 * keep a copy, e.g. the onboarding form), or undefined if no GST key was sent.
 */
/**
 * Would this legacy body change the company's GSTIN, GST state or GST status?
 * Compared with what is stored, so a form that re-sends unchanged values (or a
 * blank GSTIN, which keeps it) is not a change.
 */
function legacyGstChange(c: any, body: Record<string, any>): string | null {
  const hadActive = ((c.gstRegistrations || []) as GstRegistration[]).some((r) => r.active);
  const gstSent = body.gstNumber ?? body.gstin;
  if (gstSent !== undefined) {
    const g = normalizeGstin(gstSent);
    const cur = normalizeGstin(c.gstNumber || c.gstin);
    if (g ? g !== cur : !hadActive && !!cur) return "GSTIN";
  }
  for (const k of ["gstRegisteredState", "gstRegisteredStateCode"] as const) {
    if (body[k] === undefined) continue;
    const sent = String(body[k] ?? "").trim().toLowerCase();
    const cur = String(c[k] ?? "").trim().toLowerCase();
    // With a default registration a blank state is ignored (kept), never applied.
    if (sent !== cur && !(hadActive && !sent)) return "GST state";
  }
  if (body.gstStatus !== undefined && normalizeGstStatus(body.gstStatus) !== normalizeGstStatus(c.gstStatus)) return "GST status";
  return null;
}

export const GST_ACCESS_REQUIRED_MESSAGE =
  "Changing a company's GSTIN or GST state needs the GST Registrations grant (Access Console). Other changes save without it.";

export async function applyLegacyGstFields(
  customerId: unknown,
  body: Record<string, any>,
  actor: Actor,
  access: { canManageGst: boolean },
): Promise<string | undefined> {
  const gstSent = body.gstNumber ?? body.gstin;
  const stateSent = body.gstRegisteredState;
  const panSent = typeof (body.panNumber ?? body.pan) === "string" ? clean(body.panNumber ?? body.pan).toUpperCase() : "";
  // Access first, before any validation or write: without the grant a GST
  // change is refused outright (never silently dropped), and nothing saves.
  if (!access.canManageGst && (gstSent !== undefined || body.gstRegisteredState !== undefined || body.gstRegisteredStateCode !== undefined || body.gstStatus !== undefined)) {
    const what = legacyGstChange(await loadCustomer(customerId), body);
    if (what) throw new GstRegistrationError(403, "GST_REGISTRATIONS_ACCESS_REQUIRED", GST_ACCESS_REQUIRED_MESSAGE, { field: what });
  }
  await assertCompanyChangeAllowed(customerId, { gstStatus: body.gstStatus, panNumber: panSent || undefined });
  if (gstSent === undefined && stateSent === undefined) return undefined;

  const c = await loadCustomer(customerId);
  const hadActive = ((c.gstRegistrations || []) as GstRegistration[]).some((r) => r.active);

  if (gstSent !== undefined) {
    delete body.gstNumber;
    delete body.gstin;
    const g = normalizeGstin(gstSent);
    if (!access.canManageGst) {
      // Only reachable with the GSTIN unchanged (a change was refused above):
      // keep it exactly as stored. Turning it into a registration is an add,
      // which needs the grant.
    } else if (!g) {
      // A blank never clears a registration (that is deactivate's job) — it
      // keeps the GSTIN, as the Business Master form always has ("a blank
      // never wipes", F1). A legacy company with no registrations still clears.
      if (!hadActive) body.gstNumber = "";
    } else {
      const status = normalizeGstStatus(body.gstStatus ?? c.gstStatus);
      if (status === "UNREGISTERED") {
        throw new GstRegistrationError(400, "COMPANY_UNREGISTERED", "An Unregistered (B2C) company takes no GSTIN. Set its GST status to Registered, or leave the GSTIN blank.");
      }
      if (panSent && panFromGstin(g) !== panSent) {
        throw new GstRegistrationError(400, "PAN_MISMATCH", `GSTIN "${g}" does not belong to PAN "${panSent}" (characters 3–12 of a GSTIN are the PAN).`);
      }
      await applyLegacyGstin(customerId, g, actor);
    }
  }

  const after = await loadCustomer(customerId);
  const def = defaultRegistration(after.gstRegistrations);
  if (def) {
    if (body.gstStatus !== undefined && normalizeGstStatus(body.gstStatus) !== "REGISTERED") {
      throw new GstRegistrationError(409, "ACTIVE_REGISTRATIONS", "This company has active GST registrations, so its GST status is Registered.");
    }
    if (stateSent !== undefined) {
      if (String(stateSent).trim() && String(stateSent).trim().toLowerCase() !== def.state.toLowerCase()) {
        throw new GstRegistrationError(400, "STATE_FROM_GSTIN", `The GST state comes from the default GSTIN ${def.gstin} (${def.state}). Change the default registration instead.`);
      }
      delete body.gstRegisteredState;
      delete body.gstRegisteredStateCode;
    }
    return def.gstin;
  }
  return normalizeGstin(gstSent) || undefined;
}

/** Express helper: turn a GstRegistrationError into its JSON response. */
export function sendGstRegistrationError(res: any, err: unknown): boolean {
  if (!(err instanceof GstRegistrationError)) return false;
  res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
  return true;
}
