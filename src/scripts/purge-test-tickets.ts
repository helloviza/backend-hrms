import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";

async function main() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(env.MONGO_URI);
  console.log("Connected.\n");

  const db = mongoose.connection.db!;

  const ticketCount      = await db.collection("tickets").countDocuments();
  const messageCount     = await db.collection("ticketmessages").countDocuments();
  const attachmentCount  = await db.collection("ticketattachments").countDocuments();
  const leadCount        = await db.collection("ticketleads").countDocuments();

  console.log("Before delete:");
  console.log(`  tickets:           ${ticketCount}`);
  console.log(`  ticketmessages:    ${messageCount}`);
  console.log(`  ticketattachments: ${attachmentCount}`);
  console.log(`  ticketleads:       ${leadCount}`);
  console.log();

  if (ticketCount + messageCount + attachmentCount + leadCount === 0) {
    console.log("All collections already empty. Nothing to do.");
    await mongoose.connection.close();
    process.exit(0);
  }

  const r1 = await db.collection("ticketattachments").deleteMany({});
  const r2 = await db.collection("ticketmessages").deleteMany({});
  const r3 = await db.collection("ticketleads").deleteMany({});
  const r4 = await db.collection("tickets").deleteMany({});

  console.log("Deleted:");
  console.log(`  ticketattachments: ${r1.deletedCount}`);
  console.log(`  ticketmessages:    ${r2.deletedCount}`);
  console.log(`  ticketleads:       ${r3.deletedCount}`);
  console.log(`  tickets:           ${r4.deletedCount}`);
  console.log();

  const after = {
    tickets:           await db.collection("tickets").countDocuments(),
    ticketmessages:    await db.collection("ticketmessages").countDocuments(),
    ticketattachments: await db.collection("ticketattachments").countDocuments(),
    ticketleads:       await db.collection("ticketleads").countDocuments(),
  };

  console.log("After (all should be 0):");
  console.table(after);

  const allZero = Object.values(after).every((v) => v === 0);
  if (allZero) {
    console.log("All ticket collections cleared successfully.");
  } else {
    console.error("WARNING: Some documents remain!");
    process.exit(1);
  }

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
