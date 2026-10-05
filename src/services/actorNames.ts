// apps/backend/src/services/actorNames.ts
//
// WHO DID IT — the one actor resolver for approval requests, proposals,
// Travel Desk activity, passport-reveal audit and booking history.
//
// Every activity row names its actor by profile name (first + last), never a
// raw id:
//   • on write, rows carry actorId + actorName + actorKind (actorStamp /
//     SYSTEM_ACTOR);
//   • on read, rows written before that (by = a user id or an email, maybe a
//     userName / byName) are resolved in ONE batched User lookup per response
//     (resolveActors) — no per-row queries;
//   • actorKind: "system" for genuinely automatic events (auto-approve,
//     auto-assign, scheduled jobs), "staff" for Plumtrips (HOUSE) users,
//     "customer" for everyone else.
//
// Customer-side viewers never learn a staff member's name or email: every
// staff actor reads "Plumtrips Travel Desk" (maskStaffActors), and raw ids are
// dropped from what they receive. Staff screens keep real names.
//
// actorNamesOnResponse(isStaffViewer) applies both at the one point every
// response of a router passes through (res.json), so no route can forget.
import mongoose from "mongoose";
import User from "../models/User.js";
import TravellerProfile from "../models/TravellerProfile.js";

export type ActorKind = "customer" | "staff" | "system";
export const TRAVEL_DESK_NAME = "Plumtrips Travel Desk";
/**
 * The travel desk's mailbox: the reply-to on customer emails sent on behalf of
 * a staff member, so a customer's reply never goes to (or reveals) a personal
 * address. One constant; DESK_EMAIL in the environment overrides it.
 */
export const DESK_EMAIL = String(process.env.DESK_EMAIL || "").trim() || "ops@plumtrips.com";
export const SYSTEM_NAME = "System";

const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";
const STAFF_EMAIL_DOMAINS = new Set(["plumtrips.com", "helloviza.com"]);
const HEX24 = /^[a-f0-9]{24}$/i;

const str = (v: any) => (v === null || v === undefined ? "" : String(v).trim());
const lower = (v: any) => str(v).toLowerCase();

/**
 * Names an account was created with when nobody typed one (customerUsers.ts
 * used to store firstName "Workspace User"). Never shown when a real name
 * exists anywhere.
 */
const PLACEHOLDER_NAMES = new Set(["workspace user", "user", "customer", "traveller", "traveler"]);
export function isPlaceholderName(v: any): boolean {
  return PLACEHOLDER_NAMES.has(lower(v));
}
const real = (v: any) => (isPlaceholderName(v) ? "" : str(v));

/** A person's display name from their profile: first + last, else `name`. Placeholders don't count. */
export function personName(u: any): string {
  const full = [real(u?.firstName), str(u?.lastName)].filter(Boolean).join(" ");
  return real(full) || real(u?.name) || real(u?.fullName);
}

/**
 * user id → name on the traveller profile they claimed (My Profile), for users
 * whose account carries no real name. One query for the batch.
 */
async function claimedProfileNames(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = userIds.filter((i) => HEX24.test(i));
  if (!ids.length) return out;
  try {
    const rows = (await TravellerProfile.find({ claimedBy: { $in: ids.map((i) => new mongoose.Types.ObjectId(i)) } })
      .select("claimedBy firstName lastName")
      .lean()) as any[];
    for (const r of rows) {
      const name = [str(r.firstName), str(r.lastName)].filter(Boolean).join(" ");
      if (name && !out.has(String(r.claimedBy))) out.set(String(r.claimedBy), name);
    }
  } catch (err: any) {
    console.error("[actor-names] traveller profile lookup failed", err?.message || err);
  }
  return out;
}

export type RealName = { firstName: string; lastName: string; name: string; source: "profile" | "traveller" | "email" | "none" };

/**
 * A user's real name, the one rule for the login session and the placeholder
 * backfill: their profile (first + last, else `name`) → the traveller profile
 * they claimed → (only when `allowEmail`) their email's local part. Never a
 * placeholder like "Workspace User". `source: "none"` when nothing better exists.
 */
