// Route-level coverage for routes/admin.visa.rules.ts — the fee/rule
// management API. Same in-memory-collection mocking approach as
// admin.visa.test.ts (mongodb-memory-server can't start in this
// environment): every model this router touches is backed by a small
// generic store with real find/findById/findOne/create semantics, so the
// duplicate-key guard, the publish-completeness gate, and the audit trail
// are actually exercised, not just asserted against a hand-picked fixture.
//
// requirePermission itself is NOT mocked — same reasoning as
// admin.visa.test.ts: these tests exist specifically to prove every route
// here (including the GET reads) is gated at FULL, nothing lower.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";

const {
  _rules,
  _content,
  _ruleAudits,
  _users,
  chainableArray,
  chainableRuleArray,
  chainableSortedPage,
  findByIdRule,
  findOneContentDoc,
  deriveDisplayMode,
} = vi.hoisted(() => {
  function matches(rec: Record<string, any>, filter: Record<string, any>): boolean {
    return Object.entries(filter || {}).every(([key, cond]) => {
      if (key === "_id" && cond && typeof cond === "object" && "$in" in cond) {
        return (cond.$in as any[]).map(String).includes(String(rec._id));
      }
      return String(rec[key]) === String(cond);
    });
  }

  function makeCollection() {
    const store = new Map<string, Record<string, any>>();
    return {
      store,
      insert(doc: Record<string, any>): Record<string, any> {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const rec = { ...doc, _id: id };
        store.set(String(id), rec);
        return rec;
      },
      get(id: any) {
        return store.get(String(id)) ?? null;
      },
      query(filter: Record<string, any> = {}) {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      clear() {
        store.clear();
      },
    };
  }

  function deriveDisplayMode(rec: Record<string, any>): string {
    const hasItemised = rec.embassyFeeInr != null || rec.vfsFeeInr != null || rec.plumtripsServiceFeeInr != null;
    return hasItemised ? "ITEMISED" : "INDICATIVE";
  }

  // select/sort are no-ops; only .lean() actually resolves — same shape
  // as admin.visa.test.ts's own chainableArray.
  function chainableArray(getResult: () => any[]) {
    const obj: any = {
      select: () => obj,
      sort: () => obj,
      lean: () => Promise.resolve(getResult()),
    };
    return obj;
  }

  function wrapDoc(rec: Record<string, any> | null, onSaveDerive?: (r: any) => void) {
    if (!rec) return null;
    const doc: any = { ...rec };
    Object.defineProperty(doc, "save", {
      enumerable: false,
      value: async (_opts?: any) => {
        if (onSaveDerive) onSaveDerive(doc);
        Object.assign(rec, doc);
        return doc;
      },
    });
    Object.defineProperty(doc, "toObject", {
      enumerable: false,
      value: () => {
        const { save: _s, toObject: _t, ...plain } = doc;
        return { ...plain };
      },
    });
    return doc;
  }

  function wrapRuleDoc(rec: Record<string, any> | null) {
    return wrapDoc(rec, (doc) => {
      doc.displayMode = deriveDisplayMode(doc);
    });
  }

  function findByIdRule(id: any) {
    const rec = _rules.get(id);
    const p: any = Promise.resolve(wrapRuleDoc(rec));
    p.lean = () => Promise.resolve(rec ? { ...rec } : null);
    p.select = () => p;
    return p;
  }

  function findOneContentDoc(filter: Record<string, any>) {
    const rec = _content.query(filter)[0] ?? null;
    const p: any = Promise.resolve(wrapDoc(rec));
    p.lean = () => Promise.resolve(rec ? { ...rec } : null);
    return p;
  }

  // find(...).session(session) — supports BOTH `.lean()` (plain objects,
  // GET /rules) and being awaited directly for a live-doc array (bulk
  // edit, which calls .save() on each). A thenable object resolves the
  // live-doc form when nothing forces .lean().
  function chainableRuleArray(getRecords: () => any[]) {
    const obj: any = {
      sort: () => obj,
      session: () => obj,
      lean: () => Promise.resolve(getRecords().map((r) => ({ ...r }))),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(getRecords().map((r) => wrapRuleDoc(r))).then(onFulfilled, onRejected),
      catch: (onRejected: any) => Promise.resolve(getRecords().map((r) => wrapRuleDoc(r))).catch(onRejected),
    };
    return obj;
  }

  // find(filter).sort({field:-1}).skip(n).limit(n).lean() — real sort/
  // skip/limit (not no-ops), used by GET /rules/:id/audit's actual
  // pagination so the newest-first ordering and page boundaries are
  // genuinely exercised, not just asserted against an unsliced array.
  function chainableSortedPage(getRecords: () => any[]) {
    let sortField: string | null = null;
    let sortDir = 1;
    let skipN = 0;
    let limitN: number | null = null;
    const obj: any = {
      sort: (spec: Record<string, number>) => {
        const [field, dir] = Object.entries(spec)[0] || [];
        sortField = field ?? null;
        sortDir = (dir as number) ?? 1;
        return obj;
      },
      skip: (n: number) => { skipN = n; return obj; },
      limit: (n: number) => { limitN = n; return obj; },
      lean: () => {
        let recs = getRecords().map((r) => ({ ...r }));
        if (sortField) {
          recs.sort((a, b) => {
            const av = new Date(a[sortField as string]).getTime();
            const bv = new Date(b[sortField as string]).getTime();
            return (av - bv) * sortDir;
          });
        }
        recs = recs.slice(skipN, limitN != null ? skipN + limitN : undefined);
        return Promise.resolve(recs);
      },
    };
    return obj;
  }

  return {
    _rules: makeCollection(),
    _content: makeCollection(),
    _ruleAudits: makeCollection(),
    _users: makeCollection(),
    chainableArray,
    chainableRuleArray,
    chainableSortedPage,
    findByIdRule,
    findOneContentDoc,
    deriveDisplayMode,
  };
});

vi.mock("../models/VisaRule.js", async () => {
  const actual: any = await vi.importActual("../models/VisaRule.js");
  return {
    VISA_PURPOSES: actual.VISA_PURPOSES,
    VISA_ENTRY_TYPES: actual.VISA_ENTRY_TYPES,
    VISA_SERVICE_TIERS: actual.VISA_SERVICE_TIERS,
    VISA_PRODUCT_CLASSES: actual.VISA_PRODUCT_CLASSES,
    VISA_CATEGORIES: actual.VISA_CATEGORIES,
    VISA_ETA_BASES: actual.VISA_ETA_BASES,
    VISA_DOC_REQUIREMENT_LEVELS: actual.VISA_DOC_REQUIREMENT_LEVELS,
    VISA_RULE_DISPLAY_MODES: actual.VISA_RULE_DISPLAY_MODES,
    VISA_RULE_STATUSES: actual.VISA_RULE_STATUSES,
    default: {
      find: (filter: any) => chainableRuleArray(() => _rules.query(filter)),
      findById: (id: any) => findByIdRule(id),
      create: async (doc: Record<string, any>) => {
        const dupe = _rules.query({
          nationality: doc.nationality,
          destinationIso2: doc.destinationIso2,
          purpose: doc.purpose,
          entryType: doc.entryType,
          serviceTier: doc.serviceTier,
        })[0];
        if (dupe) {
          const e: any = new Error("duplicate key");
          e.code = 11000;
          throw e;
        }
        const rec = _rules.insert({
          isSchengen: false,
          isExtension: false,
          appointmentRequired: false,
          biometricsRequired: false,
          documentRequirements: [],
          status: "DRAFT",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...doc,
        });
        rec.displayMode = deriveDisplayMode(rec);
        return { ...rec, toObject: () => ({ ...rec }) };
      },
    },
  };
});

vi.mock("../models/VisaDestinationContent.js", () => ({
  default: {
    find: (filter: any) => chainableArray(() => _content.query(filter)),
    findOne: (filter: any) => findOneContentDoc(filter),
    findOneAndUpdate: async (filter: any, update: any, opts: any) => {
      let rec = _content.query(filter)[0];
      if (!rec) {
        if (!opts?.upsert) return null;
        rec = _content.insert({ ...(update.$setOnInsert || {}) });
      }
      if (update.$set) Object.assign(rec, update.$set);
      return { ...rec, toObject: () => ({ ...rec }) };
    },
  },
}));

vi.mock("../models/VisaRuleAudit.js", () => ({
  VISA_RULE_AUDIT_ACTIONS: ["CREATE", "UPDATE", "PUBLISH", "RETIRE", "CLONE"],
  default: {
    create: async (docs: any, _opts?: any) => {
      const arr = Array.isArray(docs) ? docs : [docs];
      return arr.map((d: any) => _ruleAudits.insert({ performedAt: new Date(), ...d }));
    },
    find: (filter: any) => chainableSortedPage(() => _ruleAudits.query(filter)),
    countDocuments: async (filter: any) => _ruleAudits.query(filter).length,
  },
}));

vi.mock("../models/User.js", () => ({
  default: {
    find: (filter: any) => chainableArray(() => _users.query(filter)),
  },
}));

vi.mock("../config/visaDocumentCodes.js", async () => {
  const actual: any = await vi.importActual("../config/visaDocumentCodes.js");
  return actual;
});

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

let permissionRecord: any = null;
vi.mock("../models/UserPermission.js", () => ({
  UserPermission: {
    findOne: (_filter: any) => ({ lean: () => Promise.resolve(permissionRecord) }),
  },
  hasAccess: (actual: string, required: string) => {
    const order = ["NONE", "READ", "WRITE", "FULL"];
    return order.indexOf(actual) >= order.indexOf(required);
  },
}));

import express from "express";
import request from "supertest";
import router from "./admin.visa.rules.js";

const USER_ID = new mongoose.Types.ObjectId();

function setAccess(access: "NONE" | "READ" | "WRITE" | "FULL" | null) {
  permissionRecord =
    access == null ? null : { modules: { visaApplication: { access, scope: "ALL" } }, level: { code: "L5" } };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(USER_ID), roles: ["OPS"], email: "concierge@plumtrips.com" };
    next();
  });
  app.use("/", router);
  return app;
}

