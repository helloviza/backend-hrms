import express from "express";
import { requireAuth } from "../middleware/auth.js";
import SBTConfig from "../models/SBTConfig.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import { getAgencyBalance } from "../services/tbo.auth.service.js";

const router = express.Router();

router.use(requireAuth);

// GET /api/sbt/wallet/check?amount=XXXX
router.get("/check", async (req: any, res: any) => {
  try {
    const amount = parseFloat(req.query.amount as string);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // 1. Check workspace config
    const config = await SBTConfig.findOne({ key: "global" }).lean();
    if (!config?.tboWalletEnabled) {
      return res.json({ sufficient: false, reason: "wallet_disabled" });
    }

    // 2. Get TBO agency balance
    const balanceRes = (await getAgencyBalance()) as any;
    const cashBalance: number = balanceRes?.CashBalance ?? 0;

    // 3. Sum monthly spend for this customer (official bookings only)
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const customerId = req.user.customerId;

    const matchFilter = {
      customerId,
      paymentMode: "official",
      createdAt: { $gte: monthStart },
    };

    const [flightAgg, hotelAgg] = await Promise.all([
      SBTBooking.aggregate([
        { $match: matchFilter },
        { $group: { _id: null, total: { $sum: "$totalFare" } } },
      ]),
      SBTHotelBooking.aggregate([
        { $match: matchFilter },
        { $group: { _id: null, total: { $sum: "$totalFare" } } },
      ]),
    ]);

    const monthlySpend =
      (flightAgg[0]?.total ?? 0) + (hotelAgg[0]?.total ?? 0);

    // 4. Check limits
    const monthlyLimit: number = config.tboWalletMonthlyLimit ?? 0;

    if (monthlyLimit > 0 && monthlySpend + amount > monthlyLimit) {
      return res.json({
        sufficient: false,
        reason: "limit_exceeded",
        bookingAmount: amount,
      });
    }

    if (cashBalance < amount) {
      return res.json({
        sufficient: false,
        reason: "low_balance",
        bookingAmount: amount,
      });
    }

    return res.json({ sufficient: true, bookingAmount: amount });
  } catch (err: any) {
    console.error("[SBT Wallet Check]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
