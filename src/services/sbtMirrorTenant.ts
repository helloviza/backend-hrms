// apps/backend/src/services/sbtMirrorTenant.ts
//
// TravelBooking.tenantId for an SBT booking (Travel Spend audit N7).
//
// Every TravelBooking reader scopes a customer by tenantId = Customer._id
// (admin.unified.billing.ts resolveAccessScope, myBookings.ts), and manual
// bookings write exactly that. The SBT mirrors wrote `customerId ||
// "default"`, but SBTBooking.customerId is legacy and holds three shapes on
// prod: a Customer _id, a CustomerWorkspace _id, or nothing. Rows keyed by a
// workspace id or "default" never reached the customer's own (ORG) view.
//
// Resolution, first hit wins:
//   1. customerId is a Customer _id                 → it
//   2. customerId is a CustomerWorkspace _id        → that workspace's customerId
//   3. the booking's workspaceId → CustomerWorkspace → its customerId
//   … only when that customerId is a real Customer (the "Legacy (Inactive)"
//   workspace points at "legacy-orphaned-data", which is not);
//   4. otherwise "default", as before.
//
// Raw collection reads (no model imports) — the SBT models import this.
import mongoose from "mongoose";

export const DEFAULT_TENANT = "default";

const isOid = (v: unknown) => typeof v === "string" ? /^[0-9a-f]{24}$/i.test(v) : mongoose.isValidObjectId(v);
const toOid = (v: unknown) => new mongoose.Types.ObjectId(String(v));

async function customerExists(id: unknown): Promise<boolean> {
  if (!id || !isOid(String(id))) return false;
  const db = mongoose.connection.db;
  if (!db) return false;
  return !!(await db.collection("customers").findOne({ _id: toOid(id) }, { projection: { _id: 1 } }));
}

async function workspaceCustomer(wsId: unknown): Promise<string | null> {
  if (!wsId || !isOid(String(wsId))) return null;
  const db = mongoose.connection.db;
  if (!db) return null;
  const ws: any = await db.collection("customerworkspaces").findOne({ _id: toOid(wsId) }, { projection: { customerId: 1 } });
  const cid = ws?.customerId ? String(ws.customerId) : null;
  return cid && (await customerExists(cid)) ? cid : null;
}

export async function resolveSbtTenantId(doc: { customerId?: unknown; workspaceId?: unknown }): Promise<string> {
  const cid = String(doc?.customerId ?? "").trim();
  if (cid) {
    if (await customerExists(cid)) return cid;
    const viaWs = await workspaceCustomer(cid);
    if (viaWs) return viaWs;
  }
  const viaBookingWs = await workspaceCustomer(doc?.workspaceId);
  if (viaBookingWs) return viaBookingWs;
  return cid || DEFAULT_TENANT;
}