export async function resolveRealName(user: any, opts: { allowEmail?: boolean } = {}): Promise<RealName> {
  const first = real(user?.firstName);
  const last = str(user?.lastName);
  const full = [first, last].filter(Boolean).join(" ");
  if (real(full)) return { firstName: first || last, lastName: first ? last : "", name: full, source: "profile" };
  const named = real(user?.name) || real(user?.fullName);
  if (named) {
    const [f, ...rest] = named.split(/\s+/);
    return { firstName: f, lastName: rest.join(" "), name: named, source: "profile" };
  }

  const id = str(user?._id || user?.id || user?.sub);
  if (HEX24.test(id)) {
    try {
      const p: any = await TravellerProfile.findOne({ claimedBy: new mongoose.Types.ObjectId(id) })
        .select("firstName lastName")
        .sort({ claimedAt: -1 })
        .lean();
      const pf = str(p?.firstName);
      const pl = str(p?.lastName);
      const pn = [pf, pl].filter(Boolean).join(" ");
      if (real(pn)) return { firstName: pf || pl, lastName: pf ? pl : "", name: pn, source: "traveller" };
    } catch (err: any) {
      console.error("[actor-names] traveller profile lookup failed", err?.message || err);
    }
  }

  const local = lower(user?.email).split("@")[0];
  if (opts.allowEmail && local) return { firstName: local, lastName: "", name: local, source: "email" };
  return { firstName: "", lastName: "", name: "", source: "none" };
}

/** What a name slot shows when nobody can be named — never an id. */
export const UNKNOWN_USER = "Unknown user";

/** The first candidate that is a real name (not empty, not a raw id), else UNKNOWN_USER. */
export function nameOrUnknown(...candidates: any[]): string {
  for (const c of candidates) {
    const s = str(c);
    if (s && !HEX24.test(s)) return s;
  }
  return UNKNOWN_USER;
}

/** Is this a bare Mongo id (a value that must never be shown as a name)? */
export function isRawId(v: any): boolean {
  return HEX24.test(str(v));
}

/**
 * Profile names for a set of user ids (or emails), in ONE query: id/email →
 * personName, falling back to the email. Unknown keys are simply absent.
 */
export async function userNames(keys: any[]): Promise<Map<string, string>> {
  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const k of keys) {
    const v = str(k);
    if (HEX24.test(v)) ids.add(v);
    else if (v.includes("@")) emails.add(v.toLowerCase());
  }
  const out = new Map<string, string>();
  if (!ids.size && !emails.size) return out;
  const or: any[] = [];
  if (ids.size) or.push({ _id: { $in: [...ids].map((i) => new mongoose.Types.ObjectId(i)) } });
  if (emails.size) or.push({ email: { $in: [...emails] } });
  let users: any[] = [];
  try {
    users = (await User.find({ $or: or }).select("firstName lastName name email").lean()) as any[];
  } catch (err: any) {
    // Names are display-only: a failed lookup must never fail the page —
    // callers fall back to "Unknown user", still never an id.
    console.error("[actor-names] user lookup failed", err?.message || err);
  }
  const claimed = await claimedProfileNames(users.filter((u) => !personName(u)).map((u) => String(u._id)));
  for (const u of users) {
    const name = personName(u) || claimed.get(String(u._id)) || str(u.email);
    if (!name) continue;
    out.set(String(u._id), name);
    if (u.email) out.set(lower(u.email), name);
  }
  return out;
}

/**
 * Free-text notes that older code wrote with a user id where a name was
 * missing ("Assigned to 69dc05e1…", "L1 → 69a7f38d…"). Returns a function that
 * rewrites such text: every id that is a user becomes their profile name; an
 * id in an "Assigned to" / "→" slot that is not a user becomes "Unknown user".
 * Other ids are left alone. One lookup for all the texts given.
 */
export async function idsToNamesInText(texts: any[]): Promise<(t: any) => string> {
  const ids = new Set<string>();
  for (const t of texts) for (const m of str(t).matchAll(/\b[a-f0-9]{24}\b/gi)) ids.add(m[0]);
  const names = ids.size ? await userNames([...ids]) : new Map<string, string>();
  return (t: any) =>
    str(t)
      .replace(/(Assigned to |→ )([a-f0-9]{24})\b/gi, (_all, lead, id) => `${lead}${names.get(id) || UNKNOWN_USER}`)
      .replace(/\b[a-f0-9]{24}\b/gi, (id) => names.get(id) || id);
}

/** Fields to spread into a row written by `user` (a JWT user or a User doc). */
export function actorStamp(user: any, kind: ActorKind) {
  return {
    actorId: str(user?.sub || user?._id || user?.id),
    actorName: personName(user),
    actorKind: kind,
  };
}

