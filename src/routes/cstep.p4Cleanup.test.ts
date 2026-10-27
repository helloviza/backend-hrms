// apps/backend/src/routes/cstep.p4Cleanup.test.ts
//
// P4 + CSTEP cleanup:
//   P4 — GET /cities: city suggestions from the FIRST character (the local
//        city catalogue the SBT hotel search reads), cities only, ≤10; the
//        fields stay free text; SBT's own /sbt/hotels/cities is unchanged.
//   #2 — a round trip's seeded legs read Onward then Return (the last of two
//        same-mode transport lines is the return leg), in the leg labels and
//        the missing-items message.
//   #3 — the packet draws no "→" (NotoSans has no glyph for it — a box):
//        every string it draws is fully covered by the embedded font.
//   #4 — an ADDED arrangement line says who added it: Travel Desk /
//        Official / Admin (stamped; derived for lines added before).
//   #5 — the approval-form PDF (GET /pdf) is rebuilt only when stale:
//        N views → one render / one object; each change to what it prints →
//        exactly one rebuild; anything it doesn't print → none.
//
// Real: cstep + SBT hotel routers, models, the PDF generators, in-memory
//   Mongo REPLICA SET on a fresh database, cstep_qc_p4_cleanup.
// Stubbed: the S3 client (every PutObject is recorded), mail, the
//   presigner, the attachment store, auth (x-test-user), the workspace.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import PDFDocument from "pdfkit";
import { PDFDocument as PdfLibDocument, PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_p4_cleanup";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.TBO_ENV;
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;
vi.setConfig({ testTimeout: 60_000 });

const puts = vi.hoisted(() => [] as Array<{ Key: string; Body: any }>);
const onePagePdf = vi.hoisted(() => ({ bytes: Buffer.from("") }));
let uploadSeq = 0;
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: any) {
      if (cmd?.kind === "put") puts.push(cmd.input);
      return {};
    }
  },
  PutObjectCommand: class {
    kind = "put";
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

const { default: cstepRouter } = await import("./cstep.js");
const { searchHotelCatalog } = await import("../services/hotelCatalogSearch.js");
const { TBOCity, TBOCountry, TBOHotelMaster, normalizeSearch } = await import("../jobs/static-data-refresh.js");
const { generateCstepPacketPdf } = await import("../utils/cstepPacketPdf.js");

const DB = "cstep_qc_p4_cleanup";
const oid = () => new mongoose.Types.ObjectId();
const id$ = (s: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), manager: oid(), official: oid(), finance: oid(), admin: oid(), desk: oid(), stranger: oid() };
const TP = oid();

const app = express();
app.use(express.json());
const testAuth = (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = WS;
  next();
};
app.use("/api/cstep", testAuth, cstepRouter);
const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({ _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS) });
const ACT = {
  traveller: who(U.traveller),
  manager: who(U.manager),
  official: who(U.official),
  finance: who(U.finance),
  admin: who(U.admin, ["ADMIN"]),
  desk: who(U.desk), // the workspace Travel Desk (grant) — not this traveller's Official, not an Admin
  stranger: who(U.stranger),
};
const send = (m: "get" | "post" | "patch" | "delete", as: any, p: string, body?: any, base = "/api/cstep") => {
  const r = request(app)[m](`${base}${p}`).set("x-test-user", JSON.stringify(as));
  return m === "get" || m === "delete" ? r : r.send(p === "/requests" ? { projectId: String(QC_PROJECT), ...body } : body || {});
};
const get = (as: any, p: string) => send("get", as, p);
const post = (as: any, p: string, body?: any) => send("post", as, p, body);
const patch = (as: any, p: string, body?: any) => send("patch", as, p, body);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const file = (as: any, p: string, name: string) =>
  request(app)
    .post(`/api/cstep${p}`)
    .set("x-test-user", JSON.stringify(as))
    .attach("file", Buffer.from(`%PDF-1.4 ${name}`), { filename: name, contentType: "application/pdf" });
