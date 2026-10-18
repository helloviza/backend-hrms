// apps/backend/src/routes/cstep.vendors.test.ts
//
// CSTEP Vendor Master — routes/cstep.vendors.ts. Vendor codes from the
// continuous VENDOR series (CSTEPVEN0001, 0002, … and a refused create
// burns none), vendor-type CRUD with a one-time starter seed, the
// duplicate-name and GSTIN-shape warnings (warn, never block), the import
// preview → commit (codes assigned at commit only, bad rows skipped with a
// reason, Vendor Code updates), an xlsx export that re-imports cleanly,
// and access: CSTEP Admin full, Finance read-only, anyone else nothing.
//
// Real: vendors router behind the real requireFeature("cstepEnabled"),
//   models, Counter, in-memory Mongo on a fresh database, cstep_qc_vendor.
// Stubbed: auth + workspace resolution (x-test-user / x-test-ws headers).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_vendor";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";

const { default: vendorsRouter, STARTER_VENDOR_TYPES } = await import("./cstep.vendors.js");
const { requireFeature } = await import("../middleware/requireFeature.js");

const DB = "cstep_qc_vendor";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const WS_OFF = oid(); // cstepEnabled false
const U = { admin: oid(), finance: oid(), plain: oid(), traveller: oid() };

const app = express();
app.use(express.json());
app.use(
  "/api/cstep/vendors",
  async (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    const ws = String(req.headers["x-test-ws"] || WS);
    req.workspaceObjectId = new mongoose.Types.ObjectId(ws);
    req.workspaceId = ws;
    // What requireWorkspace attaches — requireFeature reads it.
    req.workspace = await col("customerworkspaces").findOne({ _id: req.workspaceObjectId });
    next();
  },
  requireFeature("cstepEnabled"),
  vendorsRouter,
);