/** Fields for a row the system wrote on its own (auto-approve, auto-assign, jobs). */
export const SYSTEM_ACTOR = { actorId: "", actorName: SYSTEM_NAME, actorKind: "system" as ActorKind };

/* ───────────────────────── recognising rows ───────────────────────── */

const AUTO_ACTIONS = new Set(["auto_approved", "admin_auto_assigned"]);

function isSystemRow(e: any): boolean {
  if (e?.actorKind === "system") return true;
  const action = str(e?.action);
  if (AUTO_ACTIONS.has(action)) return true;
  if (action === "approved" && /^auto-approved/i.test(str(e?.comment))) return true;
  const by = lower(e?.by);
  return by.startsWith("system") || by === "auto";
}

/** An object that names an actor: a history row, a decision, a clarification, a reveal, a booking. */
function isActorRow(o: any): boolean {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  if ("byEmail" in o || "byName" in o || "byUserId" in o || "actorName" in o || "actorId" in o) return true;
  if ("doneByName" in o || "doneByEmail" in o) return true;
  // A proposal's requesterEmail/Name is whoever created the draft (often staff).
  if ("requesterEmail" in o || "createdBy" in o) return true;
  return "action" in o && ("by" in o || "userEmail" in o || "userName" in o);
}

/** Does the row name anyone at all? (An empty decision slot does not.) */
function hasActor(o: any): boolean {
  if (isSystemRow(o)) return true;
  const { id, email } = refsOf(o);
  return !!(id || email || str(o.actorName) || str(o.userName) || str(o.byName) || str(o.doneByName) || str(o.requesterName));
}

/** Rows found anywhere in a response body, each with the workspace of the document it sits in. */
export function collectActorRows(body: any): Array<{ row: any; workspaceId: string }> {
  const out: Array<{ row: any; workspaceId: string }> = [];
  const walk = (node: any, ws: string, depth: number) => {
    if (!node || typeof node !== "object" || depth > 12) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, ws, depth + 1);
      return;
    }
    const here = str(node.workspaceId?._id || node.workspaceId) || ws;
    if (isActorRow(node) && hasActor(node)) out.push({ row: node, workspaceId: here });
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") walk(v, here, depth + 1);
    }
  };
  walk(body, "", 0);
  return out;
}

function refsOf(e: any): { id: string; email: string } {
  const idCand = [e?.actorId, e?.byUserId, e?.by, e?.createdBy].map(str).find((v) => HEX24.test(v)) || "";
  const emailCand =
    [e?.userEmail, e?.byEmail, e?.actorEmail, e?.doneByEmail, e?.by, e?.requesterEmail].map(lower).find((v) => v.includes("@")) || "";
  return { id: idCand, email: emailCand };
}

/**
 * Fill actorName + actorKind on every row (in place). One User query for the
 * whole batch. The profile name wins over a stored one.
 */
export async function resolveActors(rows: any[]): Promise<void> {
  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const e of rows) {
    const { id, email } = refsOf(e);
    if (id) ids.add(id);
    if (email) emails.add(email);
  }
  const byId = new Map<string, any>();
  const byEmail = new Map<string, any>();
  if (ids.size || emails.size) {
    const or: any[] = [];
    if (ids.size) or.push({ _id: { $in: [...ids].map((i) => new mongoose.Types.ObjectId(i)) } });
    if (emails.size) or.push({ email: { $in: [...emails] } });
    const users = (await User.find({ $or: or }).select("firstName lastName name email workspaceId").lean()) as any[];
    const claimed = await claimedProfileNames(users.filter((u) => !personName(u)).map((u) => String(u._id)));
    for (const u of users) {
      if (!personName(u) && claimed.has(String(u._id))) u.name = claimed.get(String(u._id));
      byId.set(String(u._id), u);
      if (u.email) byEmail.set(lower(u.email), u);
    }
  }

  for (const e of rows) {
    const { id, email } = refsOf(e);
    const u = (id && byId.get(id)) || (email && byEmail.get(email)) || null;
    if (isSystemRow(e)) {
      e.actorKind = "system";
      if (!str(e.actorName)) e.actorName = SYSTEM_NAME;
      continue;
    }
    if (!str(e.actorKind)) {
      const staff = u
        ? String(u.workspaceId || "") === HOUSE_WORKSPACE_ID
        : STAFF_EMAIL_DOMAINS.has(email.split("@")[1] || "");
      e.actorKind = staff ? "staff" : "customer";
    }
    // Never a raw id: the profile name wins (a renamed user shows their current
    // name), else the name stored on the row, else the email.
    e.actorName =
      personName(u) || real(e.actorName) || real(e.userName) || real(e.byName) || real(e.doneByName) || real(e.requesterName) || email || "Unknown user";
  }
}