const requestDoc = async (id: string) => (await col("csteptravelrequests").findOne({ _id: id$(id) }))!;

const TOUR = {
  type: "DOMESTIC",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
  perDiemEligible: false,
};

const M_CITIES = ["Mumbai", "Madurai", "Mangaluru", "Mysuru", "Meerut", "Mathura", "Manali", "Mohali", "Moradabad", "Malappuram", "Muzaffarpur", "Mirzapur"];

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
  ok(await post(ACT.admin, "/travel-desk", { userId: String(U.desk) }));

  // The city catalogue (the SBT hotel search's local source).
  await (TBOCountry as any).insertMany([{ code: "IN", name: "India" }, { code: "GB", name: "United Kingdom" }]);
  await (TBOCity as any).insertMany([
    ...M_CITIES.map((name, i) => ({ code: `IN${100 + i}`, name, countryCode: "IN", searchName: normalizeSearch(name) })),
    { code: "GB001", name: "Manchester", countryCode: "GB", searchName: normalizeSearch("Manchester") },
  ]);
  await (TBOHotelMaster as any).insertMany([{ hotelCode: "H1", hotelName: "Marriott Mumbai", cityCode: "IN100", countryCode: "IN", searchName: normalizeSearch("Marriott Mumbai") }]);
}, 240_000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

// ── P4 ────────────────────────────────────────────────────────────────────
describe("P4 — city suggestions from the first letter", () => {
  it("one letter brings up to 10 cities, from the local catalogue, cities only", async () => {
    const r = ok(await get(ACT.traveller, "/cities?q=m")).body;
    expect(r.results).toHaveLength(10);
    expect(r.results.every((c: any) => /^m/i.test(c.name))).toBe(true);
    expect(r.results.some((c: any) => /marriott/i.test(c.name))).toBe(false); // no hotels
    expect(r.results[0]).toMatchObject({ countryCode: "IN", countryName: "India" }); // India first
  });

  it("narrows as you type; nothing typed → nothing; an unknown city → no suggestions (not an error)", async () => {
    expect(ok(await get(ACT.traveller, "/cities?q=mum")).body.results[0]).toMatchObject({ name: "Mumbai", countryName: "India" });
    expect(ok(await get(ACT.traveller, "/cities?q=manc")).body.results.map((c: any) => c.name)).toEqual(["Manchester"]);
    expect(ok(await get(ACT.traveller, "/cities?q=")).body.results).toEqual([]);
    expect(ok(await get(ACT.traveller, "/cities?q=zzyzx")).body.results).toEqual([]);
  });

  it("every CSTEP login can look cities up (the field is on their forms)", async () => {
    for (const k of ["manager", "official", "finance", "admin", "desk"] as const) {
      expect(ok(await get(ACT[k], "/cities?q=m")).body.results.length, k).toBe(10);
    }
  });

  it("free text: a tour leg and a report leg keep a city the catalogue doesn't know", async () => {
    const created = ok(
      await post(ACT.traveller, "/requests", { ...TOUR, purpose: "QC free text", stations: [{ from: "Zzyzx Springs", to: "Nowhere Junction", durationOfStay: "1 day" }] }),
    ).body.request;
    expect(created.stations[0]).toMatchObject({ from: "Zzyzx Springs", to: "Nowhere Junction" });
    const id = String(created._id);
    ok(await post(ACT.manager, `/requests/${id}/approve`));
    ok(await post(ACT.official, `/requests/${id}/start-arranging`));
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
    ok(await post(ACT.traveller, `/requests/${id}/report/start`));
    const leg = ok(await post(ACT.traveller, `/requests/${id}/report/legs`, { direction: "ONWARD", travelMode: "CAB", paidBy: "SELF" })).body.leg;
    const saved = ok(await patch(ACT.traveller, `/requests/${id}/report/legs/${leg._id}`, { fromLocation: "Unlisted Halt", toLocation: "Mumbai" })).body.leg;
    expect(saved).toMatchObject({ fromLocation: "Unlisted Halt", toLocation: "Mumbai" });
  });

  it("SBT unchanged: the shared search called SBT's way still returns hotels; its route keeps the 2-letter floor", async () => {
    // routes/sbt.hotels.ts searchLocalCatalog calls it with hotelCap 8.
    expect((await searchHotelCatalog("mu", { priorityCode: "IN", cityCap: 10, hotelCap: 8 })).cities.map((c) => c.name)).toContain("Mumbai");
    const byHotel = await searchHotelCatalog("marriott", { priorityCode: "IN", cityCap: 10, hotelCap: 8 });
    expect(byHotel.hotels.map((h) => h.hotelName)).toEqual(["Marriott Mumbai"]);
    // The CSTEP call (hotelCap 0) is the only one that skips hotels.
    expect((await searchHotelCatalog("marriott", { priorityCode: "IN", cityCap: 10, hotelCap: 0 })).hotels).toEqual([]);
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "sbt.hotels.ts"), "utf8");
    const handler = src.slice(src.indexOf('router.get("/cities"'), src.indexOf('router.get("/cities"') + 800);
    expect(handler).toContain("if (!q || q.length < 2) return res.json([]);");
  });
});