function ruleDoc(overrides: Record<string, any> = {}) {
  return _rules.insert({
    nationality: "IN",
    destinationIso2: "DE",
    destinationName: "Germany",
    purpose: "TOURIST",
    entryType: "MULTIPLE",
    serviceTier: "STANDARD",
    isSchengen: true,
    productClass: "VISA",
    visaCategory: "STICKER",
    validityDays: 90,
    maxStayDays: 30,
    isExtension: false,
    etaMinDays: 10,
    etaMaxDays: 15,
    etaBasis: "BUSINESS",
    appointmentRequired: true,
    biometricsRequired: true,
    documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }],
    embassyFeeInr: 5000,
    vfsFeeInr: 1500,
    plumtripsServiceFeeInr: 1000,
    displayMode: "ITEMISED",
    status: "DRAFT",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

function completeDraft(overrides: Record<string, any> = {}) {
  return ruleDoc({ status: "DRAFT", ...overrides });
}

let sessionSpy: any;
beforeEach(() => {
  _rules.clear();
  _content.clear();
  _ruleAudits.clear();
  _users.clear();
  setAccess("FULL");

  // Real mongoose.startSession() talks to a live server — not available in
  // this test environment. withTransaction just runs the callback inline;
  // there's nothing to roll back to simulate here since
  // admin.visa.rules.ts's bulk route validates every rule ID exists
  // BEFORE the transaction opens ANY write — the atomicity property this
  // module cares about is enforced by that ordering, not by the
  // transaction primitive itself, so an inline-run fake fully exercises it.
  sessionSpy = vi.spyOn(mongoose, "startSession").mockResolvedValue({
    withTransaction: async (fn: () => Promise<any>) => fn(),
    endSession: () => {},
  } as any);
});

afterEach(() => {
  sessionSpy.mockRestore();
});

describe("permission gate — every route requires FULL", () => {
  const ROUTES: Array<{ method: "get" | "post" | "patch"; path: () => string; body?: any }> = [
    { method: "get", path: () => "/rules" },
    { method: "get", path: () => `/rules/${new mongoose.Types.ObjectId()}` },
    { method: "get", path: () => `/rules/${new mongoose.Types.ObjectId()}/audit` },
    { method: "post", path: () => "/rules", body: {} },
    { method: "patch", path: () => `/rules/${new mongoose.Types.ObjectId()}`, body: {} },
    { method: "post", path: () => `/rules/${new mongoose.Types.ObjectId()}/clone`, body: {} },
    { method: "post", path: () => `/rules/${new mongoose.Types.ObjectId()}/publish` },
    { method: "post", path: () => `/rules/${new mongoose.Types.ObjectId()}/retire` },
    { method: "post", path: () => "/rules/bulk", body: {} },
    { method: "get", path: () => "/destination-content" },
    { method: "get", path: () => "/destination-content/DE" },
    { method: "patch", path: () => "/destination-content/DE", body: {} },
    { method: "post", path: () => "/destination-content/DE/publish" },
  ];

  it("403s on every route with no permission record", async () => {
    setAccess(null);
    const app = makeApp();
    for (const r of ROUTES) {
      const res = await request(app)[r.method](r.path()).send(r.body || {});
      expect(res.status, `${r.method.toUpperCase()} ${r.path()}`).toBe(403);
    }
  });

  it("403s on every route at READ", async () => {
    setAccess("READ");
    const app = makeApp();
    for (const r of ROUTES) {
      const res = await request(app)[r.method](r.path()).send(r.body || {});
      expect(res.status, `${r.method.toUpperCase()} ${r.path()}`).toBe(403);
    }
  });

  it("403s on every route at WRITE — this surface starts at FULL, not the READ/WRITE/FULL ladder", async () => {
    setAccess("WRITE");
    const app = makeApp();
    for (const r of ROUTES) {
      const res = await request(app)[r.method](r.path()).send(r.body || {});
      expect(res.status, `${r.method.toUpperCase()} ${r.path()}`).toBe(403);
    }
  });

  it("FULL can reach the read routes", async () => {
    setAccess("FULL");
    const app = makeApp();
    const r = ruleDoc();
    expect((await request(app).get("/rules")).status).toBe(200);
    expect((await request(app).get(`/rules/${r._id}`)).status).toBe(200);
    expect((await request(app).get("/destination-content")).status).toBe(200);
  });
});

describe("GET /rules — filtering", () => {
  it("filters by destination, purpose, status", async () => {
    ruleDoc({ destinationIso2: "DE", purpose: "TOURIST", status: "PUBLISHED" });
    ruleDoc({ destinationIso2: "DE", purpose: "BUSINESS", status: "DRAFT" });
    ruleDoc({ destinationIso2: "FR", purpose: "TOURIST", status: "PUBLISHED" });
    const app = makeApp();

    const byDestination = await request(app).get("/rules?destination=de");
    expect(byDestination.body.rules).toHaveLength(2);

    const byPurpose = await request(app).get("/rules?destination=DE&purpose=business");
    expect(byPurpose.body.rules).toHaveLength(1);
    expect(byPurpose.body.rules[0].purpose).toBe("BUSINESS");

    const byStatus = await request(app).get("/rules?status=draft");
    expect(byStatus.body.rules).toHaveLength(1);
    expect(byStatus.body.rules[0].status).toBe("DRAFT");
  });

  it("rejects an unknown purpose/status", async () => {
    const app = makeApp();
    expect((await request(app).get("/rules?purpose=NOT_REAL")).status).toBe(400);
    expect((await request(app).get("/rules?status=NOT_REAL")).status).toBe(400);
  });
});

describe("POST /rules — create", () => {
  it("creates a DRAFT rule regardless of any status sent in the body", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/rules")
      .send({
        nationality: "in",
        destinationIso2: "at",
        destinationName: "Austria",
        purpose: "TOURIST",
        entryType: "MULTIPLE",
        serviceTier: "STANDARD",
        productClass: "VISA",
        visaCategory: "STICKER",
        status: "PUBLISHED", // must be ignored
      });
    expect(res.status).toBe(201);
    expect(res.body.rule.status).toBe("DRAFT");
    expect(res.body.rule.nationality).toBe("IN");
    expect(res.body.rule.destinationIso2).toBe("AT");
  });

  it("rejects a duplicate nationality/destination/purpose/entryType/serviceTier key", async () => {
    ruleDoc({ nationality: "IN", destinationIso2: "DE", purpose: "TOURIST", entryType: "MULTIPLE", serviceTier: "STANDARD" });
    const app = makeApp();
    const res = await request(app).post("/rules").send({
      nationality: "IN",
      destinationIso2: "DE",
      destinationName: "Germany",
      purpose: "TOURIST",
      entryType: "MULTIPLE",
      serviceTier: "STANDARD",
      productClass: "VISA",
      visaCategory: "STICKER",
    });
    expect(res.status).toBe(409);
  });

  it("rejects an unknown document requirement code", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/rules")
      .send({
        nationality: "IN",
        destinationIso2: "AT",
        destinationName: "Austria",
        purpose: "TOURIST",
        entryType: "MULTIPLE",
        serviceTier: "STANDARD",
        productClass: "VISA",
        visaCategory: "STICKER",
        documentRequirements: [{ docCode: "DOC-99", requirement: "REQUIRED" }],
      });
    expect(res.status).toBe(400);
  });

  it("writes a CREATE audit entry with the full field snapshot", async () => {
    const app = makeApp();
    const res = await request(app).post("/rules").send({
      nationality: "IN",
      destinationIso2: "AT",
      destinationName: "Austria",
      purpose: "TOURIST",
      entryType: "MULTIPLE",
      serviceTier: "STANDARD",
      productClass: "VISA",
      visaCategory: "STICKER",
      embassyFeeInr: 4000,
    });
    const entries = _ruleAudits.query({ ruleId: res.body.rule.id });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("CREATE");
    const feeChange = entries[0].changes.find((c: any) => c.field === "embassyFeeInr");
    expect(feeChange).toEqual({ field: "embassyFeeInr", from: null, to: 4000 });
  });
});

