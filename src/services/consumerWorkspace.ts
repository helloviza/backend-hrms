// apps/backend/src/services/consumerWorkspace.ts
//
// The single synthetic CustomerWorkspace every D2C consumer is stamped with.
//
// WHY A CONSTANT ObjectId, NOT AN UPSERTED ONE
// --------------------------------------------
// requireConsumer stamps this id on every request without a DB read, so it
// has to be the SAME id in every environment. An upsert that let Mongo
// generate the _id would produce a different value locally, in staging and in
// production, and "the D2C workspace id" would stop being one thing.
//
// Hardcoding a workspace id is an existing convention in this codebase, not a
// new one: the HOUSE workspace 69679a7628330a58d29f2254 is hardcoded in
// middleware/requireWorkspace.ts:120, middleware/requireFeature.ts:7 and
// routes/onboarding.ts.
//
// WHAT THIS WORKSPACE IS AND IS NOT
// ---------------------------------
// It exists so tenant-shaped code downstream has something real to read. It
// is NOT an isolation boundary between consumers — every consumer shares it,
// so it separates D2C from B2B and nothing else. Per-consumer isolation is
// ROW-LEVEL on Consumer._id, mirroring how routes/expenses.ts isolates an
// employee's own rows (`{ employeeId: me, workspaceId }`): the actor's own id
// is a mandatory clause in every query, never an inferred one.
//
// Deliberately NOT the HOUSE workspace. HOUSE is the many-Customers-to-one
// tenant that services/visaBillingSync.ts's resolveBillingCustomer already
// refuses to bill unambiguously (AMBIGUOUS_CUSTOMER); parking consumers there
// would inherit that refusal for every D2C case.
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

/** Fixed, deterministic, environment-independent. */
export const HELLOVIZA_D2C_WORKSPACE_ID = "d2c00000000000000000d2c1";

export const HELLOVIZA_D2C_CUSTOMER_ID = "helloviza-d2c";
export const HELLOVIZA_D2C_COMPANY_NAME = "Helloviza D2C";

export function d2cWorkspaceObjectId(): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(HELLOVIZA_D2C_WORKSPACE_ID);
}

/**
 * Idempotently ensures the D2C workspace row exists with the constant _id.
 *
 * NEVER called from the request path — requireConsumer stamps the constant
 * directly and does no DB work for it. This is for tests and for a
 * seed/migration step, so a boot or a request can never turn into a write.
 *
 * $setOnInsert only: re-running this must not overwrite anything an
 * administrator later changed on the row (feature flags, branding), which is
 * the difference between "ensure it exists" and "reset it".
 */
export async function ensureD2CWorkspace(): Promise<mongoose.Types.ObjectId> {
  const _id = d2cWorkspaceObjectId();

  await CustomerWorkspace.findOneAndUpdate(
    { _id },
    {
      $setOnInsert: {
        _id,
        customerId: HELLOVIZA_D2C_CUSTOMER_ID,
        companyName: HELLOVIZA_D2C_COMPANY_NAME,
        status: "ACTIVE",
        source: "SELF_SERVICE",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return _id;
}
