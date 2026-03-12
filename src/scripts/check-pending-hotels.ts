// Temporary script to check Razorpay payment details for PENDING hotel bookings
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";

async function main() {
  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to MongoDB");

  const ids = [
    "69b11947fc3cdd1284559ef4",
    "69b0b2fd32d01378e35ff017",
  ];

  const bookings = await SBTHotelBooking.find(
    { _id: { $in: ids } },
    {
      hotelName: 1,
      status: 1,
      paymentId: 1,
      razorpayOrderId: 1,
      razorpayAmount: 1,
      totalFare: 1,
      bookingId: 1,
      confirmationNo: 1,
      paymentStatus: 1,
      createdAt: 1,
    }
  ).lean();

  console.log(JSON.stringify(bookings, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