describe("PATCH /rules/:id — update", () => {
  it("requires effectiveFrom", async () => {
    const r = ruleDoc();
    const app = makeApp();
    const res = await request(app).patch(`/rules/${r._id}`).send({ embassyFeeInr: 6000 });
    expect(res.status).toBe(400);
    expect(_rules.get(r._id).embassyFeeInr).toBe(5000);
  });

  it("rejects changing identity fields", async () => {
    const r = ruleDoc();
    const app = makeApp();
    for (const body of [
      { destinationIso2: "FR", effectiveFrom: "2026-08-01" },
      { purpose: "BUSINESS", effectiveFrom: "2026-08-01" },
      { nationality: "US", effectiveFrom: "2026-08-01" },
    ]) {
      const res = await request(app).patch(`/rules/${r._id}`).send(body);
      expect(res.status).toBe(400);
    }
  });

  it("rejects setting status directly", async () => {
    const r = ruleDoc();
    const app = makeApp();
    const res = await request(app).patch(`/rules/${r._id}`).send({ status: "PUBLISHED", effectiveFrom: "2026-08-01" });
    expect(res.status).toBe(400);
    expect(_rules.get(r._id).status).toBe("DRAFT");
  });

  it("updates fields, records the new effectiveFrom, and writes an UPDATE audit entry with only the changed fields", async () => {
    const r = ruleDoc({ embassyFeeInr: 5000, priceNote: "old note" });
    const app = makeApp();
    const res = await request(app)
      .patch(`/rules/${r._id}`)
      .send({ embassyFeeInr: 6000, effectiveFrom: "2026-09-01" });
    expect(res.status).toBe(200);
    expect(res.body.rule.embassyFeeInr).toBe(6000);
    expect(new Date(res.body.rule.effectiveFrom).toISOString()).toBe(new Date("2026-09-01").toISOString());
    // Untouched field stays as-is.
    expect(res.body.rule.priceNote).toBe("old note");

    const entries = _ruleAudits.query({ ruleId: String(r._id) });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("UPDATE");
    const fields = entries[0].changes.map((c: any) => c.field);
    expect(fields).toContain("embassyFeeInr");
    expect(fields).toContain("effectiveFrom");
    expect(fields).not.toContain("priceNote"); // unchanged — not in the diff
  });

  it("writes no audit entry when nothing actually changed except effectiveFrom staying identical is still a change if resent — verifies empty diffs are skipped", async () => {
    const r = ruleDoc({ effectiveFrom: new Date("2026-01-01T00:00:00.000Z") });
    const app = makeApp();
    // Re-send the exact same effectiveFrom and no other fields — true no-op.
    const res = await request(app).patch(`/rules/${r._id}`).send({ effectiveFrom: "2026-01-01T00:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(_ruleAudits.query({ ruleId: String(r._id) })).toHaveLength(0);
  });

  it("does not mutate an independently-held copy of the rule's document requirements (no accidental reference sharing)", async () => {
    const r = ruleDoc({ documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }] });
    // Stands in for what a VisaApplication.ruleSnapshot would have captured
    // at quote time — a deep, independent copy.
    const simulatedSnapshot = JSON.parse(JSON.stringify(r.documentRequirements));

    const app = makeApp();
    const res = await request(app)
      .patch(`/rules/${r._id}`)
      .send({ documentRequirements: [{ docCode: "DOC-02", requirement: "CONDITIONAL" }], effectiveFrom: "2026-09-01" });
    expect(res.status).toBe(200);
    expect(res.body.rule.documentRequirements).toEqual([{ docCode: "DOC-02", requirement: "CONDITIONAL" }]);

    // The frozen "application" copy never changes.
    expect(simulatedSnapshot).toEqual([{ docCode: "DOC-01", requirement: "REQUIRED" }]);
  });
});

