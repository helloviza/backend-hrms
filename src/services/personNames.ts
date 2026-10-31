// apps/backend/src/services/personNames.ts
//
// A login's PERSON name — never the company it belongs to
// (docs/audits/company-vs-person-name-audit.md).
//
//   • suggestLoginPersonName: who the login being created by promote-customer /
//     promote-vendor is, from what the onboarding form collected. Unknown → "",
//     never the company.
//   • splitPersonName: one typed "full name" → firstName / lastName / name.
//   • renameUser: the one write for "edit name" (self, Plumtrips staff, a
//     Workspace Leader). Keeps name = first + last, copies it to the person's
//     roster rows (CustomerMember.name) and appends a UserNameAudit row.
import User from "../models/User.js";
import CustomerMember from "../models/CustomerMember.js";
import UserNameAudit from "../models/UserNameAudit.js";
import { isPlaceholderName } from "./actorNames.js";

const str = (v: any) => (v === null || v === undefined ? "" : String(v).trim());
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longest first / last name accepted. */
export const NAME_PART_MAX = 60;

/** Legal-form suffixes ignored when comparing a name to a company ("Acme Pvt. Ltd." == "acme"). */
const SUFFIX_RX =
  /(\s+(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation|co|company|plc|gmbh|opc|llc))+$/;

export function normaliseCompany(v: unknown): string {
  return str(v)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(SUFFIX_RX, "")
    .trim();
}

/** Is this "person name" really one of the company names? */
export function sameAsCompany(name: unknown, companyNames: unknown[]): boolean {
  const n = normaliseCompany(name);
  if (!n) return false;
  return companyNames.some((c) => normaliseCompany(c) === n);
}

/** Collapse whitespace; "" for anything that can't be a person's name. */
export function cleanPersonName(v: unknown): string {
  const s = str(v).replace(/\s+/g, " ");
  if (!s || s.includes("@") || isPlaceholderName(s)) return "";
  return s;
}

/** "Asha Rao Iyer" → { firstName: "Asha", lastName: "Rao Iyer", name: "Asha Rao Iyer" }. */
export function splitPersonName(full: unknown): { firstName: string; lastName: string; name: string } {
  const name = cleanPersonName(full);
  if (!name) return { firstName: "", lastName: "", name: "" };
  const [firstName, ...rest] = name.split(" ");
  return { firstName, lastName: rest.join(" "), name };
}

export type PersonSuggestion = {
  name: string;
  source: "keyContactEmail" | "keyContact" | "signatory" | "contactPerson" | "invitee" | "none";
};

/**
 * Who a promoted login is, from the onboarding record. Customer order:
 * the key contact with the promoted email → the first key contact → the
 * signatory → the invitee name. Vendor order: the contact person → the invitee
 * name. Any candidate equal to a company name is skipped; nothing left → "".
 */
export function suggestLoginPersonName(params: {
  kind: "customer" | "vendor";
  onboarding: any;
  form: any;
  email?: string;
  companyNames: unknown[];
}): PersonSuggestion {
  const { kind, onboarding, form, companyNames } = params;
  const email = str(params.email).toLowerCase();
  const ok = (v: unknown) => {
    const n = cleanPersonName(v);
    return n && !sameAsCompany(n, companyNames) ? n : "";
  };

  const candidates: Array<[PersonSuggestion["source"], unknown]> = [];
  if (kind === "customer") {
    const contacts: any[] = Array.isArray(form?.keyContacts) ? form.keyContacts : [];
    const byEmail = email ? contacts.find((c) => str(c?.email).toLowerCase() === email) : undefined;
    candidates.push(["keyContactEmail", byEmail?.name], ["keyContact", contacts[0]?.name], ["signatory", form?.signatory?.name]);
  } else {
    candidates.push(["contactPerson", form?.contactPerson?.name]);
  }
  candidates.push(["invitee", onboarding?.inviteeName]);

  for (const [source, v] of candidates) {
    const name = ok(v);
    if (name) return { name, source };
  }
  return { name: "", source: "none" };
}

export type RenameInput = { firstName: unknown; lastName: unknown };
export type RenameResult = {
  ok: boolean;
  status?: number;
  error?: string;
  user?: { _id: string; firstName: string; lastName: string; name: string };
};

/** Validates a typed first / last name. Returns an error message or the clean parts. */
export function validateNameInput(input: RenameInput): { error: string } | { firstName: string; lastName: string; name: string } {
  const firstName = str(input.firstName).replace(/\s+/g, " ");
  const lastName = str(input.lastName).replace(/\s+/g, " ");
  if (!firstName) return { error: "First name is required" };
  if (firstName.length > NAME_PART_MAX || lastName.length > NAME_PART_MAX) {
    return { error: `Each name part must be ${NAME_PART_MAX} characters or fewer` };
  }
  if (`${firstName} ${lastName}`.includes("@")) return { error: "A name can't contain an email address" };
  if (/[\u0000-\u001f<>]/.test(firstName + lastName)) return { error: "The name contains characters that aren't allowed" };
  const name = [firstName, lastName].filter(Boolean).join(" ");
  if (isPlaceholderName(name)) return { error: "Please enter the person's real name" };
  return { firstName, lastName, name };
}

/**
 * Renames one user. The caller has already decided they may. Writes
 * User.firstName / lastName / name, the person's CustomerMember.name rows,
 * and one UserNameAudit row.
 */
export async function renameUser(params: {
  userId: unknown;
  input: RenameInput;
  actor: { sub?: unknown; _id?: unknown; email?: unknown };
  via: "self" | "staff" | "workspace_leader";
  customerId?: string;
}): Promise<RenameResult> {
  const v = validateNameInput(params.input);
  if ("error" in v) return { ok: false, status: 400, error: v.error };

  const before: any = await User.findById(params.userId).select("email firstName lastName name workspaceId").lean();
  if (!before) return { ok: false, status: 404, error: "User not found" };

  await User.updateOne(
    { _id: before._id },
    { $set: { firstName: v.firstName, lastName: v.lastName, name: v.name } },
  );

  const email = str(before.email).toLowerCase();
  if (email) {
    await CustomerMember.updateMany(
      { email: new RegExp(`^${escapeRx(email)}$`, "i") },
      { $set: { name: v.name, updatedAt: new Date() } },
    );
  }

  await UserNameAudit.create({
    userId: before._id,
    workspaceId: before.workspaceId,
    customerId: params.customerId || undefined,
    email,
    from: { firstName: str(before.firstName), lastName: str(before.lastName), name: str(before.name) },
    to: { firstName: v.firstName, lastName: v.lastName, name: v.name },
    via: params.via,
    actorId: str(params.actor?.sub || params.actor?._id) || undefined,
    actorEmail: str(params.actor?.email).toLowerCase() || undefined,
  });

  return { ok: true, user: { _id: String(before._id), firstName: v.firstName, lastName: v.lastName, name: v.name } };
}

/**
 * The person name a promote writes: the dialog's `personName` when the request
 * carries one (an empty string means "unknown"), else the suggestion. A value
 * equal to the company is dropped — the login is then left without a name.
 */
export function promotePersonName(
  body: any,
  params: Parameters<typeof suggestLoginPersonName>[0],
): { firstName: string; lastName: string; name: string } {
  const typed = body && typeof body.personName === "string";
  const raw = typed ? body.personName : suggestLoginPersonName(params).name;
  const cleaned = cleanPersonName(raw);
  if (!cleaned || sameAsCompany(cleaned, params.companyNames)) return { firstName: "", lastName: "", name: "" };
  return splitPersonName(cleaned);
}