const who = (id: mongoose.Types.ObjectId, roles: string[]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = {
  admin: who(U.admin, ["WORKSPACE_LEADER"]),
  finance: who(U.finance, ["CUSTOMER"]),
  plain: who(U.plain, ["CUSTOMER"]),
};
const call = (method: "get" | "post" | "put" | "delete", as: any, path: string, ws = WS) =>
  request(app)[method](`/api/cstep/vendors${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(ws));
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const csv = (lines: string[]) => Buffer.from(lines.join("\n") + "\n");
const upload = (step: "preview" | "commit", buf: Buffer, filename = "v.csv", as = ACT.admin) =>
  call("post", as, `/import/${step}`).attach("file", buf, { filename, contentType: filename.endsWith(".csv") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
const typeId = async (name: string) => String(((await col("cstepvendortypes").findOne({ workspaceId: WS, name })) as any)._id);
const vendorSeq = async () => (((await col("counters").findOne({ _id: `cstep:${WS}:VENDOR` as any })) as any)?.seq ?? 0);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri(DB);

  // Step 0 gate: a local server and an empty database, or nothing is seeded.
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);

  await mongoose.connection.syncIndexes();

  await col("customerworkspaces").insertMany([
    { _id: WS, customerId: String(oid()), companyName: "QC CSTEP", status: "ACTIVE", config: { features: { cstepEnabled: true } } },
    { _id: WS_OFF, customerId: String(oid()), companyName: "QC Other", status: "ACTIVE", config: { features: { cstepEnabled: false } } },
  ] as any[]);
  // Finance = mapped as a traveller's financeUserId.
  await col("travellerprofiles").insertOne({
    workspaceId: WS, travelerId: "E-1", firstName: "Tara", lastName: "V", isActive: true,
    claimedBy: U.traveller, financeUserId: U.finance, source: "MANUAL", createdBy: String(U.admin),
  } as any);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("vendor types", () => {
  it("the first use seeds the starter list, once", async () => {
    const a = ok(await call("get", ACT.admin, "/types"));
    expect(a.body.types.map((t: any) => t.name).sort()).toEqual([...STARTER_VENDOR_TYPES].sort());
    ok(await call("get", ACT.admin, "/types"));
    expect(await col("cstepvendortypes").countDocuments({ workspaceId: WS })).toBe(STARTER_VENDOR_TYPES.length);
  });

  it("CRUD: add, refuse a case-duplicate, rename, deactivate, delete an unused one — and no re-seed after", async () => {
    const add = ok(await call("post", ACT.admin, "/types").send({ name: "  Florist " }));
    expect(add.body.type.name).toBe("Florist");
    expect((await call("post", ACT.admin, "/types").send({ name: "florist" })).status).toBe(409);
    expect((await call("post", ACT.admin, "/types").send({ name: " " })).status).toBe(400);

    const id = String(add.body.type._id);
    expect(ok(await call("put", ACT.admin, `/types/${id}`).send({ name: "Floral" })).body.type.name).toBe("Floral");
    expect((await call("put", ACT.admin, `/types/${id}`).send({ name: "HOTEL" })).status).toBe(409);
    expect(ok(await call("put", ACT.admin, `/types/${id}`).send({ isActive: false })).body.type.isActive).toBe(false);

    ok(await call("delete", ACT.admin, `/types/${await typeId("Courier")}`));
    const after = ok(await call("get", ACT.admin, "/types")).body.types.map((t: any) => t.name);
    expect(after).not.toContain("Courier");
    expect(after).toContain("Floral");
  });
});

describe("vendors — create, codes, warnings", () => {
  it("create → CSTEPVEN0001, the next → CSTEPVEN0002", async () => {
    const a = ok(await call("post", ACT.admin, "/").send({
      name: "Skyline Travels", vendorTypeId: await typeId("Airline"), mobile: "9800000001", email: "Ops@Skyline.Test",
      address: "12 MG Road", city: "Bengaluru", gstin: "29ABCDE1234F1Z5",
    }));
    expect(a.body.vendor).toMatchObject({ vendorCode: "CSTEPVEN0001", name: "Skyline Travels", email: "ops@skyline.test", city: "Bengaluru", gstin: "29ABCDE1234F1Z5" });
    expect(a.body.warnings).toEqual([]);
    const b = ok(await call("post", ACT.admin, "/").send({ name: "Lakeview Hotel", vendorTypeId: await typeId("Hotel") }));
    expect(b.body.vendor.vendorCode).toBe("CSTEPVEN0002");
  });

  it("a refused create (no name, no type, unknown or inactive type, bad email) burns no code", async () => {
    const before = await vendorSeq();
    const bad = [
      { vendorTypeId: await typeId("Airline") },
      { name: "No Type" },
      { name: "Bad Type", vendorTypeId: String(oid()) },
      { name: "Off Type", vendorTypeId: await typeId("Floral") },
      { name: "Bad Mail", vendorTypeId: await typeId("Airline"), email: "not-an-email" },
    ];
    const errors = [];
    for (const body of bad) {
      const r = await call("post", ACT.admin, "/").send(body);
      expect(r.status).toBe(400);
      errors.push(r.body.error);
    }
    expect(errors).toEqual([
      "Vendor name is required", "Vendor type is required", "Unknown vendor type", 'Vendor type "Floral" is inactive', "Invalid email format",
    ]);
    expect(await vendorSeq()).toBe(before);
    expect(ok(await call("post", ACT.admin, "/").send({ name: "Metro Cabs", vendorTypeId: await typeId("Cab") })).body.vendor.vendorCode).toBe("CSTEPVEN0003");
  });

  it("an exact duplicate name (case/spacing ignored) warns but saves", async () => {
    const r = ok(await call("post", ACT.admin, "/").send({ name: "  skyline   TRAVELS ", vendorTypeId: await typeId("Airline") }));
    expect(r.status).toBe(201);
    expect(r.body.vendor.vendorCode).toBe("CSTEPVEN0004");
    expect(r.body.warnings).toEqual(['Another vendor is already called "Skyline Travels" (CSTEPVEN0001) — saved anyway']);
  });

  it("a GSTIN that isn't the 15-char shape warns but saves (create and edit); a valid one doesn't", async () => {
    const r = ok(await call("post", ACT.admin, "/").send({ name: "Rail Desk", vendorTypeId: await typeId("Railway"), gstin: "29abc123" }));
    expect(r.body.vendor.gstin).toBe("29ABC123");
    expect(r.body.warnings[0]).toMatch(/GSTIN 29ABC123 doesn't look like a 15-character GSTIN/);
    const e = ok(await call("put", ACT.admin, `/${r.body.vendor._id}`).send({ gstin: "27AAACR5055K1Z7" }));
    expect(e.body.warnings).toEqual([]);
    const e2 = ok(await call("put", ACT.admin, `/${r.body.vendor._id}`).send({ gstin: "27AAACR5055K1Z" }));
    expect(e2.body.warnings).toHaveLength(1);
  });

  it("edit changes fields but never the code", async () => {
    const [v]: any = await col("cstepvendors").find({ vendorCode: "CSTEPVEN0002" }).toArray();
    expect((await call("put", ACT.admin, `/${v._id}`).send({ vendorCode: "CSTEPVEN9999" })).status).toBe(400);
    const r = ok(await call("put", ACT.admin, `/${v._id}`).send({ city: "Mysuru", mobile: "", isActive: false }));
    expect(r.body.vendor).toMatchObject({ vendorCode: "CSTEPVEN0002", city: "Mysuru", isActive: false });
    expect(r.body.vendor.mobile).toBeUndefined();
  });

  it("a type in use can't be deleted; a vendor in use can't be deleted (deactivate instead)", async () => {
    expect((await call("delete", ACT.admin, `/types/${await typeId("Airline")}`)).status).toBe(409);
    const [v]: any = await col("cstepvendors").find({ vendorCode: "CSTEPVEN0003" }).toArray();
    await col("cstepexpenselines").insertOne({ workspaceId: WS, vendorId: v._id } as any);
    expect((await call("delete", ACT.admin, `/${v._id}`)).status).toBe(409);
    const r = ok(await call("post", ACT.admin, "/").send({ name: "Temp", vendorTypeId: await typeId("Miscellaneous") }));
    ok(await call("delete", ACT.admin, `/${r.body.vendor._id}`));
    expect(await col("cstepvendors").countDocuments({ name: "Temp" })).toBe(0);
  });
});

describe("access — Admin full, Finance read-only, anyone else nothing", () => {
  it("Finance (a mapped financeUserId) reads the list, one vendor, types and the export", async () => {
    const list = ok(await call("get", ACT.finance, "/"));
    expect(list.body.vendors.length).toBeGreaterThan(3);
    expect(list.body.canEdit).toBe(false);
    ok(await call("get", ACT.finance, `/${list.body.vendors[0]._id}`));
    ok(await call("get", ACT.finance, "/types"));
    ok(await call("get", ACT.finance, "/export"));
  });

  it("Finance can't write anything", async () => {
    const [v]: any = await col("cstepvendors").find({}).limit(1).toArray();
    const air = await typeId("Airline");
    const writes = [
      call("post", ACT.finance, "/").send({ name: "F", vendorTypeId: air }),
      call("put", ACT.finance, `/${v._id}`).send({ city: "X" }),
      call("delete", ACT.finance, `/${v._id}`),
      call("post", ACT.finance, "/types").send({ name: "F" }),
      call("put", ACT.finance, `/types/${air}`).send({ name: "F" }),
      call("delete", ACT.finance, `/types/${air}`),
      call("get", ACT.finance, "/template"),
      upload("preview", csv(["Vendor Name,Vendor Type", "F,Airline"]), "v.csv", ACT.finance),
      upload("commit", csv(["Vendor Name,Vendor Type", "F,Airline"]), "v.csv", ACT.finance),
    ];
    for (const r of await Promise.all(writes)) expect(r.status).toBe(403);
    expect(await col("cstepvendors").countDocuments({ name: "F" })).toBe(0);
  });

  it("an ordinary user can't even read; a non-CSTEP workspace is refused by the feature gate", async () => {
    expect((await call("get", ACT.plain, "/")).status).toBe(403);
    expect((await call("get", ACT.plain, "/types")).status).toBe(403);
    expect((await call("get", ACT.admin, "/", WS_OFF)).status).toBe(403);
  });

  it("Admin has the list with canEdit", async () => {
    expect(ok(await call("get", ACT.admin, "/")).body.canEdit).toBe(true);
  });
});

describe("import — preview then commit", () => {
  const FILE = [
    "Vendor Code,Vendor Name,Vendor Type,Mobile,Email,Address,City,GSTIN,TDS Rate,Active",
    ",Sunrise Tours,airline,9811111111,desk@sunrise.test,1 Lake Rd,Pune,27AAACR5055K1Z7,2,Yes", //  2 create
    ",,Hotel,,,,,,,", //                                                                         3 no name
    ",Ghost Vendor,Spaceships,,,,,,,", //                                                        4 unknown type
    ",Sunrise Tours,Hotel,,,,,,,", //                                                            5 in-file dup (new, same name)
    ",Lakeview Hotel,Hotel,,,,,BADGST,,", //                                                     6 create + 2 warnings
    "CSTEPVEN0001,,,,,,Chennai,,,", //                                                           7 update Skyline, city only
    "cstepven0001,Skyline Again,,,,,,,,", //                                                      8 code repeated → skip
    "CSTEPVEN0999,Nobody,Airline,,,,,,,", //                                                         9 unknown code → skip
    ",No Type,,,,,,,,", //                                                                       10 missing type
    ",Bad Mail,Airline,,nope,,,,,", //                                                               11 bad email
    ",Off Type,Floral,,,,,,,", //                                                              12 inactive type
    ",Bad Active,Airline,,,,,,,maybe", //                                                            13 bad Active
  ];

  it("preview reports every row, writes nothing and takes no code", async () => {
    const vendorsBefore = await col("cstepvendors").countDocuments();
    const seqBefore = await vendorSeq();
    const r = ok(await upload("preview", csv(FILE)));
    const by = (n: number) => r.body.results.find((x: any) => x.rowNumber === n);
    expect(by(2)).toMatchObject({ action: "create", name: "Sunrise Tours" });
    expect(by(2).vendorCode).toBeUndefined();
    expect(by(3)).toMatchObject({ action: "skip", reason: "Vendor Name is required" });
    expect(by(4).reason).toMatch(/^Unknown vendor type "Spaceships"/);
    expect(by(5)).toMatchObject({ action: "skip", reason: '"Sunrise Tours" is also a new vendor on row 2 of this file' });
    expect(by(6).action).toBe("create");
    expect(by(6).warnings).toHaveLength(2);
    expect(by(6).warnings.join(" ")).toMatch(/GSTIN BADGST/);
    expect(by(6).warnings.join(" ")).toMatch(/already called "Lakeview Hotel" \(CSTEPVEN0002\)/);
    expect(by(7)).toMatchObject({ action: "update", vendorCode: "CSTEPVEN0001", name: "Skyline Travels" });
    expect(by(8)).toMatchObject({ action: "skip", reason: "Vendor Code CSTEPVEN0001 is also on row 7 of this file" });
    expect(by(9).reason).toMatch(/^No vendor with code CSTEPVEN0999/);
    expect(by(10).reason).toBe("Vendor Type is required");
    expect(by(11).reason).toBe("Invalid email format");
    expect(by(12).reason).toBe('Vendor type "Floral" is inactive');
    expect(by(13).reason).toBe('Active must be Yes or No, not "maybe"');
    expect(r.body).toMatchObject({ created: 2, updated: 1, skipped: 9, warned: 1 });
    expect(await col("cstepvendors").countDocuments()).toBe(vendorsBefore);
    expect(await vendorSeq()).toBe(seqBefore);
  });

  it("commit assigns the next codes, applies the update, skips the same rows", async () => {
    const seqBefore = await vendorSeq(); // 6 issued so far (0001–0006)
    const r = ok(await upload("commit", csv(FILE)));
    expect(r.body).toMatchObject({ created: 2, updated: 1, skipped: 9 });
    const by = (n: number) => r.body.results.find((x: any) => x.rowNumber === n);
    expect(by(2).vendorCode).toBe(`CSTEPVEN${String(seqBefore + 1).padStart(4, "0")}`);
    expect(by(6).vendorCode).toBe(`CSTEPVEN${String(seqBefore + 2).padStart(4, "0")}`);
    const sunrise: any = await col("cstepvendors").findOne({ name: "Sunrise Tours" });
    expect(sunrise).toMatchObject({ mobile: "9811111111", email: "desk@sunrise.test", city: "Pune", gstin: "27AAACR5055K1Z7", tdsRate: 2, isActive: true });
    expect(String(sunrise.vendorTypeId)).toBe(await typeId("Airline"));
    const skyline: any = await col("cstepvendors").findOne({ vendorCode: "CSTEPVEN0001" });
    expect(skyline).toMatchObject({ name: "Skyline Travels", city: "Chennai", mobile: "9800000001", gstin: "29ABCDE1234F1Z5" }); // blanks kept
    for (const n of ["Ghost Vendor", "Nobody", "No Type", "Bad Mail", "Off Type", "Bad Active", "Skyline Again"]) {
      expect(await col("cstepvendors").countDocuments({ name: n })).toBe(0);
    }
  });

  it("the template is the export's header row, Admin only", async () => {
    const r = ok(await call("get", ACT.admin, "/template?format=csv"));
    expect(r.text.trim()).toBe("Vendor Code,Vendor Name,Vendor Type,Mobile,Email,Address,City,GSTIN,TDS Section,TDS Rate,Active");
  });
});

describe("export round-trips", () => {
  it("xlsx with every field incl. the code; re-importing it updates every vendor and changes nothing", async () => {
    const res = ok(await binary(call("get", ACT.admin, "/export")));
    expect(res.headers["content-type"]).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as any); // ExcelJS types predate Buffer<ArrayBufferLike>
    const sheet = wb.worksheets[0];
    const header = (sheet.getRow(1).values as any[]).slice(1);
    expect(header).toEqual(["Vendor Code", "Vendor Name", "Vendor Type", "Mobile", "Email", "Address", "City", "GSTIN", "TDS Section", "TDS Rate", "Active"]);
    const total = await col("cstepvendors").countDocuments({ workspaceId: WS });
    expect(sheet.rowCount - 1).toBe(total);
    const sky = (sheet.getRow(2).values as any[]).slice(1);
    expect(sky).toEqual(["CSTEPVEN0001", "Skyline Travels", "Airline", "9800000001", "ops@skyline.test", "12 MG Road", "Chennai", "29ABCDE1234F1Z5", "", "", "Yes"]);

    const strip = (docs: any[]) => docs.map(({ updatedAt, updatedBy, __v, ...d }) => d);
    const before = strip(await col("cstepvendors").find({ workspaceId: WS }).sort({ vendorCode: 1 }).toArray());
    const seqBefore = await vendorSeq();
    const prev = ok(await upload("preview", res.body as Buffer, "cstep-vendors.xlsx"));
    expect(prev.body).toMatchObject({ created: 0, updated: total, skipped: 0 });
    ok(await upload("commit", res.body as Buffer, "cstep-vendors.xlsx"));
    expect(strip(await col("cstepvendors").find({ workspaceId: WS }).sort({ vendorCode: 1 }).toArray())).toEqual(before);
    expect(await vendorSeq()).toBe(seqBefore);
  });
});
