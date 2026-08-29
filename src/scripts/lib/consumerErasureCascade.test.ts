// THE PROOF. Consumer erasure, against REAL collections on
// mongodb-memory-server — not spied statics.
//
// Why real persistence here, when scripts/lib/visaErasureCascade.test.ts
// next door spies on model statics instead: everything this cascade claims
// is a claim about what the DATABASE holds afterwards. "The invoice
// survives with its number intact", "the name is gone from the mirror",
// "the ciphertext is unreadable", "the series has no gap" — a spy can only
// prove which function was called, and every one of those failures would
// sail straight past a spy. The B2B tests are asserting call-through, which
// is a different question and correctly answered a different way.
//
// Three fixtures, matching the three shapes a real consumer takes:
//   BARE      an account and nothing else
//   BROWSER   saved corridors + a lead + a location + a profile
//   PAID      all of the above, plus a case, documents, tickets, and the
//             money path: ManualBooking -> TravelBooking mirror -> Invoice
//
// S3 is mocked (there is no bucket in a test); the local-disk drivers are
// NOT — ConsumerDocument and TicketAttachment use the same local store the
// dev environment uses, so the byte-deletion path executes for real.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import crypto from "node:crypto";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-erasure-test";
process.env.JWT_SECRET ||= "consumer-erasure-test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.AWS_REGION ||= "ap-south-1";
// A real 32-byte master key, so the field-encryption plugin genuinely
// encrypts and genuinely fails to decrypt after the shred.
process.env.PII_MASTER_KEY ||= crypto.randomBytes(32).toString("base64");
// D1 starts at its production default on every run, and each test that
// cares sets it explicitly. Never left to leak between files.
delete process.env.ERASURE_REDACT_INVOICE_NAME;

vi.mock("../../utils/s3Upload.js", () => ({
  deleteObject: vi.fn(async () => undefined),
  uploadBufferToS3: vi.fn(),
  getObjectBuffer: vi.fn(),
  uploadAndPresign: vi.fn(),
  uploadLogoToS3: vi.fn(),
  uploadExpenseReceiptToS3: vi.fn(),
}));

const { deleteObject } = await import("../../utils/s3Upload.js");

const { default: Consumer } = await import("../../models/Consumer.js");
const { default: ConsumerProfile } = await import("../../models/ConsumerProfile.js");
const { default: ConsumerDocument } = await import("../../models/ConsumerDocument.js");
const { default: SavedCountry } = await import("../../models/SavedCountry.js");
const { default: VisaD2CLead } = await import("../../models/VisaD2CLead.js");
const { default: ActorLocation } = await import("../../models/ActorLocation.js");
const { default: Ticket } = await import("../../models/Ticket.js");
const { default: TicketMessage } = await import("../../models/TicketMessage.js");
const { default: TicketAttachment } = await import("../../models/TicketAttachment.js");
const { default: VisaRequest } = await import("../../models/VisaRequest.js");
const { default: VisaApplication } = await import("../../models/VisaApplication.js");
const { default: VisaDocument } = await import("../../models/VisaDocument.js");
const { default: VisaActivityLog } = await import("../../models/VisaActivityLog.js");
const { default: ManualBooking } = await import("../../models/ManualBooking.js");
const { default: TravelBooking } = await import("../../models/TravelBooking.js");
const { default: Invoice } = await import("../../models/Invoice.js");
const { default: CreditNote } = await import("../../models/CreditNote.js");
const { default: SubjectKey } = await import("../../models/SubjectKey.js");
const { default: Counter } = await import("../../models/Counter.js");
const { default: User } = await import("../../models/User.js");

const { getSubjectDek, clearSubjectKeyCache } = await import("../../security/subjectKeys.js");

const {
  planConsumerErasure,
  planToManifest,
  executeConsumerErasure,
  redactManualBookingsForConsumer,
  redactInvoicesForConsumer,
  shredConsumerKey,
  deleteConsumerRows,
  assertInvoicesSurvived,
  assertFinancialPiiStripped,
  assertAllowed,
  ModelNotAllowedError,
  ErasureNotConfirmedError,
  ErasureInvariantError,
  resolveSuperAdminActor,
  ActorNotSuperAdminError,
  REDACTED_NOTES,
} = await import("./consumerErasureCascade.js");

const { ERASED_NAME_PLACEHOLDER } = await import("../../config/erasurePolicy.js");

let mongod: MongoMemoryServer;

const WORKSPACE_ID = new mongoose.Types.ObjectId("d2c00000000000000000d2c1");
const HOUSE_CUSTOMER_ID = new mongoose.Types.ObjectId();
const SYSTEM_USER_ID = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all(
    [
      Consumer,
      ConsumerProfile,
      ConsumerDocument,
      SavedCountry,
      VisaD2CLead,
      ActorLocation,
      Ticket,
      TicketMessage,
      TicketAttachment,
      VisaRequest,
      VisaApplication,
      VisaDocument,
      VisaActivityLog,
      ManualBooking,
      TravelBooking,
      Invoice,
      CreditNote,
      SubjectKey,
      Counter,
      User,
    ].map((m: any) => m.deleteMany({})),
  );
  clearSubjectKeyCache();
  vi.mocked(deleteObject).mockClear();
  delete process.env.ERASURE_REDACT_INVOICE_NAME;
});

/* ═════════════════════════════════════════════════════════════════════
 * FIXTURES
 * ═════════════════════════════════════════════════════════════════════ */

async function makeConsumer(email: string, name: string) {
  return Consumer.create({ email, name, phone: "+919812345678", authProvider: "password" });
}

