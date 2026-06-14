/* eslint-disable no-console */
import mongoose from "mongoose";
import { connectDb } from "../src/config/db.js";
import User from "../src/models/User.js";
import { UserPermission } from "../src/models/UserPermission.js";
import CustomerWorkspace from "../src/models/CustomerWorkspace.js";
import ManualBooking from "../src/models/ManualBooking.js";
import Invoice from "../src/models/Invoice.js";

const WS_ID  = "69cc5ac44fae691064b1997a";
const CUST_ID = "69cc496b20f2a4a00c4bf4b3";

async function main() {
  await connectDb();

  // 1. CustomerWorkspace isDemo + wallet
  const ws: any = await CustomerWorkspace.findById(WS_ID).select("isDemo sbtOfficialBooking").lean();
  console.log("\n[Q1] CustomerWorkspace.isDemo + sbtOfficialBooking:");
  console.log("  isDemo:", ws?.isDemo);
  console.log("  sbtOfficialBooking:", ws?.sbtOfficialBooking);

  // 2. Demo user count
  const demoUserCount = await User.countDocuments({ customerId: CUST_ID, isDemoUser: true });
  console.log(`\n[Q2] Users (customerId=${CUST_ID}, isDemoUser=true): ${demoUserCount} (expect 4)`);

  // 3. UserPermission count
  const permCount = await UserPermission.countDocuments({ workspaceId: WS_ID });
  console.log(`\n[Q3] UserPermissions (workspaceId=${WS_ID}): ${permCount} (expect 4)`);

  // 4. ManualBookings count
  const bookingCount = await ManualBooking.countDocuments({
    workspaceId: new mongoose.Types.ObjectId(WS_ID),
    isDemo: true,
  });
  console.log(`\n[Q4] ManualBookings (workspaceId=${WS_ID}, isDemo=true): ${bookingCount} (expect 26)`);

  // 5. Invoices count
  const invoiceCount = await Invoice.countDocuments({
    workspaceId: new mongoose.Types.ObjectId(WS_ID),
    isDemo: true,
  });
  console.log(`\n[Q5] Invoices (workspaceId=${WS_ID}, isDemo=true): ${invoiceCount} (expect 10)`);

  // 6. Rep demoAccess
  const rep: any = await User.findOne({ email: "imran.ali@plumtrips.com" }).select("demoAccess").lean();
  console.log("\n[Q6] Rep imran.ali@plumtrips.com demoAccess:");
  console.log("  enabled:", rep?.demoAccess?.enabled);
  console.log("  mappedSeedUsers count:", rep?.demoAccess?.mappedSeedUsers?.length);
  console.log("  mappedSeedUsers:", rep?.demoAccess?.mappedSeedUsers);

  // Bonus: distribution of invoice statuses
  const byStatus = await Invoice.aggregate([
    { $match: { workspaceId: new mongoose.Types.ObjectId(WS_ID), isDemo: true } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  console.log("\n[bonus] Invoice status distribution:", byStatus);

  // Bonus: distribution of booking statuses
  const bookingByStatus = await ManualBooking.aggregate([
    { $match: { workspaceId: new mongoose.Types.ObjectId(WS_ID), isDemo: true } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  console.log("[bonus] Booking status distribution:", bookingByStatus);

  // Bonus: distribution of booking types
  const bookingByType = await ManualBooking.aggregate([
    { $match: { workspaceId: new mongoose.Types.ObjectId(WS_ID), isDemo: true } },
    { $group: { _id: "$type", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  console.log("[bonus] Booking type distribution:", bookingByType);

  // Confirm admin@inteletekai untouched
  const adminLegacy: any = await User.findOne({ email: "admin@inteletekai.com" }).lean();
  console.log("\n[guard] admin@inteletekai.com state:");
  console.log("  _id:", adminLegacy?._id);
  console.log("  isDemoUser:", adminLegacy?.isDemoUser, "(should be falsy/undefined)");
  console.log("  accountType:", adminLegacy?.accountType, "(should still be undefined — broken)");
  console.log("  workspaceId typeof:", typeof adminLegacy?.workspaceId, " value:", adminLegacy?.workspaceId);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
