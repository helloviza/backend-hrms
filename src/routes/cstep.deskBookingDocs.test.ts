// apps/backend/src/routes/cstep.deskBookingDocs.test.ts
//
// P1 — the Travel Desk attaches the booking document(s) to the service it
// arranged; they flow, by reference, to the traveller's booked report leg,
// the settlement line and the travel packet. On a booked (linked) leg the
// traveller adds only travel proof: a flight's boarding pass (required, or
// "Boarding pass not available" ticked — declared), a train / bus ticket
// (optional), nothing for a hotel. A booked leg is locked to its booking.
// Self-paid legs, and legacy booked legs with no arrangementId, keep the
// attach-a-bill-or-tick-no-bill rule.
//
// Real: cstep router, models, in-memory Mongo REPLICA SET on a fresh
//   database, cstep_qc_desk_booking_docs; the Declaration renderer.
// Stubbed: S3, mail, the presigner, the event/packet uploaders, auth
//   (x-test-user) and the workspace resolver. The packet ASSEMBLY is
//   exercised for real at the end (vi.importActual).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { PDFDocument as PdfLibDocument } from "pdf-lib";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_desk_booking_docs";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

const rendered = vi.hoisted(() => [] as Array<{ items: any[] }>);
const packetCalls = vi.hoisted(() => [] as any[][]);
const onePagePdf = vi.hoisted(() => ({ bytes: Buffer.from("") }));
let uploadSeq = 0;
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async (args: any) => ({ key: `${args.keyPrefix}/qc-${++uploadSeq}` })),
  getObjectBuffer: vi.fn(async () => onePagePdf.bytes),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async (a: any) => `http://qc/presigned/${a.key}`) }));
vi.mock("../utils/cstepEventRequestPdf.js", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })),
}));
vi.mock("../utils/cstepPacketPdf.js", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  uploadCstepPacketPdf: vi.fn(async (...args: any[]) => {
    packetCalls.push(args);
    return { key: "qc-packet" };
  }),
}));
vi.mock("../utils/cstepClaimPdf.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    uploadCstepClaimDeclarationPdf: vi.fn(async (request: any, claimant: any, items: any[], trail: any[]) => {
      rendered.push({ items });
      return real.uploadCstepClaimDeclarationPdf(request, claimant, items, trail);
    }),
  };
});

const { default: cstepRouter } = await import("./cstep.js");

const DB = "cstep_qc_desk_booking_docs";
const oid = () => new mongoose.Types.ObjectId();
const id$ = (s: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), manager: oid(), official: oid(), finance: oid(), stranger: oid() };
const TP = oid();

