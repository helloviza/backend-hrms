// apps/backend/src/services/companyNames.ts
//
// A company's display name — never a raw id. One batched lookup:
//   Customer (workspace.customerId → Customer: name, else legalName)
//   → CustomerWorkspace.companyName
//   → "Unnamed company · <slug>"  (or just "Unnamed company")
// Plumtrips' own workspace reads "Plumtrips (House)". Every person or business
// with a workspace (companies, affiliates, agents, partners) is named the same way.
import mongoose from "mongoose";
import Customer from "../models/Customer.js";
import { HOUSE_WORKSPACE_ID } from "../utils/bookingAccess.js";

type AnyObj = Record<string, any>;

export const HOUSE_DISPLAY_NAME = "Plumtrips (House)";
export const UNNAMED_COMPANY = "Unnamed company";
const HEX24 = /^[a-f0-9]{24}$/i;
const clean = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s && !HEX24.test(s) ? s : "";
};

/** The name for one workspace, given its Customer (or null). */
export function companyNameOf(ws: AnyObj | null | undefined, customer?: AnyObj | null): string {
  if (!ws) return UNNAMED_COMPANY;
  if (String(ws._id) === HOUSE_WORKSPACE_ID) return HOUSE_DISPLAY_NAME;
  const name = clean(customer?.name) || clean(customer?.legalName) || clean(ws.companyName);
  if (name) return name;
  const slug = clean(ws.slug);
  return slug ? `${UNNAMED_COMPANY} · ${slug}` : UNNAMED_COMPANY;
}

/** Is this one of the workspaces with no name anywhere (reported, never shown with its id)? */
export const isUnnamed = (name: string) => name === UNNAMED_COMPANY || name.startsWith(`${UNNAMED_COMPANY} · `);

/** workspace id → display name, for many workspaces in one Customer query. */
export async function companyNames(workspaces: AnyObj[]): Promise<Map<string, string>> {
  const ids = [...new Set(workspaces.map((w) => String(w?.customerId || "")).filter((i) => HEX24.test(i)))];
  const customers = ids.length
    ? ((await Customer.find({ _id: { $in: ids.map((i) => new mongoose.Types.ObjectId(i)) } }).select("name legalName").lean()) as AnyObj[])
    : [];
  const byId = new Map(customers.map((c) => [String(c._id), c]));
  return new Map(workspaces.map((w) => [String(w._id), companyNameOf(w, byId.get(String(w.customerId || "")) || null)]));
}

export async function companyNameFor(ws: AnyObj | null | undefined): Promise<string> {
  if (!ws) return UNNAMED_COMPANY;
  return (await companyNames([ws])).get(String(ws._id)) || UNNAMED_COMPANY;
}