// ── #2 + #4 ───────────────────────────────────────────────────────────────
describe("#2 a round trip reads Onward then Return; #4 each added line says who added it", () => {
  let id = "";
  let lines: Record<string, string> = {};

  it("set-up: the seeded flight (Official), a return flight (Travel Desk), a hotel (Official), a cab (Admin)", async () => {
    id = String(ok(await post(ACT.traveller, "/requests", { ...TOUR, purpose: "QC round trip" })).body.request._id);
    ok(await post(ACT.manager, `/requests/${id}/approve`));
    const [flight] = ok(await post(ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
    ok(await patch(ACT.official, `/requests/${id}/arrangements/${flight._id}`, { details: "6E-511 BLR-DEL", amount: 6400, currency: "INR", status: "ARRANGED" }));
    const add = async (as: any, arrangedType: string, details: string, amount: number) =>
      ok(await post(as, `/requests/${id}/arrangements`, { arrangedType, details, amount, currency: "INR" })).body.line;
    const back = await add(ACT.desk, "FLIGHT", "6E-512 DEL-BLR", 6100);
    const hotel = await add(ACT.official, "HOTEL", "Taj Delhi 2N", 12000);
    const cab = await add(ACT.admin, "CAB", "Airport drop", 800);
    expect([back.addedByRole, hotel.addedByRole, cab.addedByRole]).toEqual(["TRAVEL_DESK", "OFFICIAL", "ADMIN"]);
    lines = { flight: String(flight._id), back: String(back._id), hotel: String(hotel._id), cab: String(cab._id) };
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  });

  it("#4 the request shows each adder — a Desk-added row is not 'Official'", async () => {
    const g = ok(await get(ACT.official, `/requests/${id}`)).body;
    const by = (x: string) => g.arrangements.find((a: any) => a._id === x);
    expect(by(lines.back).addedByRole).toBe("TRAVEL_DESK");
    expect(by(lines.hotel).addedByRole).toBe("OFFICIAL");
    expect(by(lines.cab).addedByRole).toBe("ADMIN");
    expect(by(lines.flight).source).toBe("REQUESTED"); // the requested line keeps "Requested: …"
    expect(by(lines.flight).addedByRole).toBeUndefined();
  });

  it("#4 a line added before the stamp is read back from who created it", async () => {
    await col("csteparrangements").updateMany({ requestId: id$(id), source: "ADDED" }, { $unset: { addedByRole: 1 } });
    const g = ok(await get(ACT.traveller, `/requests/${id}`)).body;
    const by = (x: string) => g.arrangements.find((a: any) => a._id === x);
    expect([by(lines.back).addedByRole, by(lines.hotel).addedByRole, by(lines.cab).addedByRole]).toEqual(["TRAVEL_DESK", "OFFICIAL", "ADMIN"]);
  });

  it("#2 report/start: the first flight is Onward, the second Return; the hotel and cab stay Onward", async () => {
    const legs: any[] = ok(await post(ACT.traveller, `/requests/${id}/report/start`)).body.legs;
    const dir = (x: string) => legs.find((l) => String(l.arrangementId) === x)?.direction;
    expect(dir(lines.flight)).toBe("ONWARD");
    expect(dir(lines.back)).toBe("RETURN");
    expect(dir(lines.hotel)).toBe("ONWARD");
    expect(dir(lines.cab)).toBe("ONWARD");
  });

  it("#2 the missing-items message names the Onward and the Return flight", async () => {
    const r = await post(ACT.traveller, `/requests/${id}/report/submit`);
    expect(r.status).toBe(400);
    expect(r.body.missingLegs).toEqual([
      { direction: "ONWARD", travelMode: "FLIGHT", need: "BOARDING_PASS" },
      { direction: "RETURN", travelMode: "FLIGHT", need: "BOARDING_PASS" },
    ]);
    expect(r.body.error).toMatch(/Onward FLIGHT \(boarding pass\)/);
    expect(r.body.error).toMatch(/Return FLIGHT \(boarding pass\)/);
  });
});

// ── #3 ────────────────────────────────────────────────────────────────────
describe("#3 the packet draws no arrow — every character it draws is in its font", () => {
  const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fonts");
  const fonts = ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"].map((f) => fontkit.create(fs.readFileSync(path.join(FONT_DIR, f))));
  const missingGlyphs = (s: string) => [...s].filter((ch) => ch.trim() && !fonts.every((f: any) => f.hasGlyphForCodePoint(ch.codePointAt(0)!)));

  /** pdfkit text drawn into a box (a `height` option) that didn't fit it — pdfkit drops the overflow silently. */
  const clipped: string[] = [];
  async function drawnStrings(request: any, legs: any[]) {
    const drawn: string[] = [];
    // Call-through wrappers: record every string drawn, then draw it.
    const origText = (PDFDocument as any).prototype.text;
    (PDFDocument as any).prototype.text = function (this: any, ...args: any[]) {
      if (args[0] != null) drawn.push(String(args[0]));
      const opts = args.find((a, i) => i > 0 && a && typeof a === "object");
      // pdfkit always draws a box's first line; it drops the lines after it that don't fit.
      if (args[0] != null && opts?.height && opts?.width) {
        const oneLine = this.heightOfString("X", { width: opts.width });
        if (this.heightOfString(String(args[0]), { width: opts.width }) > Math.max(opts.height, oneLine) + 0.5) clipped.push(String(args[0]));
      }
      return origText.apply(this, args);
    };
    const origDraw = (PDFPage as any).prototype.drawText;
    (PDFPage as any).prototype.drawText = function (...args: any[]) {
      if (args[0] != null) drawn.push(String(args[0]));
      return origDraw.apply(this, args);
    };
    try {
      const bytes = await generateCstepPacketPdf(request, { name: "Asha Rao", travelerId: "CSTEP-001" }, [], legs, undefined, []);
      expect((await PdfLibDocument.load(bytes)).getPageCount()).toBeGreaterThan(2);
    } finally {
      (PDFDocument as any).prototype.text = origText;
      (PDFPage as any).prototype.drawText = origDraw;
    }
    return drawn;
  }

  const leg = (over: any) => ({ leg: { _id: oid(), direction: "ONWARD", travelMode: "FLIGHT", fromLocation: "Bengaluru", toLocation: "Delhi", fromDate: "2026-11-02", fare: 6400, currency: "INR", paidBy: "SELF", ...over }, attachment: null });

  it("a domestic tour: header 'FROM – TO', routes 'Bengaluru to Delhi', no →, no glyph the font lacks", async () => {
    const req = { _id: oid(), workspaceId: WS, formType: "TOUR_PROPOSAL", type: "DOMESTIC", status: "REPORT_SUBMITTED", purpose: "QC glyphs", departureDate: "2026-11-02", returnDate: "2026-11-04", stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }] };
    const drawn = await drawnStrings(req, [leg({}), leg({ direction: "RETURN", fromLocation: "Delhi", toLocation: "Bengaluru" })]);
    const all = drawn.join("\n");
    expect(all).toContain("FROM – TO");
    expect(all).toContain("Bengaluru to Delhi");
    expect(all).toContain("Delhi to Bengaluru");
    expect(all).not.toContain("→");
    expect(drawn.flatMap(missingGlyphs)).toEqual([]);
  });

  it("browser-QC find: a stay's end date and the 'awaiting Travel Desk document' note are no longer clipped; a same-day leg shows one date", async () => {
    clipped.length = 0;
    const req = { _id: oid(), workspaceId: WS, formType: "TOUR_PROPOSAL", type: "DOMESTIC", status: "REPORT_SUBMITTED", purpose: "QC row heights", departureDate: "2026-11-10", returnDate: "2026-11-12", stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "2 days" }] };
    const hotel = { leg: { _id: oid(), direction: "ONWARD", travelMode: "HOTEL", fromLocation: "Delhi", toLocation: "Delhi", fromDate: "2026-11-10", toDate: "2026-11-12", fare: 12000, currency: "INR", paidBy: "CSTEP", arrangementId: oid(), remarks: "Taj Delhi 2N — late checkout agreed with the property" }, attachment: null, bookingDocuments: [], travelProofs: [] };
    const drawn = await drawnStrings(req, [leg({ toDate: "2026-11-10", fromDate: "2026-11-10" }), hotel]);
    expect(drawn).toContain("10/11/2026"); // the same-day flight: one date
    expect(drawn).toContain("10/11/2026 – 12/11/2026"); // the stay: both dates
    expect(drawn).toContain("Booked by CSTEP · awaiting Travel Desk document");
    expect(clipped).toEqual([]);
  });

  it("an international tour: the country date range uses an en dash", async () => {
    const req = { _id: oid(), workspaceId: WS, formType: "TOUR_PROPOSAL", type: "INTERNATIONAL", status: "REPORT_SUBMITTED", purpose: "QC glyphs intl", departureDate: "2026-11-02", returnDate: "2026-11-09", countries: [{ country: "Germany", fromDate: "2026-11-02", toDate: "2026-11-09" }] };
    const drawn = await drawnStrings(req, [leg({ fromLocation: "Bengaluru", toLocation: "Frankfurt" })]);
    const all = drawn.join("\n");
    expect(all).toMatch(/02 Nov 2026 – 09 Nov 2026|2026 – /);
    expect(all).not.toContain("→");
    expect(drawn.flatMap(missingGlyphs)).toEqual([]);
  });
});