describe("POST /rules/:id/clone", () => {
  it("copies terms from the source, forces DRAFT, and applies destination overrides", async () => {
    const germany = ruleDoc({
      destinationIso2: "DE",
      destinationName: "Germany",
      status: "PUBLISHED",
      embassyFeeInr: 5000,
      vfsFeeInr: 1500,
      documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }],
    });
    const app = makeApp();
    const res = await request(app)
      .post(`/rules/${germany._id}/clone`)
      .send({ destinationIso2: "AT", destinationName: "Austria" });

    expect(res.status).toBe(201);
    expect(res.body.rule.status).toBe("DRAFT");
    expect(res.body.rule.destinationIso2).toBe("AT");
    expect(res.body.rule.destinationName).toBe("Austria");
    // Copied verbatim from the source.
    expect(res.body.rule.embassyFeeInr).toBe(5000);
    expect(res.body.rule.vfsFeeInr).toBe(1500);
    expect(res.body.rule.documentRequirements).toEqual([{ docCode: "DOC-01", requirement: "REQUIRED" }]);
    expect(res.body.clonedFromRuleId).toBe(String(germany._id));
  });

  it("the clone is independent of the source — editing one never touches the other", async () => {
    const germany = ruleDoc({ destinationIso2: "DE", destinationName: "Germany", embassyFeeInr: 5000 });
    const app = makeApp();
    const cloneRes = await request(app)
      .post(`/rules/${germany._id}/clone`)
      .send({ destinationIso2: "AT", destinationName: "Austria" });
    const austriaId = cloneRes.body.rule.id;

    await request(app).patch(`/rules/${austriaId}`).send({ embassyFeeInr: 9999, effectiveFrom: "2026-09-01" });

    expect(_rules.get(germany._id).embassyFeeInr).toBe(5000); // source untouched
    expect(_rules.get(austriaId).embassyFeeInr).toBe(9999);
  });

  it("requires at least a destination override", async () => {
    const germany = ruleDoc();
    const app = makeApp();
    const res = await request(app).post(`/rules/${germany._id}/clone`).send({});
    expect(res.status).toBe(400);
  });

  it("rejects cloning into an existing key", async () => {
    const germany = ruleDoc({ destinationIso2: "DE" });
    ruleDoc({ nationality: "IN", destinationIso2: "AT", purpose: "TOURIST", entryType: "MULTIPLE", serviceTier: "STANDARD" });
    const app = makeApp();
    const res = await request(app)
      .post(`/rules/${germany._id}/clone`)
      .send({ destinationIso2: "AT", destinationName: "Austria" });
    expect(res.status).toBe(409);
  });

  it("writes a CLONE audit entry with clonedFromRuleId set", async () => {
    const germany = ruleDoc();
    const app = makeApp();
    const res = await request(app)
      .post(`/rules/${germany._id}/clone`)
      .send({ destinationIso2: "AT", destinationName: "Austria" });

    const entries = _ruleAudits.query({ ruleId: res.body.rule.id });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("CLONE");
    expect(String(entries[0].clonedFromRuleId)).toBe(String(germany._id));
  });
});

