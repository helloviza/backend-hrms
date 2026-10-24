// apps/backend/src/models/ApprovalRequest.partnerLead.test.ts
//
// meta.partnerLead is written once, at create, and never changes: a save that
// changes / removes / adds it is refused, and so is an update query naming it
// (or replacing `meta` wholesale on a request that has it). Requests without
// it — every existing one — save and update exactly as before. Raw-insert
// fixtures, so the "existing" request really has no meta.source / partnerLead.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import ApprovalRequest, { PartnerLeadImmutableError } from "./ApprovalRequest.js";
import { newPartnerLinkCode, PARTNER_LINK_CODE_RE } from "./PartnerLink.js";

let mongod: MongoMemoryServer;
const col = () => mongoose.connection.db!.collection("approvalrequests");
const oid = () => new mongoose.Types.ObjectId();
const P = oid();
const X = oid();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-partner-lead-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const base = { workspaceId: oid(), frontlinerId: "x", frontlinerEmail: "a@x.test", managerEmail: "m@x.test", status: "approved", adminState: "pending", stage: "REQUEST_APPROVED", history: [], cartItems: [] };
beforeEach(async () => {
  await col().deleteMany({});
  await col().insertMany([
    { _id: P, ...base, meta: { source: "PARTNER_LINK", partnerLead: { caseNumber: "PL-ABCDEF", contact: { name: "Riya", email: "riya@x.test", phone: "9876543210" } } } },
    { _id: X, ...base, meta: { ccLeaders: [] } },
  ]);
});

describe("meta.partnerLead is immutable", () => {
  it("other meta paths of a partner case still save", async () => {
    const doc: any = await ApprovalRequest.findById(P);
    doc.meta.manualBookingId = "abc";
    doc.adminState = "in_progress";
    doc.markModified("meta");
    await doc.save();
    const after: any = await col().findOne({ _id: P });
    expect(after.meta.manualBookingId).toBe("abc");
    expect(after.meta.partnerLead.contact.email).toBe("riya@x.test");
  });

  it("a save that changes or removes it is refused, and nothing is written", async () => {
    const doc: any = await ApprovalRequest.findById(P);
    doc.meta.partnerLead.contact.email = "other@x.test";
    doc.markModified("meta");
    await expect(doc.save()).rejects.toBeInstanceOf(PartnerLeadImmutableError);
    const gone: any = await ApprovalRequest.findById(P);
    delete gone.meta.partnerLead;
    gone.markModified("meta");
    await expect(gone.save()).rejects.toBeInstanceOf(PartnerLeadImmutableError);
    expect((await col().findOne({ _id: P }))!.meta.partnerLead.contact.email).toBe("riya@x.test");
  });

  it("an existing request can't be made a partner lead after the fact", async () => {
    const doc: any = await ApprovalRequest.findById(X);
    doc.meta.partnerLead = { caseNumber: "PL-ZZZZZZ" };
    doc.markModified("meta");
    await expect(doc.save()).rejects.toBeInstanceOf(PartnerLeadImmutableError);
  });

  it("update queries naming it are refused; a whole-meta write is refused only where it exists", async () => {
    await expect(ApprovalRequest.updateOne({ _id: P }, { $set: { "meta.partnerLead.contact.phone": "1" } })).rejects.toBeInstanceOf(PartnerLeadImmutableError);
    await expect(ApprovalRequest.updateMany({}, { $unset: { "meta.partnerLead": 1 } })).rejects.toBeInstanceOf(PartnerLeadImmutableError);
    await expect(ApprovalRequest.findOneAndUpdate({ _id: P }, { $set: { meta: {} } })).rejects.toBeInstanceOf(PartnerLeadImmutableError);
    // A request without it: both forms work as before.
    await ApprovalRequest.updateOne({ _id: X }, { $set: { "meta.revoked": true } });
    await ApprovalRequest.updateOne({ _id: X }, { $set: { meta: { ccLeaders: ["l@x.test"] } } });
    expect((await col().findOne({ _id: X }))!.meta).toEqual({ ccLeaders: ["l@x.test"] });
    // Ordinary meta paths on the partner case are fine.
    await ApprovalRequest.updateOne({ _id: P }, { $set: { "meta.assignmentFlag": { code: "NO_AGENT_AVAILABLE" } } });
    expect((await col().findOne({ _id: P }))!.meta.assignmentFlag.code).toBe("NO_AGENT_AVAILABLE");
  });

  it("a new request may be created with it", async () => {
    const created: any = await ApprovalRequest.create({ ...base, workspaceId: oid(), meta: { source: "PARTNER_LINK", partnerLead: { caseNumber: "PL-NEW234" } } });
    expect(created.meta.partnerLead.caseNumber).toBe("PL-NEW234");
  });
});

describe("partner link codes", () => {
  it("are 8 base62 characters and don't repeat", () => {
    const codes = Array.from({ length: 500 }, () => newPartnerLinkCode());
    for (const c of codes) expect(c).toMatch(PARTNER_LINK_CODE_RE);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
