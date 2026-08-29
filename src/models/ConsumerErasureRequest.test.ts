// The erasure request's state machine and its D6 pseudonymisation, against
// real collections — the partial unique index ("one live request per
// consumer, but a rejected one must not block a retry") is a database
// behaviour, and a mock would simply assert it into existence.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-erasure-request-test";
process.env.JWT_SECRET ||= "erasure-request-test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const {
  default: ConsumerErasureRequest,
  raiseConsumerErasureRequest,
  markUnderReview,
  markApproved,
  markRejected,
  markExecuted,
  assertTransitionAllowed,
  consumerPseudonym,
  ConsumerErasureAlreadyOpenError,
  ConsumerErasureTransitionError,
  CONSUMER_ERASURE_TRANSITIONS,
} = await import("./ConsumerErasureRequest.js");

let mongod: MongoMemoryServer;

const ACTOR = { userId: new mongoose.Types.ObjectId().toString(), email: "boss@plumtrips.com" };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // The partial unique index is the thing under test in two cases below;
  // syncIndexes makes sure it actually exists on this fresh database rather
  // than being an unenforced schema declaration.
  await ConsumerErasureRequest.syncIndexes();
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await ConsumerErasureRequest.deleteMany({});
});

async function raise(consumerId = new mongoose.Types.ObjectId(), email = "person@example.com") {
  return raiseConsumerErasureRequest({
    consumerId,
    subjectEmail: email,
    subjectName: "Rahul Sharma",
    origin: "consumer_account",
    requestedByConsumerId: consumerId,
    requestedByEmail: email,
    requestReason: "I no longer use this service",
  });
}

describe("the transition table", () => {
  it("allows only the documented moves", () => {
    expect(() => assertTransitionAllowed("requested", "under_review")).not.toThrow();
    expect(() => assertTransitionAllowed("under_review", "approved")).not.toThrow();
    expect(() => assertTransitionAllowed("approved", "executed")).not.toThrow();
    expect(() => assertTransitionAllowed("approved", "under_review")).not.toThrow();
    expect(() => assertTransitionAllowed("requested", "rejected")).not.toThrow();
  });

  it("refuses the shortcut that would skip review entirely", () => {
    expect(() => assertTransitionAllowed("requested", "approved")).toThrow(
      ConsumerErasureTransitionError,
    );
    expect(() => assertTransitionAllowed("requested", "executed")).toThrow(
      ConsumerErasureTransitionError,
    );
    expect(() => assertTransitionAllowed("under_review", "executed")).toThrow(
      ConsumerErasureTransitionError,
    );
  });

  it("makes executed and rejected terminal", () => {
    expect(CONSUMER_ERASURE_TRANSITIONS.executed).toEqual([]);
    expect(CONSUMER_ERASURE_TRANSITIONS.rejected).toEqual([]);
    for (const to of ["requested", "under_review", "approved", "rejected"] as const) {
      expect(() => assertTransitionAllowed("executed", to)).toThrow(ConsumerErasureTransitionError);
    }
  });
});

describe("raising a request", () => {
  it("starts in `requested`, holding the subject's details for the reviewer", async () => {
    const doc = await raise();
    expect(doc.state).toBe("requested");
    expect(doc.subjectEmail).toBe("person@example.com");
    expect(doc.subjectName).toBe("Rahul Sharma");
    expect(doc.subjectPseudonym).toMatch(/^hv:[0-9a-f]{32}$/);
    expect(doc.manifest).toBeNull();
    expect(doc.executedAt).toBeNull();
  });

  it("refuses a second LIVE request for the same consumer", async () => {
    const consumerId = new mongoose.Types.ObjectId();
    await raise(consumerId);
    await expect(raise(consumerId)).rejects.toBeInstanceOf(ConsumerErasureAlreadyOpenError);
  });

  it("allows a NEW request after the previous one was rejected", async () => {
    const consumerId = new mongoose.Types.ObjectId();
    const first = await raise(consumerId);
    await markRejected(first._id as any, ACTOR, "Identity could not be verified");

    const second = await raise(consumerId);
    expect(second.state).toBe("requested");
    expect(await ConsumerErasureRequest.countDocuments({ consumerId })).toBe(2);
  });
});

describe("the pseudonym", () => {
  it("is stable, case- and whitespace-insensitive", () => {
    expect(consumerPseudonym("Person@Example.com ")).toBe(consumerPseudonym("person@example.com"));
  });

  it("differs per address, and never contains the address", () => {
    const a = consumerPseudonym("a@example.com");
    const b = consumerPseudonym("b@example.com");
    expect(a).not.toBe(b);
    expect(a).not.toContain("example.com");
    expect(a).not.toContain("a@");
  });
});