/** The no-database fallback: kind from the email domain, name from the row. */
function resolveWithoutLookup(rows: any[]): void {
  for (const e of rows) {
    const { email } = refsOf(e);
    if (!str(e.actorKind)) {
      e.actorKind = isSystemRow(e) ? "system" : STAFF_EMAIL_DOMAINS.has(email.split("@")[1] || "") ? "staff" : "customer";
    }
    if (!str(e.actorName)) {
      e.actorName = e.actorKind === "system" ? SYSTEM_NAME : real(e.userName) || real(e.byName) || real(e.doneByName) || email || "Unknown user";
    }
  }
}

/**
 * Customer-side view: a staff actor is "Plumtrips Travel Desk" with no name or
 * email; raw ids go. Rows inside a HOUSE document are left as they are — there
 * the "customer" is Plumtrips itself.
 */
export function maskStaffActors(rows: Array<{ row: any; workspaceId: string }>): void {
  for (const { row: e, workspaceId } of rows) {
    delete e.actorId;
    delete e.byUserId;
    delete e.createdBy;
    if (HEX24.test(str(e.by))) delete e.by;
    if (workspaceId === HOUSE_WORKSPACE_ID || e.actorKind !== "staff") continue;
    e.actorName = TRAVEL_DESK_NAME;
    for (const k of ["userName", "byName", "doneByName", "requesterName"]) if (k in e) e[k] = TRAVEL_DESK_NAME;
    for (const k of ["userEmail", "byEmail", "actorEmail", "doneByEmail", "requesterEmail", "by"]) delete e[k];
  }
}

/** Request documents whose stored requester name is a placeholder (or missing). */
function collectPlaceholderRequesters(body: any): any[] {
  const out: any[] = [];
  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if ("frontlinerName" in node && (node.frontlinerId || node.frontlinerEmail) && !real(node.frontlinerName)) out.push(node);
    for (const k of Object.keys(node)) if (node[k] && typeof node[k] === "object") walk(node[k], depth + 1);
  };
  walk(body, 0);
  return out;
}

/** Placeholder requester names → the profile / claimed-traveller name (one lookup). */
async function fixRequesterNames(docs: any[]): Promise<void> {
  if (!docs.length) return;
  const names = await userNames(docs.flatMap((d) => [d.frontlinerId, d.frontlinerEmail]));
  for (const d of docs) {
    const n = names.get(str(d.frontlinerId)) || names.get(lower(d.frontlinerEmail));
    // userNames falls back to the email; a name slot never becomes an address.
    if (n && !n.includes("@")) d.frontlinerName = n;
  }
}

/**
 * Router middleware: every JSON body this router sends gets actor names
 * resolved, and — unless `isStaffViewer(req)` — staff actors masked. Errors
 * here never block the response (it goes out unresolved and is logged).
 */
export function actorNamesOnResponse(isStaffViewer: (req: any) => boolean | Promise<boolean>) {
  return (req: any, res: any, next: any) => {
    const send = res.json.bind(res);
    res.json = (body: any) => {
      if (!body || typeof body !== "object" || res.statusCode >= 400) return send(body);
      let plain: any;
      try {
        plain = JSON.parse(JSON.stringify(body));
      } catch {
        return send(body);
      }
      const rows = collectActorRows(plain);
      const requesters = collectPlaceholderRequesters(plain);
      if (!rows.length && !requesters.length) return send(plain);
      (async () => {
        try {
          await fixRequesterNames(requesters);
        } catch (err: any) {
          console.error("[actor-names] could not resolve requester names", err?.message || err);
        }
        try {
          await resolveActors(rows.map((r) => r.row));
        } catch (err: any) {
          console.error("[actor-names] could not resolve actors", err?.message || err);
          resolveWithoutLookup(rows.map((r) => r.row));
        }
        // Fails closed: if the viewer cannot be classified, they are a customer.
        const staff = await Promise.resolve(isStaffViewer(req)).catch(() => false);
        if (!staff) maskStaffActors(rows);
      })()
        .catch((err) => console.error("[actor-names] masking failed", err?.message || err))
        .finally(() => send(plain));
      return res;
    };
    next();
  };
}
