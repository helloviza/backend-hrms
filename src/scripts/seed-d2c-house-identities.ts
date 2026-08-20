/**
 * seed-d2c-house-identities.ts — IDEMPOTENT, LOCAL-ONLY
 * ---------------------------------------------------------------------------
 * The two identities services/d2cInvoicing.ts looks up by stable business key
 * before it will invoice anything. Precedent and shape:
 * scripts/seed-intake-system-identities.ts, which does exactly this for the
 * travel-intake pipeline.
 *
 *  1. A house "Helloviza D2C" Customer — the Customer._id every D2C
 *     ManualBooking.workspaceId points at. A consumer has no employer and
 *     therefore no Customer row of their own; this one exists so the
 *     tenant-shaped invoicing pipeline has something real to group on. It is
 *     NOT the bill-to: the consumer's own name and email go on the invoice
 *     via clientDetailsOverride.
 *
 *     gstRegisteredState "Karnataka" is load-bearing. Without a client state
 *     detectGSTType cannot calculate and createInvoiceFromBookings throws
 *     GST_DETECTION_FAILED. Karnataka (= the issuer's own state) makes the
 *     supply intra-state CGST+SGST, which is the correct treatment for an
 *     unregistered recipient with no address on record — and it gets there
 *     WITHOUT gstBypass, so no consumer receipt carries a bypass audit trail
 *     for what is an ordinary B2C sale.
 *
 *     workspaceId is deliberately NOT set to the synthetic D2C
 *     CustomerWorkspace. Pointing it there would make
 *     Customer.countDocuments({ workspaceId }) return >1 the moment a second
 *     row ever joined it, which is precisely the AMBIGUOUS_CUSTOMER condition
 *     services/visaBillingSync.ts's resolveBillingCustomer refuses to bill on.
 *     Leaving it unset keeps that counter honest.
 *
 *  2. A "System D2C" User — bookedBy on the ManualBooking and createdBy on
 *     the Invoice. The webhook has no user; these fields are required (
 *     ManualBooking.bookedBy) or wanted for audit (Invoice.createdBy).
 *     Login is not a supported path for this identity: the password is
 *     random and never disclosed.
 *
 * REFUSES to run against anything but 127.0.0.1/localhost.
 *
 * Run:  NODE_ENV=development npx tsx --env-file=.env.development \
 *         src/scripts/seed-d2c-house-identities.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import crypto from "crypto";
import bcrypt from "bcryptjs";

import Customer from "../models/Customer.js";
import User from "../models/User.js";
import { ensureD2CWorkspace, HELLOVIZA_D2C_WORKSPACE_ID } from "../services/consumerWorkspace.js";
import {
  D2C_HOUSE_CUSTOMER_CODE,
  D2C_HOUSE_CUSTOMER_NAME,
  D2C_SYSTEM_USER_EMAIL,
} from "../services/d2cInvoicing.js";

async function main() {
  const uri = process.env.MONGO_URI || "";
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)) {
    throw new Error(`REFUSING: MONGO_URI is not local (${uri || "unset"})`);
  }
  await mongoose.connect(uri);
  console.log(`[seed-d2c-house-identities] connected to ${mongoose.connection.name}`);

  // User.workspaceId is required and refs CustomerWorkspace — the synthetic
  // D2C workspace is the right one for THIS field (it is a workspace id, not
  // a Customer id, so none of the ambiguity reasoning above applies).
  await ensureD2CWorkspace();

  const houseCustomer = await Customer.findOneAndUpdate(
    { customerCode: D2C_HOUSE_CUSTOMER_CODE },
    {
      $setOnInsert: {
        name: D2C_HOUSE_CUSTOMER_NAME,
        legalName: D2C_HOUSE_CUSTOMER_NAME,
        customerCode: D2C_HOUSE_CUSTOMER_CODE,
        type: "CUSTOMER",
        status: "ACTIVE",
        segment: "internal",
        gstRegisteredState: "Karnataka",
        gstRegisteredStateCode: "29",
        description:
          "Internal tenancy row for helloviza.ai D2C consumer sales. Owns every D2C ManualBooking so the invoicing pipeline has a Customer to group on — NOT the bill-to, which is the individual consumer (see services/d2cInvoicing.ts). Not a real client.",
      },
    },
    { upsert: true, new: true },
  );
  console.log("[seed-d2c-house-identities] Helloviza D2C Customer._id:", String(houseCustomer._id));
  console.log("  gstRegisteredState:", (houseCustomer as any).gstRegisteredState);
  console.log("  workspaceId (must be undefined):", (houseCustomer as any).workspaceId);

  let systemUser = await User.findOne({ email: D2C_SYSTEM_USER_EMAIL });
  if (!systemUser) {
    const randomPassword = crypto.randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(randomPassword, 12);
    systemUser = await User.create({
      email: D2C_SYSTEM_USER_EMAIL,
      officialEmail: D2C_SYSTEM_USER_EMAIL,
      workspaceId: HELLOVIZA_D2C_WORKSPACE_ID,
      name: "System D2C",
      passwordHash,
      roles: ["SYSTEM_D2C"],
      status: "ACTIVE",
    });
    console.log("[seed-d2c-house-identities] Created System D2C User._id:", String(systemUser._id));
  } else {
    console.log("[seed-d2c-house-identities] System D2C User already exists._id:", String(systemUser._id));
  }

  console.log("\n=== SUMMARY ===");
  console.log("D2C_HOUSE_CUSTOMER_ID (ManualBooking.workspaceId):", String(houseCustomer._id));
  console.log("D2C_SYSTEM_USER_ID    (bookedBy / createdBy)     :", String(systemUser._id));

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
