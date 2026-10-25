// apps/backend/src/scripts/report-duplicate-request-bookings.ts
//
// REPORT ONLY — writes nothing, ever.
//
// Requests with more than one live Book Now booking (ManualBooking source
// ADMIN_QUEUE, same sourceBookingId, not deleted), from before the server
// refused a second one without "additional". Each is flagged LIKELY
// ACCIDENTAL when two of its bookings are the same service (type, travel
// date, return date, route / hotel) created within 30 minutes of each other;
// otherwise it reads as a real multi-service case. What to do with each is a
// person's call.
//
//   npx tsx src/scripts/report-duplicate-request-bookings.ts --expect-db=<db>
import "dotenv/config";
import mongoose from "mongoose";

const SCRIPT = "report-duplicate-request-bookings";
const WINDOW_MIN = 30;
const str = (v: unknown) => String(v ?? "").trim();
const day = (v: unknown) => (v ? new Date(v as any).toISOString().slice(0, 10) : "");

export type DuplicateGroup = {
  requestId: string;
  caseCode: string;
  bookings: Array<{ id: string; ref: string; type: string; status: string; createdAt: string; travelDate: string; route: string }>;
  likelyAccidental: boolean;
  why: string;
};

/** The same service, for duplicate detection: type, dates, route / hotel. */
const serviceKey = (b: any) =>
  [str(b.type).toUpperCase(), day(b.travelDate), day(b.returnDate), str(b.itinerary?.origin), str(b.itinerary?.destination), str(b.itinerary?.hotelName)].join("|");

export async function reportDuplicateRequestBookings(opts: { expectDb?: string; log?: (line: string) => void }): Promise<{ db: string; requestsWithBookings: number; groups: DuplicateGroup[] }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  log(`db ${db} · REPORT ONLY (no writes)`);

  const mb = mongoose.connection.collection("manualbookings");
  const ar = mongoose.connection.collection("approvalrequests");
  const live = { source: "ADMIN_QUEUE", sourceBookingId: { $exists: true, $ne: null }, isActive: { $ne: false } };
  const requestsWithBookings = (await mb.distinct("sourceBookingId", live)).length;
  const multi = await mb
    .aggregate([{ $match: live }, { $group: { _id: "$sourceBookingId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $sort: { _id: 1 } }])
    .toArray();

  const groups: DuplicateGroup[] = [];
  for (const g of multi) {
    const rows = await mb
      .find({ ...live, sourceBookingId: g._id }, { projection: { bookingRef: 1, type: 1, status: 1, createdAt: 1, travelDate: 1, returnDate: 1, itinerary: 1 } })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    const req: any = mongoose.isValidObjectId(g._id) ? await ar.findOne({ _id: new mongoose.Types.ObjectId(String(g._id)) }, { projection: { ticketId: 1, "meta.partnerLead.caseNumber": 1 } }) : null;
    let why = "";
    for (let i = 0; i < rows.length && !why; i++) {
      for (let j = i + 1; j < rows.length && !why; j++) {
        const gap = Math.abs(+new Date(rows[j].createdAt) - +new Date(rows[i].createdAt)) / 60000;
        if (serviceKey(rows[i]) === serviceKey(rows[j]) && gap <= WINDOW_MIN) why = `${rows[i].bookingRef} and ${rows[j].bookingRef}: same service, created ${Math.round(gap)} min apart`;
      }
    }
    groups.push({
      requestId: String(g._id),
      caseCode: str(req?.meta?.partnerLead?.caseNumber || req?.ticketId) || `REQ-${String(g._id).slice(-6).toUpperCase()}`,
      bookings: rows.map((b: any) => ({
        id: String(b._id),
        ref: str(b.bookingRef),
        type: str(b.type),
        status: str(b.status),
        createdAt: b.createdAt ? new Date(b.createdAt).toISOString() : "",
        travelDate: day(b.travelDate),
        route: [str(b.itinerary?.origin), str(b.itinerary?.destination) || str(b.itinerary?.hotelName)].filter(Boolean).join(" → "),
      })),
      likelyAccidental: !!why,
      why: why || "different services — reads as a multi-service case",
    });
  }

  log(`requests with a Book Now booking: ${requestsWithBookings} · with more than one live booking: ${groups.length} · likely accidental: ${groups.filter((g) => g.likelyAccidental).length}`);
  for (const g of groups) {
    log(`${g.likelyAccidental ? "LIKELY ACCIDENTAL" : "multi-service    "} ${g.caseCode} (${g.requestId}) — ${g.why}`);
    for (const b of g.bookings) log(`    ${b.ref} ${b.type} ${b.status} created ${b.createdAt.slice(0, 16)} travel ${b.travelDate || "-"} ${b.route}`);
  }
  return { db, requestsWithBookings, groups };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
    await reportDuplicateRequestBookings({ expectDb });
  } finally {
    await mongoose.disconnect();
  }
}

// Run only when executed directly — importing it (the test) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith(`scripts/${SCRIPT}.ts`);

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