// ── #5 ────────────────────────────────────────────────────────────────────
describe("#5 the approval-form PDF is rebuilt only when what it prints changes", () => {
  let id = "";
  let cabLeg = "";
  let flightLeg = "";
  let flightLine = "";
  const formRenders = (rid: string) => puts.filter((p) => p.Key.startsWith(`cstep-tour-proposals/${WS}/${rid}/`)).length;
  const packetRenders = (rid: string) => puts.filter((p) => p.Key.startsWith(`cstep-packets/${WS}/${rid}/`)).length;
  /** Views the approval PDF from several logins; returns how many renders that caused. */
  const formRebuildsOnViews = async (rid = id, viewers: Array<keyof typeof ACT> = ["traveller", "manager", "official", "finance", "admin", "desk"]) => {
    const n = formRenders(rid);
    for (const k of viewers) {
      ok(await get(ACT[k], `/requests/${rid}/pdf?mode=view`));
      ok(await get(ACT[k], `/requests/${rid}/pdf?mode=download`));
    }
    return formRenders(rid) - n;
  };

  it("a draft: first view renders once; N views by its owner render nothing more; a plain read leaves the request untouched", async () => {
    id = String(ok(await post(ACT.traveller, "/requests", { ...TOUR, purpose: "QC approval PDF", saveDraft: true })).body.request._id);
    expect(await formRebuildsOnViews(id, ["traveller"])).toBe(1);
    const before = await requestDoc(id);
    for (let n = 0; n < 10; n++) expect(await formRebuildsOnViews(id, ["traveller"])).toBe(0);
    const after = await requestDoc(id);
    expect(after.pdfS3Key).toBe(before.pdfS3Key);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(formRenders(id)).toBe(1);
  });

  it("an edit → once; submit → once; approve (status, TIN, signature) → once", async () => {
    ok(await patch(ACT.traveller, `/requests/${id}`, { purpose: "QC approval PDF — edited" }));
    expect(await formRebuildsOnViews(id, ["traveller"])).toBe(1);
    ok(await post(ACT.traveller, `/requests/${id}/submit`));
    expect(await formRebuildsOnViews()).toBe(1);
    ok(await post(ACT.manager, `/requests/${id}/approve`));
    expect((await requestDoc(id)).claimReference).toBeTruthy();
    expect(await formRebuildsOnViews()).toBe(1);
    expect(await formRebuildsOnViews()).toBe(0);
  });

  it("arranging: each status move → once; arrangement line edits and the Desk's documents → none", async () => {
    const [flight] = ok(await post(ACT.official, `/requests/${id}/start-arranging`)).body.arrangements;
    flightLine = String(flight._id);
    expect(await formRebuildsOnViews()).toBe(1);
    ok(await patch(ACT.official, `/requests/${id}/arrangements/${flightLine}`, { details: "6E-511 BLR-DEL", amount: 6400, currency: "INR", status: "ARRANGED" }));
    ok(await file(ACT.desk, `/requests/${id}/arrangements/${flightLine}/attachment`, "eticket.pdf"));
    expect(await formRebuildsOnViews()).toBe(0);
    ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
    expect(await formRebuildsOnViews()).toBe(1);
  });

  it("the travel report: starting it → once; legs, bills and boarding passes → none; submit / approve → once each", async () => {
    const legs: any[] = ok(await post(ACT.traveller, `/requests/${id}/report/start`)).body.legs;
    flightLeg = String(legs.find((l) => String(l.arrangementId) === flightLine)._id);
    expect(await formRebuildsOnViews()).toBe(1);
    const cab = ok(
      await post(ACT.traveller, `/requests/${id}/report/legs`, {
        direction: "ONWARD", travelMode: "CAB", paidBy: "SELF", fare: 900, currency: "INR",
        fromLocation: "Airport", toLocation: "Office", fromDate: "2026-11-02", toDate: "2026-11-02",
      }),
    ).body.leg;
    cabLeg = String(cab._id);
    ok(await file(ACT.traveller, `/requests/${id}/report/legs/${cabLeg}/attachment`, "cab-bill.pdf"));
    ok(await file(ACT.traveller, `/requests/${id}/report/legs/${flightLeg}/travel-proof`, "bp.pdf"));
    expect(await formRebuildsOnViews()).toBe(0);
    ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
    expect(await formRebuildsOnViews()).toBe(1);
    ok(await post(ACT.manager, `/requests/${id}/report/approve`));
    expect(await formRebuildsOnViews()).toBe(1);
  });

  it("the settlement (its figures print on the form): start → once; a line change → once; finalize → once", async () => {
    const lines: any[] = ok(await post(ACT.official, `/requests/${id}/settlement/start`)).body.lines;
    expect(await formRebuildsOnViews()).toBe(1);
    ok(await patch(ACT.official, `/requests/${id}/settlement/lines/${lines[0]._id}`, { verified: true }));
    expect(await formRebuildsOnViews()).toBe(1);
    ok(await post(ACT.official, `/requests/${id}/settlement/finalize`, { force: true }));
    expect((await requestDoc(id)).status).toBe("TRANSFERRED_TO_FINANCE");
    expect(await formRebuildsOnViews()).toBe(1);
  });

  it("Finance pays it (REIMBURSED) → once; then views are free", async () => {
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { reference: "UTR-QC-5" }));
    expect((await requestDoc(id)).status).toBe("REIMBURSED");
    expect(await formRebuildsOnViews()).toBe(1);
    for (let n = 0; n < 3; n++) expect(await formRebuildsOnViews()).toBe(0);
  });

  it("the traveller's name changes on their profile → the form and the packet each rebuild once", async () => {
    ok(await get(ACT.official, `/requests/${id}/packet`));
    const p = packetRenders(id);
    await col("travellerprofiles").updateOne({ _id: TP }, { $set: { lastName: "Rao-Menon" } });
    expect(await formRebuildsOnViews()).toBe(1);
    expect(await formRebuildsOnViews()).toBe(0);
    ok(await get(ACT.official, `/requests/${id}/packet`));
    ok(await get(ACT.finance, `/requests/${id}/packet`));
    expect(packetRenders(id) - p).toBe(1);
    await col("travellerprofiles").updateOne({ _id: TP }, { $set: { lastName: "Rao" } });
  });

  it("a PDF cached before #5 (no flag) rebuilds once; a failed render stays stale and retries", async () => {
    await col("csteptravelrequests").updateOne({ _id: id$(id) }, { $unset: { pdfStale: 1 } });
    expect(await formRebuildsOnViews()).toBe(1);
    expect(await formRebuildsOnViews()).toBe(0);

    await col("csteptravelrequests").updateOne({ _id: id$(id) }, { $set: { pdfStale: true } });
    const s3 = await import("@aws-sdk/client-s3");
    const sendSpy = vi.spyOn((s3 as any).S3Client.prototype, "send").mockRejectedValueOnce(new Error("S3 down"));
    expect((await get(ACT.official, `/requests/${id}/pdf`)).status).toBe(500);
    sendSpy.mockRestore();
    expect((await requestDoc(id)).pdfStale).toBe(true);
    expect(await formRebuildsOnViews()).toBe(1);
  });

  it("a claim's form (another generator, same cache): N views → one render", async () => {
    const claim = ok(
      await post(ACT.traveller, "/requests", {
        formType: "LOCAL_TRAVEL_CLAIM", purpose: "QC claim PDF", departureDate: "2026-10-05", returnDate: "2026-10-09",
        travelLines: [{ date: "2026-10-06", from: "Office", to: "Site", mode: "CAB", fare: 300, noBill: true }],
        foodLines: [], otherExpenses: 0, advanceTaken: 0,
      }),
    ).body.request;
    const cid = String(claim._id);
    const claimRenders = () => puts.filter((p) => p.Key.startsWith(`cstep-claims/${WS}/${cid}/local-travel-claim-`)).length;
    for (let n = 0; n < 5; n++) for (const k of ["traveller", "manager", "admin"] as const) ok(await get(ACT[k], `/requests/${cid}/pdf`));
    expect(claimRenders()).toBe(1);
    ok(await post(ACT.manager, `/requests/${cid}/approve`));
    for (let n = 0; n < 3; n++) ok(await get(ACT.traveller, `/requests/${cid}/pdf`));
    expect(claimRenders()).toBe(2);
  });

  it("a login that can't open the case can't fetch its form", async () => {
    expect((await get(ACT.stranger, `/requests/${id}/pdf`)).status).toBe(403);
  });
});
