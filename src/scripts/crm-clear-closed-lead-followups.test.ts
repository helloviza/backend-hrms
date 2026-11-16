// scripts/crm-clear-closed-lead-followups — targets only definitely-closed
// leads with a follow-up date, backs them up, clears the two fields and
// nothing else; legacy proposal / negotiation leads are counted, never
// written; a second run finds nothing. Real Mongo (memory server).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/clear-closed-followups-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Lead } = await import("../models/Lead.js");
const { planCleanup, applyCleanup } = await import("./crm-clear-closed-lead-followups.js");

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Lead.deleteMany({});
});

const due = new Date("2026-11-01T05:00:00Z");
let seq = 0;
async function lead(code: string, o: Record<string, any>) {
  seq += 1;
  await Lead.collection.insertOne({
    _id: new mongoose.Types.ObjectId(), leadCode: code, type: "company", companyName: `Co ${seq}`, contactName: `P ${seq}`, contactPhone: `96${String(seq).padStart(8, "0")}`,
    stage: "new", source: "manual", nextFollowUpDate: due, followUpNotes: "call", createdAt: due, updatedAt: due, ...o,
  } as any);
}

describe("crm-clear-closed-lead-followups", () => {
  it("dry-run plan → apply clears only closed leads, writes a backup, and is idempotent", async () => {
    await lead("WON", { stage: "won", status: "CONVERTED", dispositionStatus: "Won", subDisposition: "Onboarded" });
    await lead("LOST", { stage: "lost", status: "LOST", dispositionStatus: "Lost", subDisposition: "Repeated RNR" });
    await lead("LEGACY-WON", { stage: "won" });
    await lead("LEGACY-LOST-STATUS", { stage: "contacted", status: "LOST" });
    await lead("LEGACY-WONDATE", { stage: "contacted", status: "CONVERTED", wonDate: due }); // won without the stage → closed
    // legacy Proposal / Negotiation, status CONVERTED (absent or stored) — OPEN, counted, NEVER written,
    // even with a stray wonDate
    await lead("LEGACY-PROPOSAL", { stage: "proposal_sent" });
    await lead("LEGACY-NEG-CONVERTED", { stage: "negotiation", status: "CONVERTED" });
    await lead("LEGACY-NEG-WONDATE", { stage: "negotiation", status: "CONVERTED", wonDate: due });
    await lead("V2-PROPOSAL-OPEN", { stage: "proposal_sent", status: "CONVERTED", dispositionStatus: "Open" }); // open
    await lead("OPEN-NEW", { stage: "new" }); // open
    await lead("WON-NO-DATE", { stage: "won", dispositionStatus: "Won", nextFollowUpDate: null }); // nothing to clear

    const plan = await planCleanup();
    expect(plan.total).toBe(5);
    expect(plan.legacyLateUntouched).toBe(3);
    expect(plan.sample.map((s) => s.leadCode).sort()).toEqual(["LEGACY-LOST-STATUS", "LEGACY-WON", "LEGACY-WONDATE", "LOST", "WON"]);
    // the plan wrote nothing
    expect(await Lead.countDocuments({ nextFollowUpDate: { $ne: null } })).toBe(10);

    const backup = path.join(mkdtempSync(path.join(tmpdir(), "ccf-")), "backup.json");
    const r = await applyCleanup(backup);
    expect(r).toEqual({ backedUp: 5, modified: 5 });
    const saved = JSON.parse(readFileSync(backup, "utf8"));
    expect(saved.map((s: any) => s.leadCode).sort()).toEqual(["LEGACY-LOST-STATUS", "LEGACY-WON", "LEGACY-WONDATE", "LOST", "WON"]);
    expect(saved[0]).toMatchObject({ followUpNotes: "call", nextFollowUpDate: due.toISOString() });

    const after = await Lead.collection.find({}).toArray();
    const by = (c: string) => after.find((l: any) => l.leadCode === c)!;
    for (const c of ["WON", "LOST", "LEGACY-WON", "LEGACY-LOST-STATUS", "LEGACY-WONDATE"]) {
      expect("nextFollowUpDate" in by(c), c).toBe(false);
      expect(by(c).followUpNotes, c).toBe("");
    }
    for (const c of ["LEGACY-PROPOSAL", "LEGACY-NEG-CONVERTED", "LEGACY-NEG-WONDATE", "V2-PROPOSAL-OPEN", "OPEN-NEW"]) {
      expect(by(c).nextFollowUpDate, c).toEqual(due);
      expect(by(c).followUpNotes, c).toBe("call");
    }
    // nothing else on the row changed
    expect(by("LOST")).toMatchObject({ stage: "lost", status: "LOST", dispositionStatus: "Lost", subDisposition: "Repeated RNR" });

    expect((await planCleanup()).total).toBe(0);
  });
});
