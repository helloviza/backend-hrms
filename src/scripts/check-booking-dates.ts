import { connectDb } from "../config/db.js"
import SBTBooking from "../models/SBTBooking.js"

await connectDb()

const bookings = await SBTBooking.find({
  customerId: "69cc496b20f2a4a00c4bf4b3"
}).select("pnr bookedAt createdAt status userId").lean()

console.log('Total bookings by customerId:', bookings.length)
bookings.forEach((b: any) => {
  console.log({
    pnr: b.pnr,
    bookedAt: b.bookedAt,
    createdAt: b.createdAt,
    status: b.status
  })
})

process.exit(0)