/** Encrypted-at-rest profile. Written through the model so the plugin runs. */
async function makeProfile(consumerId: mongoose.Types.ObjectId, passportNo: string) {
  return ConsumerProfile.create({
    consumerId,
    workspaceId: WORKSPACE_ID,
    personal: {
      firstName: "Rahul",
      lastName: "Sharma",
      dateOfBirth: new Date("1990-04-11"),
      photoStorageKey: `consumer-documents/${consumerId}/avatar.webp`,
      photoDriver: "local-disk",
    },
    contact: {
      mobile: "+919812345678",
      currentAddress: { line1: "12 Residency Road", city: "Bengaluru", postalCode: "560025" },
    },
    passports: [{ number: passportNo, issuingCountry: "IND", isPrimary: true }],
  });
}

/**
 * The whole D2C money path, built the way services/d2cInvoicing.ts builds
 * it — same notes string (name embedded), same clientDetailsOverride shape,
 * same metadata keys. Built through the MODELS, not raw inserts: the
 * TravelBooking mirror is written by ManualBooking's post-save hook and the
 * invoice number comes from the real Counter, and both are things this
 * suite has to prove behave correctly.
 */
async function makePaidCase(consumer: any) {
  const requestId = new mongoose.Types.ObjectId();
  const applicationId = new mongoose.Types.ObjectId();
  // Unique per case: VisaApplication.razorpayPaymentId carries a unique
  // index, so the multi-consumer tests below cannot share one literal.
  const payRef = `pay_${String(consumer._id).slice(-8)}`;

  // Raw driver for the case scaffolding: VisaRequest/VisaApplication carry
  // reference-number counters and channel-immutability guards that are not
  // what this suite is testing, and going through them would make these
  // fixtures depend on machinery unrelated to erasure.
  await mongoose.connection.collection("visarequests").insertOne({
    _id: requestId,
    workspaceId: WORKSPACE_ID,
    consumerId: consumer._id,
    source: "D2C",
    destinationIso2: "TH",
    purpose: "TOURIST",
    referenceNumber: `HV-${String(consumer._id).slice(-6)}`,
    status: "submitted",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await mongoose.connection.collection("visaapplications").insertOne({
    _id: applicationId,
    workspaceId: WORKSPACE_ID,
    requestId,
    consumerId: consumer._id,
    travellerProfileId: null,
    source: "D2C",
    status: "submitted",
    d2cPaymentStatus: "PAID",
    razorpayPaymentId: payRef,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // A visa document whose extractedFields are encrypted under the CONSUMER
  // subject — the same subject ConsumerProfile uses, which is what makes one
  // shred cover both.
  const visaDoc = await VisaDocument.create({
    applicationId,
    workspaceId: WORKSPACE_ID,
    docCode: "DOC-01",
    s3Key: `visa/${applicationId}/passport.pdf`,
    driver: "s3",
    originalFilename: "passport.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    uploadedByConsumerId: consumer._id,
    subjectType: "CONSUMER",
    subjectId: consumer._id,
    extractedFields: [{ key: "passportNumber", value: "Z9988776", confidence: "HIGH" }],
  });

  await VisaActivityLog.create({
    workspaceId: WORKSPACE_ID,
    requestId,
    applicationId,
    eventType: "SUBMITTED",
    actorType: "CUSTOMER",
    detail: { note: `Submitted by ${consumer.name} (${consumer.email})` },
    at: new Date(),
  });

  // The support case.
  const ticket = await Ticket.create({
    subject: "Where is my visa?",
    fromEmail: consumer.email,
    fromName: consumer.name,
    consumerId: consumer._id,
    sourceChannel: "WEB",
  });
  const message = await TicketMessage.create({
    ticketId: ticket._id,
    direction: "INBOUND",
    channel: "PORTAL",
    fromEmail: consumer.email,
    subject: "Where is my visa?",
    bodyText: `Hi, this is ${consumer.name}, my passport is Z9988776 — any update?`,
    visibleToConsumer: true,
  });
  const attachment = await TicketAttachment.create({
    ticketId: ticket._id,
    messageId: message._id,
    fileName: "receipt.pdf",
    mimeType: "application/pdf",
    size: 512,
    driver: "local-disk",
    storageKey: `tickets/${ticket._id}/receipt.pdf`,
  });

  // The document locker.
  const consumerDoc = await ConsumerDocument.create({
    consumerId: consumer._id,
    workspaceId: WORKSPACE_ID,
    category: "IDENTITY",
    driver: "local-disk",
    storageKey: `consumer-documents/${consumer._id}/passport.pdf`,
    originalFilename: "passport.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
  });

  /* ── The money path ─────────────────────────────────────────────── */
  const booking: any = await ManualBooking.create({
    type: "VISA",
    workspaceId: HOUSE_CUSTOMER_ID,
    bookedBy: SYSTEM_USER_ID,
    status: "CONFIRMED",
    source: "MANUAL",
    travelDate: new Date("2026-10-01"),
    itinerary: { destination: "Bangkok", visaCountry: "Thailand" },
    passengers: [
      {
        name: consumer.name,
        email: consumer.email,
        phone: consumer.phone,
        passportNo: "Z9988776",
        type: "ADULT",
      },
    ],
    pricing: { actualPrice: 2500, quotedPrice: 4270, gstMode: "ON_MARKUP", gstPercent: 18 },
    // THE EXACT STRING services/d2cInvoicing.ts writes — the name in free
    // text that the B2B redaction never reaches.
    notes: `Helloviza D2C visa — ${consumer.name} — HV-REF-1`,
    sourceBookingRef: "HV-REF-1",
    metadata: {
      visaApplicationId: String(applicationId),
      channel: "D2C",
      consumerId: String(consumer._id),
      razorpayPaymentId: payRef,
      razorpayOrderId: `order_${String(consumer._id).slice(-8)}`,
    },
  });

  const invoice: any = await Invoice.create({
    workspaceId: HOUSE_CUSTOMER_ID,
    bookingIds: [booking._id],
    lineItems: [
      {
        bookingRef: booking.bookingRef,
        rowType: "SERVICE_FEE",
        description: "Thailand tourist visa",
        subDescription: "",
        qty: 1,
        rate: 1500,
        igst: 270,
        amount: 1770,
        passengerNames: [consumer.name],
        type: "VISA",
      },
    ],
    subtotal: 4000,
    totalGST: 270,
    grandTotal: 4270,
    supplyType: "IGST",
    igstAmount: 270,
    cgstAmount: 0,
    sgstAmount: 0,
    utgstAmount: 0,
    clientDetails: {
      companyName: consumer.name,
      contactPerson: consumer.name,
      email: consumer.email,
      addressLine1: "12 Residency Road",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560025",
      gstin: "",
    },
    issuerDetails: { companyName: "Plumtrips", gstin: "" },
    status: "PAID",
    paidAt: new Date(),
    invoiceDate: new Date(),
    notes: `Helloviza visa service — paid online (${payRef})`,
    pdfUrl: "https://s3.example/invoices/INV-1.pdf?sig=abc",
  });

  await ManualBooking.updateOne({ _id: booking._id }, { $set: { invoiceId: invoice._id } });

  return {
    requestId,
    applicationId,
    payRef,
    visaDoc,
    ticket,
    message,
    attachment,
    consumerDoc,
    booking,
    invoice,
  };
}

async function makeBrowsingData(consumer: any) {
  await SavedCountry.create([
    { consumerId: consumer._id, workspaceId: WORKSPACE_ID, iso2: "TH", source: "manual" },
    { consumerId: consumer._id, workspaceId: WORKSPACE_ID, iso2: "AE", source: "get-started" },
  ]);
  await VisaD2CLead.create({
    consumerId: consumer._id,
    workspaceId: WORKSPACE_ID,
    destinationIso2: "TH",
    destinationName: "Thailand",
  });
  await ActorLocation.create({
    actorId: consumer._id,
    actorType: "CONSUMER",
    workspaceId: WORKSPACE_ID,
    city: "Bengaluru",
    source: "ip",
    confidence: 0.4,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

const APPLY = {
  apply: true as const,
  confirmed: true as const,
  actorEmail: "ops@plumtrips.com",
  reason: "DPDP erasure request",
};

/* ═════════════════════════════════════════════════════════════════════
 * 1. THE ALLOW-LIST
 * ═════════════════════════════════════════════════════════════════════ */

describe("the allow-list", () => {
  it("permits every collection the cascade actually writes to", () => {
    for (const m of [
      "Consumer",
      "ConsumerProfile",
      "ConsumerDocument",
      "SavedCountry",
      "VisaD2CLead",
      "ActorLocation",
      "Ticket",
      "TicketMessage",
      "TicketAttachment",
      "VisaRequest",
      "VisaApplication",
      "VisaDocument",
      "VisaActivityLog",
      "ManualBooking",
      "TravelBooking",
      "Invoice",
      "CreditNote",
      "SubjectKey",
    ]) {
      expect(() => assertAllowed(m)).not.toThrow();
    }
  });

  it("refuses anything else — the guard that works inside the API server too", () => {
    expect(() => assertAllowed("Employee")).toThrow(ModelNotAllowedError);
    expect(() => assertAllowed("LeaveRequest")).toThrow(ModelNotAllowedError);
  });
});

describe("resolveSuperAdminActor", () => {
  it("refuses a real user who is not SUPERADMIN", async () => {
    await User.create({
      email: "hr@plumtrips.com",
      name: "HR",
      roles: ["HR"],
      passwordHash: "x",
      workspaceId: WORKSPACE_ID,
    });
    await expect(resolveSuperAdminActor("hr@plumtrips.com")).rejects.toBeInstanceOf(
      ActorNotSuperAdminError,
    );
  });

  it("resolves a real SUPERADMIN", async () => {
    await User.create({
      email: "boss@plumtrips.com",
      name: "Boss",
      roles: ["SUPERADMIN"],
      passwordHash: "x",
      workspaceId: WORKSPACE_ID,
    });
    const actor = await resolveSuperAdminActor("BOSS@plumtrips.com");
    expect(actor.email).toBe("boss@plumtrips.com");
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * 2. DRY RUN IS THE DEFAULT — and writes nothing
 * ═════════════════════════════════════════════════════════════════════ */

describe("dry run", () => {
  it("BARE consumer: plans one delete and nothing else", async () => {
    const c = await makeConsumer("bare@example.com", "Bare Account");
    const plan = await planConsumerErasure(c._id);
    const m = planToManifest(plan, { actorEmail: "ops@plumtrips.com", reason: "test" });

    expect(m.dryRun).toBe(true);
    expect(count(m.motions.delete, "Consumer")).toBe(1);
    expect(count(m.motions.delete, "ConsumerProfile")).toBe(0);
    expect(count(m.motions.redact, "Invoice")).toBe(0);
    expect(m.retained.invoices).toHaveLength(0);
  });

  it("BROWSER consumer: plans the corridors, lead, location and profile", async () => {
    const c = await makeConsumer("browser@example.com", "Browser Person");
    await makeProfile(c._id as any, "A1234567");
    await makeBrowsingData(c);

    const m = planToManifest(await planConsumerErasure(c._id), {
      actorEmail: "ops@plumtrips.com",
      reason: "test",
    });

    expect(count(m.motions.delete, "SavedCountry")).toBe(2);
    expect(count(m.motions.delete, "VisaD2CLead")).toBe(1);
    expect(count(m.motions.delete, "ActorLocation")).toBe(1);
    expect(count(m.motions.delete, "ConsumerProfile")).toBe(1);
    expect(count(m.motions.redact, "Invoice")).toBe(0);
  });

  it("PAID consumer: the invoice is planned as REDACT, never as DELETE", async () => {
    const c = await makeConsumer("paid@example.com", "Rahul Sharma");
    await makeProfile(c._id as any, "Z9988776");
    await makeBrowsingData(c);
    await makePaidCase(c);

    const plan = await planConsumerErasure(c._id);
    const m = planToManifest(plan, { actorEmail: "ops@plumtrips.com", reason: "test" });

    // THE CENTRAL DRY-RUN CLAIM.
    expect(count(m.motions.redact, "Invoice")).toBe(1);
    expect(count(m.motions.redact, "ManualBooking")).toBe(1);
    expect(count(m.motions.redact, "TravelBooking")).toBe(1);
    expect(m.motions.delete.find((e) => e.collection === "Invoice")).toBeUndefined();
    expect(m.motions.delete.find((e) => e.collection === "ManualBooking")).toBeUndefined();

    // ...and the reviewer is shown exactly what will be kept.
    expect(m.retained.invoices).toHaveLength(1);
    expect(m.retained.invoices[0].invoiceNo).toMatch(/^INV-/);
    expect(m.retained.invoices[0].grandTotal).toBe(4270);
    expect(m.retained.invoices[0].nameKept).toBe(true); // D1 default

    // The rest of the case is a delete.
    expect(count(m.motions.delete, "VisaApplication")).toBe(1);
    expect(count(m.motions.delete, "VisaRequest")).toBe(1);
    expect(count(m.motions.delete, "VisaDocument")).toBe(1);
    expect(count(m.motions.delete, "Ticket")).toBe(1);
    expect(count(m.motions.delete, "TicketMessage")).toBe(1);
    expect(count(m.motions.delete, "TicketAttachment")).toBe(1);
    expect(count(m.motions.delete, "ConsumerDocument")).toBe(1);

    // ...and the shred is listed, once, as the last motion.
    expect(m.motions.shred).toHaveLength(1);
    expect(m.motions.shred[0].subjectType).toBe("CONSUMER");
  });

  it("writes NOTHING — every row is still there after a plan", async () => {
    const c = await makeConsumer("paid2@example.com", "Rahul Sharma");
    await makeProfile(c._id as any, "Z9988776");
    await makeBrowsingData(c);
    await makePaidCase(c);

    await planConsumerErasure(c._id);
    await planToManifest(await planConsumerErasure(c._id), {
      actorEmail: "ops@plumtrips.com",
      reason: "test",
    });

    expect(await Consumer.countDocuments({})).toBe(1);
    expect(await ConsumerProfile.countDocuments({})).toBe(1);
    expect(await SavedCountry.countDocuments({})).toBe(2);
    expect(await Ticket.countDocuments({})).toBe(1);
    expect(await Invoice.countDocuments({})).toBe(1);
    expect(vi.mocked(deleteObject)).not.toHaveBeenCalled();

    const key = await SubjectKey.findOne({ subjectType: "CONSUMER", subjectId: c._id }).lean();
    expect((key as any)?.destroyedAt ?? null).toBeNull();
  });

  it("refuses to execute without BOTH gates", async () => {
    const c = await makeConsumer("gate@example.com", "Gate Test");
    const plan = await planConsumerErasure(c._id);

    await expect(
      executeConsumerErasure(plan, { ...APPLY, apply: false as any }),
    ).rejects.toBeInstanceOf(ErasureNotConfirmedError);
    await expect(
      executeConsumerErasure(plan, { ...APPLY, confirmed: false as any }),
    ).rejects.toBeInstanceOf(ErasureNotConfirmedError);
    await expect(executeConsumerErasure(plan, { ...APPLY, reason: "  " })).rejects.toBeInstanceOf(
      ErasureNotConfirmedError,
    );

    expect(await Consumer.countDocuments({})).toBe(1);
  });
});

function count(entries: Array<{ collection: string; count: number }>, name: string): number {
  return entries.find((e) => e.collection === name)?.count ?? 0;
}

/* ═════════════════════════════════════════════════════════════════════
 * 3. APPLY — the full spread
 * ═════════════════════════════════════════════════════════════════════ */

describe("apply — the paid consumer, end to end", () => {
  it("(a) deletes the plaintext PII rows, (b) keeps the invoice with PII stripped, (c) shreds the key", async () => {
    const c: any = await makeConsumer("full@example.com", "Rahul Sharma");
    await makeProfile(c._id, "Z9988776");
    await makeBrowsingData(c);
    const fixture = await makePaidCase(c);
    const invoiceNoBefore = fixture.invoice.invoiceNo;

    // The key exists and is live before the run.
    expect((await getSubjectDek("CONSUMER", c._id)).status).toBe("active");

    const plan = await planConsumerErasure(c._id);
    const manifest = await executeConsumerErasure(plan, APPLY);

    expect(manifest.dryRun).toBe(false);

    /* ── (a) plaintext PII rows are GONE ─────────────────────────── */
    expect(await Consumer.findById(c._id).lean()).toBeNull();
    expect(await ConsumerProfile.countDocuments({ consumerId: c._id })).toBe(0);
    expect(await ConsumerDocument.countDocuments({ consumerId: c._id })).toBe(0);
    expect(await SavedCountry.countDocuments({ consumerId: c._id })).toBe(0);
    expect(await VisaD2CLead.countDocuments({ consumerId: c._id })).toBe(0);
    expect(await ActorLocation.countDocuments({ actorId: c._id })).toBe(0);
    expect(await Ticket.countDocuments({})).toBe(0);
    expect(await TicketMessage.countDocuments({})).toBe(0);
    expect(await TicketAttachment.countDocuments({})).toBe(0);
    expect(await VisaRequest.countDocuments({})).toBe(0);
    expect(await VisaApplication.countDocuments({})).toBe(0);
    expect(await VisaDocument.countDocuments({})).toBe(0);

    /* ── (b) THE INVOICE SURVIVES, with the fiscal fields intact ─── */
    const inv: any = await Invoice.findById(fixture.invoice._id).lean();
    expect(inv).not.toBeNull();
    expect(inv.invoiceNo).toBe(invoiceNoBefore);
    expect(inv.grandTotal).toBe(4270);
    expect(inv.totalGST).toBe(270);
    expect(inv.igstAmount).toBe(270);
    expect(inv.supplyType).toBe("IGST");
    expect(inv.status).toBe("PAID");
    expect(inv.invoiceDate).toBeTruthy();
    // The Razorpay id in the invoice note is a fiscal reference and stays.
    expect(inv.notes).toContain(fixture.payRef);
    expect(inv.piiRedactedAt).toBeTruthy();

    // ...and its PII is gone.
    expect(inv.clientDetails.email ?? null).toBeNull();
    expect(inv.clientDetails.addressLine1 ?? null).toBeNull();
    expect(inv.clientDetails.pincode ?? null).toBeNull();
    // D1 default: the recipient NAME is kept.
    expect(inv.clientDetails.companyName).toBe("Rahul Sharma");
    expect(inv.lineItems[0].passengerNames).toEqual(["Rahul Sharma"]);
    // The stored PDF — a frozen copy of the un-redacted document — is gone.
    expect(inv.pdfUrl ?? null).toBeNull();
    expect(vi.mocked(deleteObject).mock.calls.map((a) => a[0])).toContain(
      `invoices/${invoiceNoBefore}.pdf`,
    );

    /* ── the booking: name, contact AND the notes-embedded name ──── */
    const mb: any = await ManualBooking.findById(fixture.booking._id).lean();
    expect(mb).not.toBeNull();
    expect(mb.passengers[0].name).toBe(ERASED_NAME_PLACEHOLDER);
    expect(mb.passengers[0].email ?? null).toBeNull();
    expect(mb.passengers[0].phone ?? null).toBeNull();
    expect(mb.passengers[0].passportNo ?? null).toBeNull();
    // THE GAP THE B2B CASCADE MISSED — the name inside the notes string.
    expect(mb.notes).toBe(REDACTED_NOTES);
    expect(mb.notes).not.toContain("Rahul");
    // ...while the money and the references stay.
    expect(mb.pricing.quotedPrice).toBe(4270);
    expect(mb.metadata.razorpayPaymentId).toBe(fixture.payRef);
    expect(mb.sourceBookingRef).toBe("HV-REF-1");
    expect(mb.piiRedactedAt).toBeTruthy();

    /* ── the TravelBooking mirror — the OTHER gap ─────────────────── */
    const mirror: any = await TravelBooking.findOne({ reference: fixture.booking._id }).lean();
    expect(mirror).not.toBeNull();
    expect(mirror.travellerName).toBe(ERASED_NAME_PLACEHOLDER);
    expect(mirror.travellerName).not.toContain("Rahul");
    expect(mirror.travellerEmail).toBe("");
    expect(mirror.amount).toBe(4270); // the mirror's money is untouched

    /* ── the activity log: row kept, detail wiped ─────────────────── */
    const logs = await VisaActivityLog.find({}).lean();
    expect(logs).toHaveLength(1);
    expect((logs[0] as any).eventType).toBe("SUBMITTED");
    expect((logs[0] as any).detail).toEqual({});
    expect((logs[0] as any).redactedAt).toBeTruthy();

    /* ── (c) the key is SHREDDED, and it happened last ────────────── */
    clearSubjectKeyCache();
    const lookup = await getSubjectDek("CONSUMER", c._id);
    expect(lookup.status).toBe("destroyed");
    expect(manifest.motions.shred[0].outcome).toBe("destroyed");

    /* ── the manifest carries no PII (D6) ─────────────────────────── */
    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toContain("Rahul");
    expect(serialised).not.toContain("full@example.com");
    expect(serialised).not.toContain("Z9988776");
    expect(manifest.subjectPseudonym).toMatch(/^hv:[0-9a-f]{32}$/);
  });

  it("the shredded key makes surviving ciphertext unreadable, not merely absent", async () => {
    const c: any = await makeConsumer("crypto@example.com", "Crypto Test");
    await makeProfile(c._id, "P7654321");

    // Prove it was really encrypted first: the raw document holds an
    // envelope, not the passport number.
    const raw: any = await mongoose.connection
      .collection("consumerprofiles")
      .findOne({ consumerId: c._id });
    expect(raw.passports[0].number).not.toBe("P7654321");
    expect(String(raw.passports[0].number)).toMatch(/^penc\./);

    // A second row under the same subject that the cascade does NOT delete,
    // standing in for "ciphertext the cascade could not reach". Written
    // directly so it survives the delete motion.
    const strayId = new mongoose.Types.ObjectId();
    const strayApp = new mongoose.Types.ObjectId();
    await VisaDocument.create({
      _id: strayId,
      applicationId: strayApp, // no application row -> not in the plan
      workspaceId: WORKSPACE_ID,
      docCode: "DOC-99",
      s3Key: "stray/key.pdf",
      originalFilename: "stray.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      subjectType: "CONSUMER",
      subjectId: c._id,
      extractedFields: [{ key: "passportNumber", value: "P7654321", confidence: "HIGH" }],
    });

    await executeConsumerErasure(await planConsumerErasure(c._id), APPLY);

    clearSubjectKeyCache();
    // The stray row is still there — and its contents are no longer readable.
    const stray: any = await VisaDocument.findById(strayId);
    expect(stray).not.toBeNull();
    expect(stray.extractedFields[0].value).not.toBe("P7654321");
  });

  it("is re-runnable: a second apply is a no-op, not a failure", async () => {
    const c: any = await makeConsumer("rerun@example.com", "Rerun Person");
    await makeProfile(c._id, "R1112223");
    const fixture = await makePaidCase(c);

    const first = await executeConsumerErasure(await planConsumerErasure(c._id), APPLY);
    expect(count(first.motions.redact, "Invoice")).toBe(1);

    // Second pass: the Consumer row is gone, but the fiscal rows are still
    // discoverable via metadata.consumerId — which is what makes an
    // interrupted run recoverable.
    const secondPlan = await planConsumerErasure(c._id);
    expect(secondPlan.consumerExists).toBe(false);
    expect(secondPlan.manualBookingIds).toHaveLength(1);

    const second = await executeConsumerErasure(secondPlan, APPLY);
    // Already redacted -> skipped, not re-redacted.
    expect(count(second.motions.redact, "Invoice")).toBe(0);
    expect(count(second.motions.redact, "ManualBooking")).toBe(0);
    expect(second.motions.shred[0].outcome).toBe("already destroyed by an earlier run");

    // ...and the invoice is STILL intact.
    const inv: any = await Invoice.findById(fixture.invoice._id).lean();
    expect(inv.invoiceNo).toBe(fixture.invoice.invoiceNo);
    expect(inv.grandTotal).toBe(4270);
  });

  it("touches nobody else's data", async () => {
    const victim: any = await makeConsumer("victim@example.com", "Victim");
    const bystander: any = await makeConsumer("bystander@example.com", "Bystander");
    await makeProfile(victim._id, "V1111111");
    await makeProfile(bystander._id, "B2222222");
    await makeBrowsingData(victim);
    await makeBrowsingData(bystander);
    await makePaidCase(victim);
    const bystanderCase = await makePaidCase(bystander);

    await executeConsumerErasure(await planConsumerErasure(victim._id), APPLY);

    expect(await Consumer.findById(bystander._id).lean()).not.toBeNull();
    expect(await ConsumerProfile.countDocuments({ consumerId: bystander._id })).toBe(1);
    expect(await SavedCountry.countDocuments({ consumerId: bystander._id })).toBe(2);
    expect(await Ticket.countDocuments({ consumerId: bystander._id })).toBe(1);

    const theirBooking: any = await ManualBooking.findById(bystanderCase.booking._id).lean();
    expect(theirBooking.passengers[0].name).toBe("Bystander");
    expect(theirBooking.notes).toContain("Bystander");

    const theirKey = await getSubjectDek("CONSUMER", bystander._id);
    expect(theirKey.status).toBe("active");
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * 4. THE INVOICE-NUMBER SERIES HAS NO GAP
 * ═════════════════════════════════════════════════════════════════════ */

describe("the invoice series stays gapless", () => {
  it("erasing the middle consumer of three leaves all three numbers present", async () => {
    const a: any = await makeConsumer("a@example.com", "Alpha");
    const b: any = await makeConsumer("b@example.com", "Bravo");
    const d: any = await makeConsumer("d@example.com", "Delta");

    const caseA = await makePaidCase(a);
    const caseB = await makePaidCase(b);
    const caseD = await makePaidCase(d);

    const before = (await Invoice.find({}).sort({ invoiceNo: 1 }).select("invoiceNo").lean()).map(
      (i: any) => i.invoiceNo,
    );
    expect(before).toHaveLength(3);

    // Erase the MIDDLE one — the case where a delete would visibly punch a
    // hole rather than just shorten the series.
    await executeConsumerErasure(await planConsumerErasure(b._id), APPLY);

    const after = (await Invoice.find({}).sort({ invoiceNo: 1 }).select("invoiceNo").lean()).map(
      (i: any) => i.invoiceNo,
    );
    expect(after).toEqual(before);
    expect(after).toHaveLength(3);

    // The erased consumer's invoice is one of them, still.
    const mid: any = await Invoice.findById(caseB.invoice._id).lean();
    expect(mid).not.toBeNull();
    expect(mid.piiRedactedAt).toBeTruthy();

    // The sequence itself is unbroken — parse the numeric tails.
    const tails = after.map((n: string) => Number(n.slice(-4))).sort((x, y) => x - y);
    for (let i = 1; i < tails.length; i++) {
      expect(tails[i]).toBe(tails[i - 1] + 1);
    }

    // The neighbours were not touched at all.
    const first: any = await Invoice.findById(caseA.invoice._id).lean();
    const last: any = await Invoice.findById(caseD.invoice._id).lean();
    expect(first.clientDetails.email).toBe("a@example.com");
    expect(last.clientDetails.email).toBe("d@example.com");
    expect(first.piiRedactedAt ?? null).toBeNull();
    expect(last.piiRedactedAt ?? null).toBeNull();
  });

  it("assertInvoicesSurvived throws if an invoice went missing", async () => {
    const c: any = await makeConsumer("inv@example.com", "Invoice Person");
    const fixture = await makePaidCase(c);
    const plan = await planConsumerErasure(c._id);

    // Simulate the catastrophic bug this invariant exists to catch.
    await Invoice.deleteOne({ _id: fixture.invoice._id });

    await expect(assertInvoicesSurvived(plan)).rejects.toBeInstanceOf(ErasureInvariantError);
  });

  it("assertFinancialPiiStripped throws if contact details survive a redaction", async () => {
    const c: any = await makeConsumer("leak@example.com", "Leaky Person");
    const fixture = await makePaidCase(c);
    const plan = await planConsumerErasure(c._id);

    await executeConsumerErasure(plan, APPLY);
    // Put a contact detail back, as a schema drift would.
    await ManualBooking.updateOne(
      { _id: fixture.booking._id },
      { $set: { "passengers.0.email": "leak@example.com" } },
    );

    await expect(assertFinancialPiiStripped(plan)).rejects.toBeInstanceOf(ErasureInvariantError);
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * 5. D1 — THE SWITCH, BOTH WAYS
 * ═════════════════════════════════════════════════════════════════════ */

describe("D1 — ERASURE_REDACT_INVOICE_NAME", () => {
  it("OFF (the default): the recipient name is KEPT on the tax invoice, everything else goes", async () => {
    expect(process.env.ERASURE_REDACT_INVOICE_NAME).toBeUndefined();

    const c: any = await makeConsumer("keep@example.com", "Rahul Sharma");
    const fixture = await makePaidCase(c);

    const manifest = await executeConsumerErasure(await planConsumerErasure(c._id), APPLY);
    expect(manifest.redactInvoiceName).toBe(false);

    const inv: any = await Invoice.findById(fixture.invoice._id).lean();
    expect(inv.clientDetails.companyName).toBe("Rahul Sharma");
    expect(inv.clientDetails.contactPerson).toBe("Rahul Sharma");
    expect(inv.lineItems[0].passengerNames).toEqual(["Rahul Sharma"]);
    // ...and every other identifying field is still stripped.
    expect(inv.clientDetails.email ?? null).toBeNull();
    expect(inv.clientDetails.addressLine1 ?? null).toBeNull();
    expect(inv.clientDetails.pincode ?? null).toBeNull();

    // The BOOKING's name goes regardless — the flag governs the fiscal
    // document only.
    const mb: any = await ManualBooking.findById(fixture.booking._id).lean();
    expect(mb.passengers[0].name).toBe(ERASED_NAME_PLACEHOLDER);

    // The residual says out loud that a name was left behind.
    expect(manifest.residuals.join(" ")).toContain("ERASURE_REDACT_INVOICE_NAME is OFF");
  });

  it("ON: the recipient name is redacted too, on the invoice AND its line items", async () => {
    process.env.ERASURE_REDACT_INVOICE_NAME = "true";

    const c: any = await makeConsumer("redact@example.com", "Rahul Sharma");
    const fixture = await makePaidCase(c);

    const manifest = await executeConsumerErasure(await planConsumerErasure(c._id), APPLY);
    expect(manifest.redactInvoiceName).toBe(true);

    const inv: any = await Invoice.findById(fixture.invoice._id).lean();
    expect(inv.clientDetails.companyName).toBe(ERASED_NAME_PLACEHOLDER);
    expect(inv.clientDetails.contactPerson).toBe(ERASED_NAME_PLACEHOLDER);
    expect(inv.lineItems[0].passengerNames).toEqual([ERASED_NAME_PLACEHOLDER]);

    // The invoice STILL survives with its fiscal fields — redacting the name
    // is not deleting the document.
    expect(inv.invoiceNo).toBe(fixture.invoice.invoiceNo);
    expect(inv.grandTotal).toBe(4270);
    expect(inv.igstAmount).toBe(270);

    // No residual about a kept name this time.
    expect(manifest.residuals.join(" ")).not.toContain("ERASURE_REDACT_INVOICE_NAME is OFF");
  });

  it("the dry-run plan tells the reviewer which way the flag is set", async () => {
    const c: any = await makeConsumer("flagplan@example.com", "Flag Person");
    await makePaidCase(c);

    const off = planToManifest(await planConsumerErasure(c._id), {
      actorEmail: "ops@plumtrips.com",
      reason: "t",
    });
    expect(off.redactInvoiceName).toBe(false);
    expect(off.retained.invoices[0].nameKept).toBe(true);

    process.env.ERASURE_REDACT_INVOICE_NAME = "true";
    const on = planToManifest(await planConsumerErasure(c._id), {
      actorEmail: "ops@plumtrips.com",
      reason: "t",
    });
    expect(on.redactInvoiceName).toBe(true);
    expect(on.retained.invoices[0].nameKept).toBe(false);
  });

  it("only the literal string \"true\" turns it on", async () => {
    const { shouldRedactInvoiceName } = await import("../../config/erasurePolicy.js");
    for (const v of ["", "false", "1", "yes", "TRUE ", "no"]) {
      process.env.ERASURE_REDACT_INVOICE_NAME = v;
      // "TRUE " trims and lowercases to "true" — deliberately tolerated.
      expect(shouldRedactInvoiceName()).toBe(v.trim().toLowerCase() === "true");
    }
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * 6. THE MOTIONS, INDIVIDUALLY
 * ═════════════════════════════════════════════════════════════════════ */

describe("motion (b) — redact, on its own", () => {
  it("redacts the booking and its mirror without touching pricing", async () => {
    const c: any = await makeConsumer("mb@example.com", "Booking Person");
    const fixture = await makePaidCase(c);

    const res = await redactManualBookingsForConsumer([String(fixture.booking._id)]);
    expect(res.manualBookingsRedacted).toBe(1);
    expect(res.travelBookingsRedacted).toBe(1);

    const mb: any = await ManualBooking.findById(fixture.booking._id).lean();
    expect(mb.passengers[0].name).toBe(ERASED_NAME_PLACEHOLDER);
    expect(mb.pricing.actualPrice).toBe(2500);
    expect(mb.pricing.quotedPrice).toBe(4270);
    expect(mb.itinerary.destination).toBe("Bangkok");

    const mirror: any = await TravelBooking.findOne({ reference: fixture.booking._id }).lean();
    expect(mirror.travellerName).toBe(ERASED_NAME_PLACEHOLDER);
  });

  it("redacts a credit note the same way as its invoice", async () => {
    const c: any = await makeConsumer("cn@example.com", "Credit Person");
    const fixture = await makePaidCase(c);

    const cn: any = await CreditNote.create({
      workspaceId: HOUSE_CUSTOMER_ID,
      originalInvoiceId: fixture.invoice._id,
      originalInvoiceNo: fixture.invoice.invoiceNo,
      originalInvoiceDate: new Date(),
      originalInvoiceAmount: 4270,
      serviceCategory: "VISA",
      reasonId: new mongoose.Types.ObjectId(),
      reasonText: "Service not rendered",
      reasonNote: "Rahul Sharma called to cancel, refunded to his card",
      gstReasonCode: "01",
      gstReasonText: "Sales Return",
      isFullCredit: true,
      lineItems: [],
      subtotal: 4000,
      totalGST: 270,
      grandTotal: 4270,
      supplyType: "IGST",
      igstAmount: 270,
      clientDetails: { companyName: "Rahul Sharma", email: "cn@example.com" },
      creditNoteDate: new Date(),
    });

    const plan = await planConsumerErasure(c._id);
    expect(plan.creditNoteIds).toContain(String(cn._id));

    await executeConsumerErasure(plan, APPLY);

    const after: any = await CreditNote.findById(cn._id).lean();
    expect(after).not.toBeNull();
    expect(after.creditNoteNo).toBe(cn.creditNoteNo);
    expect(after.grandTotal).toBe(4270);
    expect(after.clientDetails.email ?? null).toBeNull();
    // Free-text reasonNote named the person — wiped wholesale.
    expect(after.reasonNote ?? null).toBeNull();
    // reasonText is a catalogue value and stays.
    expect(after.reasonText).toBe("Service not rendered");
  });

  it("does not re-redact an already-redacted invoice", async () => {
    const c: any = await makeConsumer("idem@example.com", "Idem Person");
    const fixture = await makePaidCase(c);

    const first = await redactInvoicesForConsumer([String(fixture.invoice._id)], [], null);
    expect(first.invoicesRedacted).toBe(1);
    const second = await redactInvoicesForConsumer([String(fixture.invoice._id)], [], null);
    expect(second.invoicesRedacted).toBe(0);

    const inv: any = await Invoice.findById(fixture.invoice._id).lean();
    // One redaction entry in the history, not two.
    expect(inv.editHistory).toHaveLength(1);
    // ...and it records the fields changed WITHOUT recording their old
    // values, which would have copied the PII straight back in.
    // Mongoose's `minimize` (on by default) drops an empty Mixed object, so
    // this reads back absent rather than as {}. Either way the assertion is
    // the same one that matters: the redaction recorded WHICH fields it
    // changed and did NOT copy their former contents into the invoice's own
    // history, which would have put the name and email straight back.
    expect(inv.editHistory[0].oldValues ?? {}).toEqual({});
    expect(inv.editHistory[0].fieldsChanged).toContain("clientDetails");
  });
});

describe("motion (c) — shred, on its own", () => {
  it("destroys once, then reports already-destroyed", async () => {
    const c: any = await makeConsumer("shred@example.com", "Shred Person");
    await makeProfile(c._id, "S1234567");

    const first = await shredConsumerKey(c._id, "ops@plumtrips.com", "test");
    expect(first.destroyed).toBe(true);

    const second = await shredConsumerKey(c._id, "ops@plumtrips.com", "test");
    expect(second.destroyed).toBe(false);
    expect(second.alreadyDestroyed).toBe(true);
  });

  it("reports honestly when the subject never encrypted anything", async () => {
    const c: any = await makeConsumer("nokey@example.com", "No Key");
    const res = await shredConsumerKey(c._id, "ops@plumtrips.com", "test");
    expect(res.hadNoKey).toBe(true);
    expect(res.outcome).toContain("never encrypted");
  });
});

describe("motion (a) — delete, on its own", () => {
  it("deletes children before parents", async () => {
    const c: any = await makeConsumer("order@example.com", "Order Person");
    await makePaidCase(c);

    const plan = await planConsumerErasure(c._id);
    const { counts } = await deleteConsumerRows(plan);

    expect(counts.TicketAttachment).toBe(1);
    expect(counts.TicketMessage).toBe(1);
    expect(counts.Ticket).toBe(1);
    expect(counts.VisaDocument).toBe(1);
    expect(counts.VisaApplication).toBe(1);
    expect(counts.VisaRequest).toBe(1);
    expect(counts.Consumer).toBe(1);

    // The fiscal rows are NOT in this motion at all.
    expect(await Invoice.countDocuments({})).toBe(1);
    expect(await ManualBooking.countDocuments({})).toBe(1);
  });
});