describe("D6 — the audit record does not keep the erased PII", () => {
  it("markExecuted nulls the subject's email, name AND the review snapshot", async () => {
    const doc = await raise();
    await markUnderReview(doc._id as any, ACTOR, { retained: { invoices: [] } } as any, "looks fine");

    const mid = await ConsumerErasureRequest.findById(doc._id).lean();
    // Still populated while a human needs to read it.
    expect((mid as any).subjectEmail).toBe("person@example.com");
    expect((mid as any).reviewManifest).not.toBeNull();

    await markApproved(doc._id as any, ACTOR, "approved");
    const executed = await markExecuted(doc._id as any, ACTOR, {
      version: 1,
      consumerId: String(doc.consumerId),
      subjectPseudonym: doc.subjectPseudonym,
      dryRun: false,
      motions: { redact: [], delete: [], shred: [] },
      retained: { invoices: [{ invoiceNo: "INV-20260001", grandTotal: 4270 }] },
    } as any);

    expect(executed.state).toBe("executed");
    expect(executed.subjectEmail).toBeNull();
    expect(executed.subjectName).toBeNull();
    // The review snapshot named them too — it goes with the rest.
    expect(executed.reviewManifest).toBeNull();

    // What SURVIVES: the pseudonym, the dangling consumerId, and a manifest
    // of counts and invoice numbers.
    expect(executed.subjectPseudonym).toMatch(/^hv:/);
    expect(executed.consumerId).toBeTruthy();
    expect((executed.manifest as any).retained.invoices[0].invoiceNo).toBe("INV-20260001");

    expect(executed.requestedByEmail).toBeNull();
    expect(executed.requestReason).toBeNull();

    // The whole-row check, not a field-by-field one: this is what caught
    // requestedByEmail surviving the first version of the scrub.
    const serialised = JSON.stringify(await ConsumerErasureRequest.findById(doc._id).lean());
    expect(serialised).not.toContain("person@example.com");
    expect(serialised).not.toContain("Rahul Sharma");
  });

  it("markRejected also drops the address it arrived with", async () => {
    const doc = await raise();
    const rejected = await markRejected(doc._id as any, ACTOR, "Not the account holder");
    expect(rejected.state).toBe("rejected");
    expect(rejected.subjectEmail).toBeNull();
    expect(rejected.subjectName).toBeNull();
    // The refusal reason and the pseudonym stay — that is the audit.
    expect(rejected.decisionNote).toBe("Not the account holder");
    expect(rejected.subjectPseudonym).toMatch(/^hv:/);
    // ...and the subject-authored fields go with it, requestedByEmail
    // included — for a consumer-raised request that field IS their address.
    expect(rejected.requestedByEmail).toBeNull();
    expect(rejected.requestReason).toBeNull();
    const serialised = JSON.stringify(await ConsumerErasureRequest.findById(doc._id).lean());
    expect(serialised).not.toContain("person@example.com");
  });
});

describe("an ops-logged request keeps the AGENT's identity", () => {
  it("nulls the subject's details but not the agent who logged it", async () => {
    const consumerId = new mongoose.Types.ObjectId();
    const doc = await raiseConsumerErasureRequest({
      consumerId,
      subjectEmail: "subject@example.com",
      subjectName: "Rahul Sharma",
      origin: "ops_logged",
      requestedByUserId: ACTOR.userId,
      requestedByEmail: "agent@plumtrips.com",
      requestReason: "Phoned in on 2026-08-28",
    });

    await markUnderReview(doc._id as any, ACTOR, null);
    await markApproved(doc._id as any, ACTOR);
    const executed = await markExecuted(doc._id as any, ACTOR, { version: 1 } as any);

    expect(executed.subjectEmail).toBeNull();
    // The agent's address is the AUDIT, not the PII — it stays.
    expect(executed.requestedByEmail).toBe("agent@plumtrips.com");
  });
});

describe("the writers enforce the machine", () => {
  it("cannot execute a request that was never approved", async () => {
    const doc = await raise();
    await expect(markExecuted(doc._id as any, ACTOR, {} as any)).rejects.toBeInstanceOf(
      ConsumerErasureTransitionError,
    );
    expect((await ConsumerErasureRequest.findById(doc._id).lean())!.state).toBe("requested");
  });

  it("cannot execute the same request twice", async () => {
    const doc = await raise();
    await markUnderReview(doc._id as any, ACTOR, null);
    await markApproved(doc._id as any, ACTOR);
    await markExecuted(doc._id as any, ACTOR, { version: 1 } as any);

    await expect(markExecuted(doc._id as any, ACTOR, { version: 1 } as any)).rejects.toBeInstanceOf(
      ConsumerErasureTransitionError,
    );
  });

  it("lets an approver pull a request back out of `approved`", async () => {
    const doc = await raise();
    await markUnderReview(doc._id as any, ACTOR, null);
    await markApproved(doc._id as any, ACTOR);
    const back = await markUnderReview(doc._id as any, ACTOR, null, "second thoughts");
    expect(back.state).toBe("under_review");
  });

  it("records who did what at each step", async () => {
    const doc = await raise();
    await markUnderReview(doc._id as any, { userId: ACTOR.userId, email: "agent@plumtrips.com" }, null);
    await markApproved(doc._id as any, { userId: ACTOR.userId, email: "boss@plumtrips.com" });
    const final = await markExecuted(
      doc._id as any,
      { userId: ACTOR.userId, email: "boss@plumtrips.com" },
      { version: 1 } as any,
    );

    expect(final.reviewedByEmail).toBe("agent@plumtrips.com");
    expect(final.decidedByEmail).toBe("boss@plumtrips.com");
    expect(final.executedByEmail).toBe("boss@plumtrips.com");
    expect(final.reviewedAt).toBeTruthy();
    expect(final.decidedAt).toBeTruthy();
    expect(final.executedAt).toBeTruthy();
  });
});
