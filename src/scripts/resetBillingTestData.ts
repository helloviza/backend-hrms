import mongoose from 'mongoose'
import dotenv from 'dotenv'
dotenv.config()

async function reset() {
  const uri = process.env.MONGO_URI
  if (!uri) throw new Error('MONGO_URI not set')

  await mongoose.connect(uri)

  const db = mongoose.connection.db!

  const bookingsDel = await db.collection('manualbookings').deleteMany({})
  const invoicesDel = await db.collection('invoices').deleteMany({})

  console.log(`Deleted ${bookingsDel.deletedCount} manual bookings`)
  console.log(`Deleted ${invoicesDel.deletedCount} invoices`)

  await mongoose.disconnect()
  console.log('Done.')
}

reset().catch(console.error)
