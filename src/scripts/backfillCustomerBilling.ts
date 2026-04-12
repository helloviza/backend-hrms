import mongoose from 'mongoose'
import Customer from '../models/Customer.js'
import Onboarding from '../models/Onboarding.js'
import dotenv from 'dotenv'
dotenv.config()

async function backfill() {
  const uri = process.env.MONGO_URI
  if (!uri) throw new Error('MONGO_URI not set')

  await mongoose.connect(uri)
  console.log('Connected to MongoDB')
  console.log('Starting Customer billing backfill...')

  const customers = await Customer.find({
    $or: [
      { gstNumber: { $in: ['', null, undefined] } },
      { legalName: { $in: ['', null, undefined] } },
    ],
    onboardingId: { $exists: true, $ne: null },
  }).lean() as any[]

  console.log(`Found ${customers.length} customers to backfill`)

  let updated = 0
  let skipped = 0
  let failed = 0

  for (const customer of customers) {
    try {
      const onboarding = await Onboarding.findOne({
        $or: [
          { _id: customer.onboardingId },
        ],
      }).lean() as any

      if (!onboarding) {
        console.log(`  SKIP  ${customer.name} (${customer._id}) — no onboarding record`)
        skipped++
        continue
      }

      const p = onboarding.formPayload || onboarding.payload || {}

      const updates: any = {}

      if (!customer.legalName && (p.legalName || p.companyName)) {
        updates.legalName = p.legalName || p.companyName
      }
      if (!customer.gstNumber && (p.gstNumber || p.gstin)) {
        updates.gstNumber = p.gstNumber || p.gstin
      }
      if (!customer.registeredAddress && p.registeredAddress) {
        updates.registeredAddress = p.registeredAddress
      }
      if (!customer.phone && (p.contacts?.primaryPhone || p.phone)) {
        updates.phone = p.contacts?.primaryPhone || p.phone
      }
      // Ensure contacts sub-doc has officialEmail
      if (!customer.contacts?.officialEmail && (p.officialEmail || onboarding.email)) {
        updates['contacts.officialEmail'] = p.officialEmail || onboarding.email
      }
      if (!customer.contacts?.primaryPhone && (p.contacts?.primaryPhone || p.phone)) {
        updates['contacts.primaryPhone'] = p.contacts?.primaryPhone || p.phone
      }

      if (Object.keys(updates).length === 0) {
        skipped++
        continue
      }

      await Customer.updateOne(
        { _id: customer._id },
        { $set: updates },
      )

      console.log(`  OK    ${customer.name} (${customer._id}): ${Object.keys(updates).join(', ')}`)
      updated++

    } catch (err) {
      console.error(`  FAIL  ${customer._id}:`, err)
      failed++
    }
  }

  console.log(`\nBackfill complete:`)
  console.log(`  Updated: ${updated}`)
  console.log(`  Skipped: ${skipped}`)
  console.log(`  Failed:  ${failed}`)

  await mongoose.disconnect()
}

backfill().catch(console.error)