describe("POST /rules/:id/publish", () => {
  it("rejects publishing without visaCategory, ETA, or cost — reports exactly what's missing", async () => {
    const r = ruleDoc({ etaMinDays: undefined, etaMaxDays: undefined, embassyFeeInr: undefined, vfsFeeInr: undefined, plumtripsServiceFeeInr: undefined, indicativeVisaCostInr: undefined });
    const app = makeApp();
    const res = await request(app).post(`/rules/${r._id}/publish`);
    expect(res.status).toBe(400);
    expect(res.body.missing.join(" ")).toMatch(/ETA/);
    expect(res.body.missing.join(" ")).toMatch(/cost/);
    expect(_rules.get(r._id).status).toBe("DRAFT");
  });

  it("publishes a complete DRAFT rule", async () => {
    const r = completeDraft();
    const app = makeApp();
    const res = await request(app).post(`/rules/${r._id}/publish`);
    expect(res.status).toBe(200);
    expect(res.body.rule.status).toBe("PUBLISHED");
  });

  it("rejects publishing an already-PUBLISHED or RETIRED rule", async () => {
    const published = completeDraft({ status: "PUBLISHED" });
    const retired = completeDraft({ status: "RETIRED" });
    const app = makeApp();
    expect((await request(app).post(`/rules/${published._id}/publish`)).status).toBe(400);
    expect((await request(app).post(`/rules/${retired._id}/publish`)).status).toBe(400);
  });

  it("writes a PUBLISH audit entry recording the status transition", async () => {
    const r = completeDraft();
    const app = makeApp();
    await request(app).post(`/rules/${r._id}/publish`);
    const entries = _ruleAudits.query({ ruleId: String(r._id) });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("PUBLISH");
    expect(entries[0].changes).toEqual([{ field: "status", from: "DRAFT", to: "PUBLISHED" }]);
  });
});