const app = express();
app.use(express.json());
app.use(
  "/api/cstep",
  (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.workspaceObjectId = WS;
    next();
  },
  cstepRouter,
);
const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({ _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS) });
const ACT = {
  traveller: who(U.traveller),
  manager: who(U.manager),
  official: who(U.official),
  finance: who(U.finance),
  stranger: who(U.stranger),
};
const send = (m: "get" | "post" | "patch" | "delete", as: any, path: string, body?: any) => {
  const r = request(app)[m](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  return m === "get" || m === "delete" ? r : r.send(path === "/requests" ? { projectId: String(QC_PROJECT), ...body } : body || {});
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body?: any) => send("post", as, path, body);
const patch = (as: any, path: string, body?: any) => send("patch", as, path, body);
const del = (as: any, path: string) => send("delete", as, path);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const file = (as: any, path: string, name: string) =>
  request(app)
    .post(`/api/cstep${path}`)
    .set("x-test-user", JSON.stringify(as))
    .attach("file", Buffer.from(`%PDF-1.4 ${name}`), { filename: name, contentType: "application/pdf" });
const deskDoc = (id: string, lineId: string, name: string, as: any = ACT.official) => file(as, `/requests/${id}/arrangements/${lineId}/attachment`, name);
const proof = (id: string, legId: string, name: string) => file(ACT.traveller, `/requests/${id}/report/legs/${legId}/travel-proof`, name);
const billDoc = (id: string, legId: string) => file(ACT.traveller, `/requests/${id}/report/legs/${legId}/attachment`, "bill.pdf");
const names = (docs: any[] | undefined) => (docs || []).map((d) => d.originalName);

const TOUR = {
  type: "DOMESTIC",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
};
const FLIGHT_FARE = 9400;

type Booked = { id: string; flight: string; hotel: string; train: string; cab: string };

/** A Tour with four booked services — Flight (seeded), Hotel, Train, Cab
 * (added) — arranged; the Desk attaches documents to the flight (two) and
 * the hotel (one) while arranging, none to the train or cab. */
async function arrangedTour(purpose: string): Promise<Booked> {
  const id = String(ok(await post(ACT.traveller, "/requests", { ...TOUR, purpose })).body.request._id);
  ok(await post(ACT.manager, `/requests/${id}/approve`));
  const [flight] = ok(await post(ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
  ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { details: "6E-511 BLR-DEL", amount: FLIGHT_FARE, currency: "INR", status: "ARRANGED" }));
  const add = async (arrangedType: string, details: string, amount: number) =>
    String(ok(await post(ACT.official, `/requests/${id}/arrangements`, { arrangedType, details, amount, currency: "INR" })).body.line._id);
  const hotel = await add("HOTEL", "Taj Delhi 2N", 12000);
  const train = await add("TRAIN", "12002 Shatabdi", 1500);
  const cab = await add("CAB", "Airport drop", 800);
  ok(await deskDoc(id, String(flight._id), "eticket-onward.pdf"));
  ok(await deskDoc(id, String(flight._id), "eticket-return.pdf"));
  ok(await deskDoc(id, hotel, "hotel-folio.pdf"));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  return { id, flight: String(flight._id), hotel, train, cab };
}

async function startReport(b: Booked) {
  const legs: any[] = ok(await post(ACT.traveller, `/requests/${b.id}/report/start`)).body.legs;
  const legOf = (arrangementId: string) => String(legs.find((l) => String(l.arrangementId) === arrangementId)._id);
  return { flightLeg: legOf(b.flight), hotelLeg: legOf(b.hotel), trainLeg: legOf(b.train), cabLeg: legOf(b.cab) };
}
const reportLegs = async (id: string) => ok(await get(ACT.traveller, `/requests/${id}/report`)).body.legs as any[];

let replSet: MongoMemoryReplSet;
beforeAll(async () => {
  const one = await PdfLibDocument.create();
  one.addPage([200, 200]);
  onePagePdf.bytes = Buffer.from(await one.save());

  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  if ((await mongoose.connection.db!.listCollections().toArray()).length) throw new Error(`Step 0: ${DB} is not empty`);
  await mongoose.connection.syncIndexes();
  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, firstName: k, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertOne({
    _id: TP, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
    email: `${U.traveller}@qc.local`, claimedBy: U.traveller, tourApproverId: U.manager, officialUserId: U.official, financeUserId: U.finance,
  } as any);
}, 180_000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("the Travel Desk attaches booking documents to an arranged service", () => {
  let b: Booked;

  it("several per line, typed by the arranged service, logged, and shown on the request", async () => {
    b = await arrangedTour("QC desk docs");
    const flight: any = await col("csteparrangements").findOne({ _id: id$(b.flight) });
    expect(flight.attachmentIds).toHaveLength(2);
    const types = await col("cstepattachments").find({ _id: { $in: flight.attachmentIds } }).toArray();
    expect(types.map((a: any) => a.documentType)).toEqual(["ETICKET", "ETICKET"]);
    const hotelAtt: any = await col("cstepattachments").findOne({ originalName: "hotel-folio.pdf", travelRequestId: id$(b.id) });
    expect(hotelAtt.documentType).toBe("HOTEL_FOLIO");

    const g = ok(await get(ACT.official, `/requests/${b.id}`)).body;
    expect(g.canAttachBookingDocs).toBe(true);
    const byId = (x: string) => g.arrangements.find((a: any) => a._id === x);
    expect(names(byId(b.flight).attachments)).toEqual(["eticket-onward.pdf", "eticket-return.pdf"]);
    expect(byId(b.flight).attachments[0].url).toMatch(/^http:\/\/qc\/presigned\/cstep\/arrangements\//);
    expect(names(byId(b.train).attachments)).toEqual([]);
    const log = await col("cstepapprovals").find({ entityId: id$(b.id), action: "ARRANGE_SERVICE", comment: /Booking document attached/ }).toArray();
    expect(log).toHaveLength(3);
  });

  it("only this traveller's Travel Desk (or an Admin) may attach or remove one", async () => {
    expect((await deskDoc(b.id, b.train, "x.pdf", ACT.traveller)).status).toBe(403);
    expect((await deskDoc(b.id, b.train, "x.pdf", ACT.stranger)).status).toBe(403);
    expect((await deskDoc(b.id, String(oid()), "x.pdf")).status).toBe(404);
    const flight: any = await col("csteparrangements").findOne({ _id: id$(b.flight) });
    expect((await del(ACT.traveller, `/requests/${b.id}/arrangements/${b.flight}/attachment/${flight.attachmentIds[0]}`)).status).toBe(403);
    expect((await del(ACT.official, `/requests/${b.id}/arrangements/${b.flight}/attachment/${oid()}`)).status).toBe(404);
  });

  it("report/start links every booked leg to its service, and the leg shows the Desk's documents", async () => {
    const legs = await startReport(b);
    const all = await reportLegs(b.id);
    expect(all.every((l) => l.arrangementId && l.source === "SEEDED" && l.paidBy === "CSTEP")).toBe(true);
    const leg = (x: string) => all.find((l) => l._id === x);
    expect(names(leg(legs.flightLeg).bookingDocuments)).toEqual(["eticket-onward.pdf", "eticket-return.pdf"]);
    expect(names(leg(legs.hotelLeg).bookingDocuments)).toEqual(["hotel-folio.pdf"]);
    expect(leg(legs.cabLeg).bookingDocuments).toEqual([]);
  });

  it("a voucher the Desk attaches after the report started still appears on the leg (by reference)", async () => {
    ok(await deskDoc(b.id, b.train, "train-ticket.pdf"));
    const all = await reportLegs(b.id);
    const train = all.find((l) => String(l.arrangementId) === b.train);
    expect(names(train.bookingDocuments)).toEqual(["train-ticket.pdf"]);
  });
});

describe("what a booked leg needs from the traveller", () => {
  let b: Booked;
  let legs: Awaited<ReturnType<typeof startReport>>;

  it("only the flight's boarding pass blocks submit — not the hotel, the train, or the cab the Desk never documented", async () => {
    b = await arrangedTour("QC booked-leg gate");
    legs = await startReport(b);
    const r = await post(ACT.traveller, `/requests/${b.id}/report/submit`);
    expect(r.status).toBe(400);
    expect(r.body.missingLegs).toEqual([{ direction: "ONWARD", travelMode: "FLIGHT", need: "BOARDING_PASS" }]);
    expect(r.body.error).toMatch(/Onward FLIGHT \(boarding pass\)/);
  });

  it("a booked leg is locked to its booking — no flip to self-paid, no fare / mode / currency change, no bill, no no-bill", async () => {
    const path = `/requests/${b.id}/report/legs/${legs.flightLeg}`;
    for (const body of [{ paidBy: "SELF" }, { fare: 5000 }, { travelMode: "TRAIN" }, { currency: "USD", fare: FLIGHT_FARE }, { fare: null }]) {
      const r = await patch(ACT.traveller, path, body);
      expect(r.status, JSON.stringify(body)).toBe(409);
    }
    expect((await patch(ACT.traveller, path, { noBill: true })).status).toBe(409);
    expect((await billDoc(b.id, legs.flightLeg)).status).toBe(409);
    const leg: any = await col("cstepreportlegs").findOne({ _id: id$(legs.flightLeg) });
    expect(leg).toMatchObject({ paidBy: "CSTEP", fare: FLIGHT_FARE, travelMode: "FLIGHT", currency: "INR" });
    expect(leg.attachmentId).toBeUndefined();
    // Re-sending what it already has, and editing the route / dates, still work.
    ok(await patch(ACT.traveller, path, { fare: FLIGHT_FARE, currency: "INR", paidBy: "CSTEP", travelMode: "FLIGHT", fromLocation: "Bengaluru", toLocation: "Delhi", fromDate: "2026-11-02" }));
  });

  it("travel proof: boarding passes on a flight, an optional ticket on a train, nothing on a hotel or cab", async () => {
    expect((await proof(b.id, legs.hotelLeg, "x.pdf")).status).toBe(409);
    expect((await proof(b.id, legs.cabLeg, "x.pdf")).status).toBe(409);
    ok(await proof(b.id, legs.trainLeg, "train-pnr.pdf"));
    ok(await proof(b.id, legs.flightLeg, "bp-onward.pdf"));
    const second = ok(await proof(b.id, legs.flightLeg, "bp-return.pdf")).body;
    expect(second.leg.boardingPassAttachmentIds).toHaveLength(2);
    const att: any = await col("cstepattachments").findOne({ _id: id$(second.attachment._id) });
    expect(att.documentType).toBe("BOARDING_PASS");
    const all = await reportLegs(b.id);
    const leg = (x: string) => all.find((l) => l._id === x);
    expect(names(leg(legs.flightLeg).boardingPasses)).toEqual(["bp-onward.pdf", "bp-return.pdf"]);
    expect(names(leg(legs.trainLeg).travelProofs)).toEqual(["train-pnr.pdf"]);
    // Removing one, and only the traveller edits the report.
    ok(await del(ACT.traveller, `/requests/${b.id}/report/legs/${legs.flightLeg}/travel-proof/${second.attachment._id}`));
    expect((await col("cstepreportlegs").findOne({ _id: id$(legs.flightLeg) }))!.boardingPassAttachmentIds).toHaveLength(1);
    expect((await file(ACT.stranger, `/requests/${b.id}/report/legs/${legs.flightLeg}/travel-proof`, "x.pdf")).status).toBe(403);
    // A pass on the leg: "not available" is refused.
    expect((await patch(ACT.traveller, `/requests/${b.id}/report/legs/${legs.flightLeg}`, { boardingPassUnavailable: true })).status).toBe(409);
  });

  it("submit passes with the boarding pass — no bill or no-bill tick on any booked leg — and nothing is declared", async () => {
    const before = rendered.length;
    ok(await post(ACT.traveller, `/requests/${b.id}/report/submit`));
    expect(rendered.length).toBe(before); // no Declaration form at all
    const g = ok(await get(ACT.traveller, `/requests/${b.id}`)).body;
    expect(g.claimDeclaration).toEqual([]);
  });

  it("the settlement's booked lines carry the Desk's documents and the boarding pass, live", async () => {
    ok(await post(ACT.manager, `/requests/${b.id}/report/approve`));
    ok(await post(ACT.official, `/requests/${b.id}/settlement/start`));
    // A late hotel bill the Desk attaches while the settlement is being verified.
    ok(await deskDoc(b.id, b.hotel, "hotel-final-bill.pdf"));
    const lines = ok(await get(ACT.official, `/requests/${b.id}/settlement`)).body.lines as any[];
    const line = (x: string) => lines.find((l) => l.source === "ARRANGEMENT" && String(l.sourceId) === x);
    expect(lines.filter((l) => l.mode === "FLIGHT")).toHaveLength(1);
    expect(names(line(b.flight).bookingDocuments)).toEqual(["eticket-onward.pdf", "eticket-return.pdf"]);
    expect(names(line(b.flight).travelProofs)).toEqual(["bp-onward.pdf"]);
    expect(line(b.flight)).toMatchObject({ noBill: false, boardingPassUnavailable: false, amountInr: FLIGHT_FARE });
    expect(names(line(b.hotel).bookingDocuments)).toEqual(["hotel-folio.pdf", "hotel-final-bill.pdf"]);
    expect(names(line(b.train).travelProofs)).toEqual(["train-pnr.pdf"]);
    expect(line(b.cab).bookingDocuments).toEqual([]); // the Desk's own gap, visible to the Official
  });

  it("the packet carries the booking documents and the boarding pass beside the leg", async () => {
    ok(await get(ACT.official, `/requests/${b.id}/packet`));
    const packetLegs = packetCalls[packetCalls.length - 1][3] as any[];
    const entry = (arr: string) => packetLegs.find((e) => String(e.leg.arrangementId) === arr);
    expect(names(entry(b.flight).bookingDocuments)).toEqual(["eticket-onward.pdf", "eticket-return.pdf"]);
    expect(names(entry(b.flight).travelProofs)).toEqual(["bp-onward.pdf"]);
    expect(names(entry(b.hotel).bookingDocuments)).toEqual(["hotel-folio.pdf", "hotel-final-bill.pdf"]);
    expect(entry(b.cab).bookingDocuments).toEqual([]);
  });

  it("once the settlement is finalized the Desk's window is closed", async () => {
    ok(await post(ACT.official, `/requests/${b.id}/settlement/finalize`, { force: true }));
    expect((await deskDoc(b.id, b.cab, "too-late.pdf")).status).toBe(409);
    expect(ok(await get(ACT.official, `/requests/${b.id}`)).body.canAttachBookingDocs).toBe(false);
  });
});

describe("a booked flight with no boarding pass", () => {
  it("'Boarding pass not available' passes submit and puts the flight on the Declaration and the settlement line", async () => {
    const b = await arrangedTour("QC no boarding pass");
    const legs = await startReport(b);
    expect((await patch(ACT.traveller, `/requests/${b.id}/report/legs/${legs.hotelLeg}`, { boardingPassUnavailable: true })).status).toBe(409);
    expect((await patch(ACT.traveller, `/requests/${b.id}/report/legs/${legs.flightLeg}`, { boardingPassUnavailable: "yes" })).status).toBe(400);
    ok(await patch(ACT.traveller, `/requests/${b.id}/report/legs/${legs.flightLeg}`, { boardingPassUnavailable: true }));
    ok(await post(ACT.traveller, `/requests/${b.id}/report/submit`));

    const items = rendered[rendered.length - 1].items;
    expect(items).toEqual([
      expect.objectContaining({ kind: "BOARDING_PASS", lineId: legs.flightLeg, amount: FLIGHT_FARE, currency: "INR", particulars: "Boarding pass not available — Onward Flight — 6E-511 BLR-DEL" }),
    ]);
    const g = ok(await get(ACT.traveller, `/requests/${b.id}`)).body;
    expect(g.hasDeclarationForm).toBe(true);
    expect(g.claimDeclaration.map((d: any) => d.kind)).toEqual(["BOARDING_PASS"]);

    ok(await post(ACT.manager, `/requests/${b.id}/report/approve`));
    ok(await post(ACT.official, `/requests/${b.id}/settlement/start`));
    const lines = ok(await get(ACT.official, `/requests/${b.id}/settlement`)).body.lines as any[];
    expect(lines.find((l) => String(l.sourceId) === b.flight)).toMatchObject({ boardingPassUnavailable: true, noBill: false });

    ok(await get(ACT.official, `/requests/${b.id}/packet`));
    expect(packetCalls[packetCalls.length - 1][5].map((d: any) => d.kind)).toEqual(["BOARDING_PASS"]);
  });

  it("uploading a boarding pass clears the tick", async () => {
    const b = await arrangedTour("QC tick cleared");
    const legs = await startReport(b);
    ok(await patch(ACT.traveller, `/requests/${b.id}/report/legs/${legs.flightLeg}`, { boardingPassUnavailable: true }));
    ok(await proof(b.id, legs.flightLeg, "found-it.pdf"));
    expect((await col("cstepreportlegs").findOne({ _id: id$(legs.flightLeg) }))!.boardingPassUnavailable).toBe(false);
  });
});

describe("self-paid legs are unchanged", () => {
  it("a self-booked hotel (no booking link) still needs the traveller's bill or No bill", async () => {
    const b = await arrangedTour("QC self-paid");
    const legs = await startReport(b);
    ok(await proof(b.id, legs.flightLeg, "bp.pdf"));
    const selfHotel = String(ok(await post(ACT.traveller, `/requests/${b.id}/report/legs`, { direction: "RETURN", travelMode: "HOTEL", fare: 4000, paidBy: "SELF" })).body.leg._id);
    const r = await post(ACT.traveller, `/requests/${b.id}/report/submit`);
    expect(r.status).toBe(400);
    expect(r.body.missingLegs).toEqual([{ direction: "RETURN", travelMode: "HOTEL", need: "DOCUMENT" }]);
    // No travel proof on it; and it can still become self-paid / change fare — it's the traveller's own.
    expect((await proof(b.id, selfHotel, "x.pdf")).status).toBe(409);
    ok(await patch(ACT.traveller, `/requests/${b.id}/report/legs/${selfHotel}`, { fare: 4200 }));
    ok(await patch(ACT.traveller, `/requests/${b.id}/report/legs/${selfHotel}`, { noBill: true }));
    ok(await post(ACT.traveller, `/requests/${b.id}/report/submit`));
    const items = rendered[rendered.length - 1].items;
    expect(items.map((d: any) => [d.kind, d.lineId])).toEqual([["REPORT_LEG", selfHotel]]);
  });
});

describe("+ Add back keeps the link", () => {
  it("the restored leg carries arrangementId, shows the Desk's documents, and a second add-back is refused", async () => {
    const b = await arrangedTour("QC add-back link");
    const legs = await startReport(b);
    ok(await del(ACT.traveller, `/requests/${b.id}/report/legs/${legs.flightLeg}`));
    const back = ok(
      await post(ACT.traveller, `/requests/${b.id}/report/legs`, { arrangementId: b.flight, direction: "ONWARD", travelMode: "FLIGHT", fare: FLIGHT_FARE, currency: "INR", paidBy: "CSTEP" }),
    ).body.leg;
    expect(String(back.arrangementId)).toBe(b.flight);
    expect((await post(ACT.traveller, `/requests/${b.id}/report/legs`, { arrangementId: b.flight, direction: "ONWARD" })).status).toBe(409);
    const leg = (await reportLegs(b.id)).find((l) => l._id === String(back._id));
    expect(names(leg.bookingDocuments)).toEqual(["eticket-onward.pdf", "eticket-return.pdf"]);
  });
});

describe("legacy booked legs (seeded before P1 — no arrangementId) keep the old rule", () => {
  it("needs a bill or No bill, takes the traveller's upload, and settlement pairs it by order + mode", async () => {
    const b = await arrangedTour("QC legacy");
    const legs = await startReport(b);
    await col("cstepreportlegs").updateMany({ requestId: id$(b.id) }, { $unset: { arrangementId: 1 } });

    const r = await post(ACT.traveller, `/requests/${b.id}/report/submit`);
    expect(r.status).toBe(400);
    expect(r.body.missingLegs.map((m: any) => [m.travelMode, m.need])).toEqual([
      ["FLIGHT", "DOCUMENT"],
      ["HOTEL", "DOCUMENT"],
      ["TRAIN", "DOCUMENT"],
      ["CAB", "DOCUMENT"],
    ]);
    // Old behaviour: the traveller may edit it, and travel proof doesn't apply.
    expect((await proof(b.id, legs.flightLeg, "x.pdf")).status).toBe(409);
    ok(await billDoc(b.id, legs.flightLeg));
    for (const x of [legs.hotelLeg, legs.trainLeg, legs.cabLeg]) ok(await patch(ACT.traveller, `/requests/${b.id}/report/legs/${x}`, { noBill: true }));
    ok(await post(ACT.traveller, `/requests/${b.id}/report/submit`));
    expect(rendered[rendered.length - 1].items.map((d: any) => d.lineId)).toEqual([legs.hotelLeg, legs.trainLeg, legs.cabLeg]);

    ok(await post(ACT.manager, `/requests/${b.id}/report/approve`));
    ok(await post(ACT.official, `/requests/${b.id}/settlement/start`));
    const lines = ok(await get(ACT.official, `/requests/${b.id}/settlement`)).body.lines as any[];
    const flightLine = lines.find((l) => String(l.sourceId) === b.flight);
    expect(flightLine.attachmentId).toBeTruthy(); // the traveller's upload, paired by order + mode
    expect(lines.find((l) => String(l.sourceId) === b.hotel)).toMatchObject({ noBill: true });
    // The Desk's documents still show on the line — they live on the arrangement.
    expect(names(flightLine.bookingDocuments)).toEqual(["eticket-onward.pdf", "eticket-return.pdf"]);
  });
});

describe("the packet assembly (real)", () => {
  it("embeds each booking document and boarding pass behind its own caption page", async () => {
    const real: any = await vi.importActual("../utils/cstepPacketPdf.js");
    const req: any = { _id: oid(), workspaceId: WS, formType: "TOUR_PROPOSAL", status: "REPORT_SUBMITTED", purpose: "QC packet", departureDate: "2026-11-02", returnDate: "2026-11-04", stations: [] };
    const leg = { _id: oid(), direction: "ONWARD", travelMode: "FLIGHT", fare: FLIGHT_FARE, currency: "INR", paidBy: "CSTEP", source: "SEEDED", arrangementId: oid() };
    const doc = (name: string, documentType: string) => ({ _id: oid(), s3Key: `k/${name}`, originalName: name, mime: "application/pdf", documentType });
    const traveller = { name: "Asha Rao" };
    const plain = await PdfLibDocument.load(await real.generateCstepPacketPdf(req, traveller, [], [{ leg: { ...leg, arrangementId: undefined }, attachment: null }]));
    const booked = await PdfLibDocument.load(
      await real.generateCstepPacketPdf(req, traveller, [], [
        { leg, attachment: null, bookingDocuments: [doc("e1.pdf", "ETICKET"), doc("e2.pdf", "ETICKET")], travelProofs: [doc("bp.pdf", "BOARDING_PASS")] },
      ]),
    );
    // plain: caption + "no document" placeholder (2); booked: 3 × (caption + its one page) (6).
    expect(booked.getPageCount() - plain.getPageCount()).toBe(4);
    const awaiting = await PdfLibDocument.load(await real.generateCstepPacketPdf(req, traveller, [], [{ leg, attachment: null, bookingDocuments: [], travelProofs: [] }]));
    expect(awaiting.getPageCount()).toBe(plain.getPageCount()); // caption + "not attached yet"
  }, 30_000);
});
