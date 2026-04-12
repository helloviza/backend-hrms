import mongoose from 'mongoose'
import dotenv from 'dotenv'
import Customer from '../models/Customer.js'
import ManualBooking from '../models/ManualBooking.js'
import User from '../models/User.js'
dotenv.config()

async function seed() {
  const uri = process.env.MONGO_URI
  if (!uri) throw new Error('MONGO_URI not set')

  await mongoose.connect(uri)

  // Find Inteletek AI customer
  const customer = await Customer.findOne({
    $or: [
      { legalName: /inteletek/i },
      { name: /inteletek/i },
    ],
  }).lean()

  if (!customer) {
    console.error('Inteletek AI customer not found')
    process.exit(1)
  }
  console.log(
    'Found customer:',
    (customer as any).legalName || (customer as any).name,
    customer._id,
  )

  // Find admin user to set as bookedBy
  const adminUser = await User.findOne({ email: 'admin@plumtrips.com' }).lean()

  if (!adminUser) {
    console.error('Admin user not found (admin@plumtrips.com)')
    process.exit(1)
  }

  const bookings = [
    {
      workspaceId: new mongoose.Types.ObjectId(customer._id.toString()),
      type: 'FLIGHT',
      status: 'CONFIRMED',
      source: 'MANUAL',
      bookingDate: new Date(),
      travelDate: new Date('2026-04-20'),
      sector: 'DEL-BOM',
      itinerary: {
        origin: 'DEL',
        destination: 'BOM',
        airline: 'IndiGo',
        flightNo: '6E-201',
        description: 'DEL → BOM',
      },
      passengers: [{ name: 'Dhiraj Kumar', type: 'ADULT' }],
      pricing: {
        actualPrice: 8500,
        quotedPrice: 9800,
        gstMode: 'ON_MARKUP',
        gstPercent: 18,
        currency: 'INR',
      },
      supplierName: 'TBO',
      supplierPNR: 'TESTPNR1',
      bookedBy: adminUser._id,
    },
    {
      workspaceId: new mongoose.Types.ObjectId(customer._id.toString()),
      type: 'FLIGHT',
      status: 'CONFIRMED',
      source: 'MANUAL',
      bookingDate: new Date(),
      travelDate: new Date('2026-04-25'),
      sector: 'BOM-DEL',
      itinerary: {
        origin: 'BOM',
        destination: 'DEL',
        airline: 'Air India',
        flightNo: 'AI-102',
        description: 'BOM → DEL',
      },
      passengers: [{ name: 'Dhiraj Kumar', type: 'ADULT' }],
      pricing: {
        actualPrice: 7200,
        quotedPrice: 8500,
        gstMode: 'ON_MARKUP',
        gstPercent: 18,
        currency: 'INR',
      },
      supplierName: 'TBO',
      supplierPNR: 'TESTPNR2',
      bookedBy: adminUser._id,
    },
    {
      workspaceId: new mongoose.Types.ObjectId(customer._id.toString()),
      type: 'HOTEL',
      status: 'CONFIRMED',
      source: 'MANUAL',
      bookingDate: new Date(),
      travelDate: new Date('2026-04-20'),
      returnDate: new Date('2026-04-22'),
      sector: 'Mumbai',
      itinerary: {
        hotelName: 'Taj Lands End',
        roomType: 'Deluxe Room',
        nights: 2,
        destination: 'Mumbai',
        description: 'Taj Lands End, Mumbai',
      },
      passengers: [{ name: 'Dhiraj Kumar', type: 'ADULT' }],
      pricing: {
        actualPrice: 12000,
        quotedPrice: 14000,
        gstMode: 'ON_MARKUP',
        gstPercent: 18,
        currency: 'INR',
      },
      supplierName: 'TBO',
      supplierPNR: 'HOTELBKG001',
      bookedBy: adminUser._id,
    },
    {
      workspaceId: new mongoose.Types.ObjectId(customer._id.toString()),
      type: 'FLIGHT',
      status: 'CONFIRMED',
      source: 'MANUAL',
      bookingDate: new Date(),
      travelDate: new Date('2026-04-22'),
      sector: 'DEL-BLR',
      itinerary: {
        origin: 'DEL',
        destination: 'BLR',
        airline: 'Vistara',
        flightNo: 'UK-820',
        description: 'DEL → BLR',
      },
      passengers: [{ name: 'Rahul Sharma', type: 'ADULT' }],
      pricing: {
        actualPrice: 6800,
        quotedPrice: 7900,
        gstMode: 'ON_MARKUP',
        gstPercent: 18,
        currency: 'INR',
      },
      supplierName: 'TBO',
      supplierPNR: 'TESTPNR3',
      bookedBy: adminUser._id,
    },
  ]

  for (const booking of bookings) {
    const doc = new ManualBooking(booking as any)
    await doc.save()
    console.log(
      'Created:',
      doc.bookingRef,
      '-',
      booking.type,
      '-',
      booking.sector,
      '- Quoted:',
      booking.pricing.quotedPrice,
    )
  }

  console.log('\n4 bookings created for Inteletek AI')
  console.log('Go to /admin/manual-bookings, select all 4,')
  console.log('and click Generate Invoice')

  const verify = await ManualBooking.findOne({ bookingRef: 'MB-2604-0001' }).lean()
  console.log('Verification - workspaceId:', (verify as any)?.workspaceId)
  console.log('Verification - customerId: ', customer._id)

  await mongoose.disconnect()
}

seed().catch(console.error)