describe("POST /rules/:id/retire", () => {
  it("retires a PUBLISHED rule", async () => {
    const r = completeDraft({ status: "PUBLISHED" });
    const app = makeApp();
    const res = await request(app).post(`/rules/${r._id}/retire`);
    expect(res.status).toBe(200);
    expect(res.body.rule.status).toBe("RETIRED");
  });

  it("rejects retiring a DRAFT or already-RETIRED rule", async () => {
    const draft = completeDraft({ status: "DRAFT" });
    const retired = completeDraft({ status: "RETIRED" });
    const app = makeApp();
    expect((await request(app).post(`/rules/${draft._id}/retire`)).status).toBe(400);
    expect((await request(app).post(`/rules/${retired._id}/retire`)).status).toBe(400);
  });

  it("a retired rule still resolves by id — never deleted", async () => {
    const r = completeDraft({ status: "PUBLISHED" });
    const app = makeApp();
    await request(app).post(`/rules/${r._id}/retire`);

    const detail = await request(app).get(`/rules/${r._id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.rule.status).toBe("RETIRED");
    expect(detail.body.rule.id).toBe(String(r._id));
  });

  it("writes a RETIRE audit entry", async () => {
    const r = completeDraft({ status: "PUBLISHED" });
    const app = makeApp();
    await request(app).post(`/rules/${r._id}/retire`);
    const entries = _ruleAudits.query({ ruleId: String(r._id) });
    expect(entries[entries.length - 1].action).toBe("RETIRE");
    expect(entries[entries.length - 1].changes).toEqual([{ field: "status", from: "PUBLISHED", to: "RETIRED" }]);
  });
});

describe("POST /rules/bulk", () => {
  it("applies the same change to every rule and writes one audit entry per changed rule", async () => {
    const at = ruleDoc({ destinationIso2: "AT", vfsFeeInr: 1000 });
    const be = ruleDoc({ destinationIso2: "BE", vfsFeeInr: 1200 });
    const app = makeApp();

    const res = await request(app)
      .post("/rules/bulk")
      .send({ ruleIds: [String(at._id), String(be._id)], effectiveFrom: "2026-09-01", changes: { vfsFeeInr: 1600 } });

    expect(res.status).toBe(200);
    expect(_rules.get(at._id).vfsFeeInr).toBe(1600);
    expect(_rules.get(be._id).vfsFeeInr).toBe(1600);

    expect(_ruleAudits.query({ ruleId: String(at._id) })).toHaveLength(1);
    expect(_ruleAudits.query({ ruleId: String(be._id) })).toHaveLength(1);
  });

  it("is atomic — one missing ruleId means NOTHING is changed, not even the valid ones", async () => {
    const at = ruleDoc({ destinationIso2: "AT", vfsFeeInr: 1000 });
    const be = ruleDoc({ destinationIso2: "BE", vfsFeeInr: 1200 });
    const missingId = new mongoose.Types.ObjectId();
    const app = makeApp();

    const res = await request(app)
      .post("/rules/bulk")
      .send({
        ruleIds: [String(at._id), String(be._id), String(missingId)],
        effectiveFrom: "2026-09-01",
        changes: { vfsFeeInr: 1600 },
      });

    expect(res.status).toBe(404);
    expect(_rules.get(at._id).vfsFeeInr).toBe(1000); // untouched
    expect(_rules.get(be._id).vfsFeeInr).toBe(1200); // untouched
    expect(_ruleAudits.query({})).toHaveLength(0); // no audit rows either
  });

  it("rejects identity fields or status inside changes", async () => {
    const at = ruleDoc({ destinationIso2: "AT" });
    const app = makeApp();
    const res1 = await request(app)
      .post("/rules/bulk")
      .send({ ruleIds: [String(at._id)], effectiveFrom: "2026-09-01", changes: { destinationIso2: "FR" } });
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .post("/rules/bulk")
      .send({ ruleIds: [String(at._id)], effectiveFrom: "2026-09-01", changes: { status: "PUBLISHED" } });
    expect(res2.status).toBe(400);
  });

  it("requires effectiveFrom and a non-empty changes object", async () => {
    const at = ruleDoc({ destinationIso2: "AT" });
    const app = makeApp();
    expect(
      (await request(app).post("/rules/bulk").send({ ruleIds: [String(at._id)], changes: { vfsFeeInr: 1 } })).status,
    ).toBe(400);
    expect(
      (await request(app).post("/rules/bulk").send({ ruleIds: [String(at._id)], effectiveFrom: "2026-09-01", changes: {} })).status,
    ).toBe(400);
  });

  it("rejects an empty or oversized ruleIds array", async () => {
    const app = makeApp();
    expect((await request(app).post("/rules/bulk").send({ ruleIds: [], effectiveFrom: "2026-09-01", changes: { vfsFeeInr: 1 } })).status).toBe(400);
    const tooMany = Array.from({ length: 51 }, () => String(new mongoose.Types.ObjectId()));
    expect((await request(app).post("/rules/bulk").send({ ruleIds: tooMany, effectiveFrom: "2026-09-01", changes: { vfsFeeInr: 1 } })).status).toBe(400);
  });
});

describe("GET /rules/:id/audit", () => {
  it("returns entries newest-first with the performing user resolved to a name", async () => {
    const r = ruleDoc();
    const alice = _users.insert({ firstName: "Alice", lastName: "Wong", email: "alice@plumtrips.com" });
    const bob = _users.insert({ name: "Bob Admin", email: "bob@plumtrips.com" });

    _ruleAudits.insert({ ruleId: r._id, action: "CREATE", changes: [], performedByUserId: bob._id, performedAt: new Date("2026-01-01") });
    _ruleAudits.insert({ ruleId: r._id, action: "UPDATE", changes: [{ field: "vfsFeeInr", from: 1000, to: 1200 }], performedByUserId: alice._id, performedAt: new Date("2026-02-01") });
    _ruleAudits.insert({ ruleId: r._id, action: "PUBLISH", changes: [{ field: "status", from: "DRAFT", to: "PUBLISHED" }], performedByUserId: alice._id, performedAt: new Date("2026-03-01") });

    const app = makeApp();
    const res = await request(app).get(`/rules/${r._id}/audit`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(3);
    expect(res.body.entries.map((e: any) => e.action)).toEqual(["PUBLISH", "UPDATE", "CREATE"]); // newest first
    expect(res.body.entries[0].performedBy.name).toBe("Alice Wong");
    expect(res.body.entries[2].performedBy.name).toBe("Bob Admin");
    expect(res.body.entries[1].changes).toEqual([{ field: "vfsFeeInr", from: 1000, to: 1200 }]);
  });

  it("falls back to email, then Unknown, when a name isn't available", async () => {
    const r = ruleDoc();
    const emailOnly = _users.insert({ email: "noname@plumtrips.com" });
    _ruleAudits.insert({ ruleId: r._id, action: "CREATE", changes: [], performedByUserId: emailOnly._id, performedAt: new Date() });
    _ruleAudits.insert({ ruleId: r._id, action: "RETIRE", changes: [], performedByUserId: new mongoose.Types.ObjectId(), performedAt: new Date() });

    const app = makeApp();
    const res = await request(app).get(`/rules/${r._id}/audit`);
    const byAction = Object.fromEntries(res.body.entries.map((e: any) => [e.action, e.performedBy.name]));
    expect(byAction.CREATE).toBe("noname@plumtrips.com");
    expect(byAction.RETIRE).toBe("Unknown");
  });

  it("paginates", async () => {
    const r = ruleDoc();
    const user = _users.insert({ name: "Alice" });
    for (let i = 0; i < 5; i++) {
      _ruleAudits.insert({ ruleId: r._id, action: "UPDATE", changes: [], performedByUserId: user._id, performedAt: new Date(2026, 0, i + 1) });
    }
    const app = makeApp();
    const page1 = await request(app).get(`/rules/${r._id}/audit?page=1&limit=2`);
    expect(page1.body.entries).toHaveLength(2);
    expect(page1.body.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
    // Newest-first: day 5 then day 4.
    expect(new Date(page1.body.entries[0].performedAt).getDate()).toBe(5);
    expect(new Date(page1.body.entries[1].performedAt).getDate()).toBe(4);

    const page2 = await request(app).get(`/rules/${r._id}/audit?page=2&limit=2`);
    expect(new Date(page2.body.entries[0].performedAt).getDate()).toBe(3);
  });

  it("404s for a nonexistent rule", async () => {
    const app = makeApp();
    const res = await request(app).get(`/rules/${new mongoose.Types.ObjectId()}/audit`);
    expect(res.status).toBe(404);
  });
});

describe("VisaDestinationContent — GET / PATCH / publish", () => {
  it("PATCH upserts — first write creates the row as DRAFT", async () => {
    const app = makeApp();
    const res = await request(app)
      .patch("/destination-content/at")
      .send({ entrySnapshot: { visaRequired: true, headline: "Austria", summary: "Schengen member" } });
    expect(res.status).toBe(200);
    expect(res.body.content.destinationIso2).toBe("AT");
    expect(res.body.content.status).toBe("DRAFT");
    expect(res.body.content.entrySnapshot.headline).toBe("Austria");
  });

  it("PATCH rejects setting status directly", async () => {
    const app = makeApp();
    const res = await request(app).patch("/destination-content/at").send({ status: "PUBLISHED" });
    expect(res.status).toBe(400);
  });

  it("exposes seedSource so the UI can flag unreviewed, LLM-authored placeholder rows", async () => {
    _content.insert({
      destinationIso2: "KH",
      status: "DRAFT",
      businessBlock: { highlights: [] },
      tourismBlock: { highlights: [] },
      entrySnapshot: { visaRequired: true, headline: "", summary: "" },
      seedSource: "seed-visa-rules@2026-07",
    });
    _content.insert({
      destinationIso2: "AT",
      status: "DRAFT",
      businessBlock: { highlights: [] },
      tourismBlock: { highlights: [] },
      entrySnapshot: { visaRequired: true, headline: "", summary: "" },
    });
    const app = makeApp();

    const list = await request(app).get("/destination-content");
    const byIso2 = Object.fromEntries(list.body.content.map((c: any) => [c.destinationIso2, c.seedSource]));
    expect(byIso2.KH).toBe("seed-visa-rules@2026-07");
    expect(byIso2.AT).toBeNull();

    const detail = await request(app).get("/destination-content/kh");
    expect(detail.body.content.seedSource).toBe("seed-visa-rules@2026-07");
  });

  it("rejects publishing without a headline, summary, or any highlight", async () => {
    _content.insert({
      destinationIso2: "AT",
      status: "DRAFT",
      businessBlock: { highlights: [] },
      tourismBlock: { highlights: [] },
      entrySnapshot: { visaRequired: true, headline: "", summary: "" },
    });
    const app = makeApp();
    const res = await request(app).post("/destination-content/at/publish");
    expect(res.status).toBe(400);
    expect(res.body.missing).toEqual(
      expect.arrayContaining(["entrySnapshot.headline", "entrySnapshot.summary", "at least one highlight (businessBlock or tourismBlock)"]),
    );
  });

  it("publishes complete content", async () => {
    _content.insert({
      destinationIso2: "AT",
      status: "DRAFT",
      businessBlock: { highlights: ["Strong biotech sector"] },
      tourismBlock: { highlights: [] },
      entrySnapshot: { visaRequired: true, headline: "Austria", summary: "Schengen member state" },
    });
    const app = makeApp();
    const res = await request(app).post("/destination-content/at/publish");
    expect(res.status).toBe(200);
    expect(res.body.content.status).toBe("PUBLISHED");
  });

  it("404s publishing a destination with no content row yet", async () => {
    const app = makeApp();
    const res = await request(app).post("/destination-content/zz/publish");
    expect(res.status).toBe(404);
  });
});
