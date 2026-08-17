// apps/backend/src/routes/consumer.profile.ts
//
// The D2C consumer's own profile. Mounted at /api/consumer/profile.
//
// ══════════════════════════════════════════════════════════════════════
// THE ONE RULE: THE CONSUMER ID COMES FROM req.consumer.id. ALWAYS.
//
// It is never read from a route param, a query string or a request body.
// There is no endpoint here that takes a consumer id as input, because an
// endpoint that accepts one is an endpoint that can be asked for someone
// else's passport number. `me(req)` below is the ONLY way this file learns
// who is calling, and every query includes it as a mandatory clause.
// ══════════════════════════════════════════════════════════════════════
//
// The consequence, stated plainly: there is no admin view here, no "get
// profile by id", and no list endpoint. Ops tooling for D2C consumers, when
// it exists, will be a separate router behind a staff guard — not a
// parameter added to one of these handlers.
//
// ── 404, NEVER 403, ON A ROW THAT ISN'T YOURS ─────────────────────────
// A sub-resource lookup that misses returns 404 whether the row does not
// exist or belongs to another consumer. Distinguishing them would confirm
// the existence of another consumer's document to anyone who can guess an
// ObjectId. This mirrors visa.ts's findOwnedApplication.
//
// ── WHITELISTED WRITES ────────────────────────────────────────────────
// PATCH does not merge req.body into the document. Each section has an
// explicit field list (SECTION_FIELDS) and anything not on it is dropped
// silently. Without that, `{"consumerId": "<someone else>"}` in a PATCH body
// would reassign the row's owner.
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";

import { requireConsumer } from "../middleware/requireConsumer.js";
import Consumer from "../models/Consumer.js";
import ConsumerProfile from "../models/ConsumerProfile.js";
import ConsumerDocument, {
  CONSUMER_DOCUMENT_CATEGORIES,
} from "../models/ConsumerDocument.js";
import { d2cWorkspaceObjectId } from "../services/consumerWorkspace.js";
import {
  computeProfileCompletion,
} from "../services/consumerProfileCompletion.js";
import {
  putConsumerDocument,
  openConsumerDocument,
  storageDescription,
} from "../services/consumerDocumentStorage.js";

const router = Router();

// EVERY route in this file. Mounted here rather than per-route so a new
// handler cannot be added unguarded.
router.use(requireConsumer);

/* ── Identity ───────────────────────────────────────────────────────── */

/** The ONLY source of the acting consumer's id in this file. */
function me(req: any): string {
  const id = req?.consumer?.id;
  if (!id) {
    // Unreachable behind requireConsumer; thrown rather than defaulted
    // because every alternative to "we know who this is" is a data leak.
    throw new Error("consumer.profile: reached a handler with no req.consumer");
  }
  return String(id);
}

function isValidId(v: unknown): boolean {
  return mongoose.Types.ObjectId.isValid(String(v ?? ""));
}

/* ── Upload config — mirrors routes/visa.ts's ───────────────────────── */

export const CONSUMER_DOCUMENT_ALLOWED_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
];
export const CONSUMER_DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONSUMER_DOCUMENT_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (CONSUMER_DOCUMENT_ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Only PDF, PNG, JPEG, or WEBP files are allowed."));
  },
});

function documentUploadMw(req: any, res: any, next: any) {
  documentUpload.single("file")(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: `File too large. Maximum size is ${CONSUMER_DOCUMENT_MAX_BYTES / (1024 * 1024)}MB.`,
      });
    }
    return res.status(400).json({ error: err?.message || "Upload failed" });
  });
}

/* ── Loading ────────────────────────────────────────────────────────── */

/**
 * Fetches the caller's profile, creating an empty one on first read.
 *
 * Upsert-on-read, because the profile is PROGRESSIVE: a consumer who has
 * never opened the page still has a profile conceptually, and every write
 * handler would otherwise need its own "create if absent" branch. The unique
 * index on consumerId makes the race safe — a concurrent double-create
 * surfaces as E11000, handled by the caller.
 */
async function loadOwnProfile(consumerId: string) {
  const _id = new mongoose.Types.ObjectId(consumerId);
  return ConsumerProfile.findOneAndUpdate(
    { consumerId: _id },
    { $setOnInsert: { consumerId: _id, workspaceId: d2cWorkspaceObjectId() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function liveDocumentCount(consumerId: string): Promise<number> {
  return ConsumerDocument.countDocuments({
    consumerId: new mongoose.Types.ObjectId(consumerId),
    deletedAt: null,
  });
}

/* ── Wire shapes — whitelists, not blocklists ──────────────────────── */

function publicDocument(d: any) {
  return {
    id: String(d._id),
    category: d.category,
    docCode: d.docCode ?? null,
    label: d.label ?? d.originalFilename,
    originalFilename: d.originalFilename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    // Deliberately absent: storageKey, bucket, driver. A storage key is an
    // internal locator; publishing it invites clients to construct their own
    // URLs and would leak the bucket layout. Bytes are served only by
    // GET /documents/:id/file, which re-checks ownership.
    linkedApplicationCount: (d.linkedApplicationIds ?? []).length,
    createdAt: d.createdAt,
  };
}

function publicProfile(doc: any, consumer: { email: string; name: string }) {
  /* ── NEVER SPREAD A MONGOOSE DOCUMENT ─────────────────────────────
   *
   * `{ ...subdoc }` does NOT copy a Mongoose subdocument's fields. The
   * values live behind getters on the prototype, backed by an internal
   * `_doc`, so the spread copies the INTERNALS — `$__`, `$__parent`,
   * `$isNew`, `_doc` — and none of the actual data.
   *
   * That produced two faults at once, and the visible one was the lesser:
   *   1. every contact field serialised as undefined, so a saved mobile
   *      number and address rendered as "—" on a profile that had them;
   *   2. Mongoose internals were published on the wire.
   *
   * Direct assignment (`personal: p.personal`) is safe, because
   * JSON.stringify invokes the document's toJSON. Only the SPREAD is
   * broken — which is why this went unnoticed on five of six sections.
   * Converting once here removes the trap for every field below.
   * ────────────────────────────────────────────────────────────────── */
  const p = typeof doc?.toObject === "function" ? doc.toObject() : doc;

  return {
    id: String(p._id),
    // Echoed so the client never has to hold a consumer id to make a call.
    consumerId: String(p.consumerId),
    workspaceId: String(p.workspaceId),
    personal: p.personal ?? {},
    passports: (p.passports ?? []).map((pp: any) => ({
      id: String(pp._id),
      number: pp.number ?? null,
      type: pp.type ?? null,
      issuingCountry: pp.issuingCountry ?? null,
      issueDate: pp.issueDate ?? null,
      expiryDate: pp.expiryDate ?? null,
      placeOfIssue: pp.placeOfIssue ?? null,
      frontDocumentId: pp.frontDocumentId ? String(pp.frontDocumentId) : null,
      backDocumentId: pp.backDocumentId ? String(pp.backDocumentId) : null,
      isPrimary: Boolean(pp.isPrimary),
    })),
    contact: {
      ...(p.contact ?? {}),
      // The login identity is the source of truth for the verified email —
      // it is not stored on the profile, so it cannot drift out of sync.
      email: consumer.email,
      emailVerified: true,
    },
    travel: p.travel ?? {},
    travelPreferences: p.travelPreferences ?? {},
    coTravellers: (p.coTravellers ?? []).map((c: any) => ({
      id: String(c._id),
      fullName: c.fullName ?? null,
      relationship: c.relationship ?? null,
      dateOfBirth: c.dateOfBirth ?? null,
      passportNumber: c.passportNumber ?? null,
      passportExpiryDate: c.passportExpiryDate ?? null,
      nationality: c.nationality ?? null,
    })),
    accountPrefs: p.accountPrefs ?? {},
    updatedAt: p.updatedAt,
  };
}

/* ── Section whitelists ─────────────────────────────────────────────── */

const SECTION_FIELDS: Record<string, string[]> = {
  personal: [
    "firstName",
    "middleName",
    "lastName",
    "dateOfBirth",
    "gender",
    "placeOfBirthCity",
    "placeOfBirthCountry",
    "nationality",
    "maritalStatus",
    "countryOfResidence",
  ],
  contact: [
    "mobile",
    "alternateEmail",
    "currentAddress",
    "permanentSameAsCurrent",
    "permanentAddress",
  ],
  travel: [
    "occupation",
    "employer",
    "designation",
    "employmentType",
    "workExperienceYears",
    "hasPriorVisaRefusal",
    "travelHistory",
  ],
  travelPreferences: ["cabinClass", "seatPreference", "mealPreference", "frequentFlyerNumbers"],
  accountPrefs: [
    "twoStepEnabled",
    "notifyByEmail",
    "notifyByWhatsapp",
    "notifyProductUpdates",
  ],
};

const ADDRESS_FIELDS = ["line1", "line2", "city", "state", "postalCode", "country"];

function pick(source: any, allowed: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source || typeof source !== "object") return out;
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  return out;
}

/* ── GET / — the whole profile ─────────────────────────────────────── */

router.get("/", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const profile = await loadOwnProfile(consumerId);
    const documentCount = await liveDocumentCount(consumerId);

    return res.json({
      ok: true,
      profile: publicProfile(profile, req.consumer),
      completion: computeProfileCompletion(profile as any, documentCount),
      storage: storageDescription(),
    });
  } catch (err: any) {
    console.error("[consumer profile GET]", err?.message);
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

/* ── GET /completion — the progress panel alone ────────────────────── */

router.get("/completion", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const profile = await loadOwnProfile(consumerId);
    const documentCount = await liveDocumentCount(consumerId);
    return res.json({
      ok: true,
      completion: computeProfileCompletion(profile as any, documentCount),
    });
  } catch (err: any) {
    console.error("[consumer profile completion]", err?.message);
    return res.status(500).json({ error: "Failed to compute completion" });
  }
});

/* ── PATCH /:section — one tab at a time ───────────────────────────── */

router.patch("/:section", async (req: any, res: any) => {
  try {
    const section = String(req.params.section);
    const allowed = SECTION_FIELDS[section];
    if (!allowed) {
      return res.status(404).json({ error: "Unknown profile section" });
    }

    const consumerId = me(req);
    const profile: any = await loadOwnProfile(consumerId);

    const updates = pick(req.body, allowed);

    // Addresses are nested objects, so they get their own whitelist pass —
    // otherwise a client could write arbitrary keys inside currentAddress
    // even though the outer field name is allowed.
    if (section === "contact") {
      if (updates.currentAddress !== undefined) {
        updates.currentAddress = pick(updates.currentAddress, ADDRESS_FIELDS);
      }
      if (updates.permanentAddress !== undefined) {
        updates.permanentAddress = pick(updates.permanentAddress, ADDRESS_FIELDS);
      }
    }

    if (section === "travel" && Array.isArray(updates.travelHistory)) {
      updates.travelHistory = (updates.travelHistory as any[]).map((row) =>
        pick(row, ["country", "visaType", "travelDate", "notes"]),
      );
    }

    if (section === "travelPreferences" && Array.isArray(updates.frequentFlyerNumbers)) {
      updates.frequentFlyerNumbers = (updates.frequentFlyerNumbers as any[]).map((row) =>
        pick(row, ["airline", "number"]),
      );
    }

    for (const [key, value] of Object.entries(updates)) {
      profile[section][key] = value;
    }

    // "Same as current" is applied at WRITE time rather than at read time, so
    // the stored permanent address is a real address a form can be filled
    // from — not a flag every downstream reader has to remember to resolve.
    if (section === "contact" && profile.contact.permanentSameAsCurrent) {
      profile.contact.permanentAddress = { ...(profile.contact.currentAddress ?? {}) };
    }

    await profile.save();
    const documentCount = await liveDocumentCount(consumerId);

    return res.json({
      ok: true,
      profile: publicProfile(profile, req.consumer),
      completion: computeProfileCompletion(profile as any, documentCount),
    });
  } catch (err: any) {
    console.error("[consumer profile PATCH]", err?.message);
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

/* ── Passports ─────────────────────────────────────────────────────── */

const PASSPORT_FIELDS = [
  "number",
  "type",
  "issuingCountry",
  "issueDate",
  "expiryDate",
  "placeOfIssue",
  "frontDocumentId",
  "backDocumentId",
];

/**
 * Exactly one primary, enforced here because this is the only layer that
 * sees the whole array. Mongoose cannot express "one true among siblings".
 */
function normalisePrimary(profile: any, preferredId?: string): void {
  const list: any[] = profile.passports ?? [];
  if (!list.length) return;

  let chosen = preferredId ? list.find((p) => String(p._id) === String(preferredId)) : null;
  if (!chosen) chosen = list.find((p) => p.isPrimary) ?? list[0];

  for (const p of list) p.isPrimary = String(p._id) === String(chosen._id);
}

router.post("/passports", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const profile: any = await loadOwnProfile(consumerId);

    profile.passports.push(pick(req.body, PASSPORT_FIELDS));
    // First passport added becomes primary without the consumer having to
    // choose — a single-passport profile with no primary is a state the
    // Apply page would have to handle for no reason.
    normalisePrimary(profile);
    await profile.save();

    return res.status(201).json({ ok: true, profile: publicProfile(profile, req.consumer) });
  } catch (err: any) {
    console.error("[consumer passport POST]", err?.message);
    return res.status(500).json({ error: "Failed to add passport" });
  }
});

router.patch("/passports/:passportId", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const profile: any = await loadOwnProfile(consumerId);

    // .id() searches only THIS consumer's array — a passport id belonging to
    // another consumer simply is not in it, so this is 404 by construction.
    const passport = profile.passports.id(req.params.passportId);
    if (!passport) return res.status(404).json({ error: "Passport not found" });

    Object.assign(passport, pick(req.body, PASSPORT_FIELDS));
    normalisePrimary(profile);
    await profile.save();

    return res.json({ ok: true, profile: publicProfile(profile, req.consumer) });
  } catch (err: any) {
    console.error("[consumer passport PATCH]", err?.message);
    return res.status(500).json({ error: "Failed to update passport" });
  }
});

router.post("/passports/:passportId/primary", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const profile: any = await loadOwnProfile(consumerId);

    const passport = profile.passports.id(req.params.passportId);
    if (!passport) return res.status(404).json({ error: "Passport not found" });

    normalisePrimary(profile, String(passport._id));
    await profile.save();

    return res.json({ ok: true, profile: publicProfile(profile, req.consumer) });
  } catch (err: any) {
    console.error("[consumer passport primary]", err?.message);
    return res.status(500).json({ error: "Failed to set primary passport" });
  }
});

router.delete("/passports/:passportId", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const profile: any = await loadOwnProfile(consumerId);

    const passport = profile.passports.id(req.params.passportId);
    if (!passport) return res.status(404).json({ error: "Passport not found" });

    passport.deleteOne();
    // Removing the primary promotes another, so the profile never ends up
    // with passports but no primary.
    normalisePrimary(profile);
    await profile.save();

    return res.json({ ok: true, profile: publicProfile(profile, req.consumer) });
  } catch (err: any) {
    console.error("[consumer passport DELETE]", err?.message);
    return res.status(500).json({ error: "Failed to delete passport" });
  }
});

/* ── Co-travellers ─────────────────────────────────────────────────── */

const CO_TRAVELLER_FIELDS = [
  "fullName",
  "relationship",
  "dateOfBirth",
  "passportNumber",
  "passportExpiryDate",
  "nationality",
];

router.post("/co-travellers", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const profile: any = await loadOwnProfile(consumerId);

    profile.coTravellers.push(pick(req.body, CO_TRAVELLER_FIELDS));
    await profile.save();

    return res.status(201).json({ ok: true, profile: publicProfile(profile, req.consumer) });
  } catch (err: any) {
    console.error("[consumer co-traveller POST]", err?.message);
    return res.status(500).json({ error: "Failed to add co-traveller" });
  }
});

router.patch("/co-travellers/:coTravellerId", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const profile: any = await loadOwnProfile(consumerId);

    const row = profile.coTravellers.id(req.params.coTravellerId);
    if (!row) return res.status(404).json({ error: "Co-traveller not found" });

    Object.assign(row, pick(req.body, CO_TRAVELLER_FIELDS));
    await profile.save();

    return res.json({ ok: true, profile: publicProfile(profile, req.consumer) });
  } catch (err: any) {
    console.error("[consumer co-traveller PATCH]", err?.message);
    return res.status(500).json({ error: "Failed to update co-traveller" });
  }
});

router.delete("/co-travellers/:coTravellerId", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const profile: any = await loadOwnProfile(consumerId);

    const row = profile.coTravellers.id(req.params.coTravellerId);
    if (!row) return res.status(404).json({ error: "Co-traveller not found" });

    row.deleteOne();
    await profile.save();

    return res.json({ ok: true, profile: publicProfile(profile, req.consumer) });
  } catch (err: any) {
    console.error("[consumer co-traveller DELETE]", err?.message);
    return res.status(500).json({ error: "Failed to delete co-traveller" });
  }
});

/* ── Documents — the shared locker ─────────────────────────────────── */

router.get("/documents", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const docs = await ConsumerDocument.find({
      consumerId: new mongoose.Types.ObjectId(consumerId),
      deletedAt: null,
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      ok: true,
      documents: docs.map(publicDocument),
      categories: CONSUMER_DOCUMENT_CATEGORIES,
      storage: storageDescription(),
    });
  } catch (err: any) {
    console.error("[consumer documents GET]", err?.message);
    return res.status(500).json({ error: "Failed to list documents" });
  }
});

router.post("/documents", documentUploadMw, async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({ error: "File is required" });
    }

    const category = String(req.body?.category ?? "OTHER").trim().toUpperCase();
    if (!CONSUMER_DOCUMENT_CATEGORIES.includes(category as any)) {
      return res.status(400).json({
        error: `category must be one of: ${CONSUMER_DOCUMENT_CATEGORIES.join(", ")}`,
      });
    }

    // The key embeds the consumer id, so bytes land in a per-consumer path
    // whichever driver is active.
    const stored = await putConsumerDocument({
      buffer: file.buffer,
      mime: file.mimetype,
      originalName: file.originalname,
      consumerId,
    });

    const doc = await ConsumerDocument.create({
      consumerId: new mongoose.Types.ObjectId(consumerId),
      workspaceId: d2cWorkspaceObjectId(),
      category,
      docCode: String(req.body?.docCode ?? "").trim() || undefined,
      label: String(req.body?.label ?? "").trim() || undefined,
      driver: stored.driver,
      storageKey: stored.storageKey,
      bucket: stored.bucket,
      originalFilename: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    });

    return res.status(201).json({ ok: true, document: publicDocument(doc) });
  } catch (err: any) {
    console.error("[consumer documents POST]", err?.message);
    return res.status(500).json({ error: err?.message || "Failed to upload document" });
  }
});

/**
 * The bytes.
 *
 * Streamed through this handler rather than handed out as a presigned URL,
 * because a presigned URL is a bearer credential that outlives the session
 * and can be forwarded. For passport scans, re-checking ownership on every
 * byte request is worth the bandwidth.
 */
router.get("/documents/:documentId/file", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    if (!isValidId(req.params.documentId)) {
      return res.status(404).json({ error: "Document not found" });
    }

    const doc: any = await ConsumerDocument.findOne({
      _id: req.params.documentId,
      // THE OWNERSHIP CLAUSE. Not a post-hoc check on the loaded row — part
      // of the query, so a row belonging to someone else is never loaded.
      consumerId: new mongoose.Types.ObjectId(consumerId),
      deletedAt: null,
    }).lean();

    if (!doc) return res.status(404).json({ error: "Document not found" });

    const stream = await openConsumerDocument(doc);
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(doc.originalFilename).replace(/"/g, "")}"`,
    );
    // The bytes are personal data; no shared cache may hold them.
    res.setHeader("Cache-Control", "private, no-store");

    stream.on("error", (streamErr: any) => {
      console.error("[consumer document stream]", streamErr?.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to read document" });
      else res.end();
    });
    stream.pipe(res);
  } catch (err: any) {
    console.error("[consumer document file]", err?.message);
    return res.status(500).json({ error: "Failed to read document" });
  }
});

/**
 * SOFT delete — see models/ConsumerDocument.ts.
 *
 * The row stays and the bytes stay, because an application may reference
 * this document; hard-deleting would break it retroactively. The consumer
 * stops seeing it, which is what "delete" means on this screen. True
 * erasure belongs to the account-deletion path (DPDP), which must also
 * remove the bytes.
 */
router.delete("/documents/:documentId", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    if (!isValidId(req.params.documentId)) {
      return res.status(404).json({ error: "Document not found" });
    }

    const result = await ConsumerDocument.findOneAndUpdate(
      {
        _id: req.params.documentId,
        consumerId: new mongoose.Types.ObjectId(consumerId),
        deletedAt: null,
      },
      { $set: { deletedAt: new Date() } },
      { new: true },
    );

    if (!result) return res.status(404).json({ error: "Document not found" });

    // A deleted document must not stay referenced as a passport scan, or the
    // passport tab would render a broken thumbnail forever.
    await ConsumerProfile.updateOne(
      { consumerId: new mongoose.Types.ObjectId(consumerId) },
      {
        $unset: {
          "passports.$[front].frontDocumentId": "",
        },
      },
      { arrayFilters: [{ "front.frontDocumentId": result._id }] },
    );
    await ConsumerProfile.updateOne(
      { consumerId: new mongoose.Types.ObjectId(consumerId) },
      { $unset: { "passports.$[back].backDocumentId": "" } },
      { arrayFilters: [{ "back.backDocumentId": result._id }] },
    );

    return res.json({ ok: true, id: String(result._id) });
  } catch (err: any) {
    console.error("[consumer documents DELETE]", err?.message);
    return res.status(500).json({ error: "Failed to delete document" });
  }
});

/* ── Account & Security — the parts that are REAL ──────────────────── */

/**
 * Logout All Devices. REAL revocation, not a UI gesture.
 *
 * $inc on tokenVersion invalidates every outstanding access AND refresh
 * token for this consumer at their next use (middleware/requireConsumer.ts).
 * Including the caller's own — which is correct: "log out everywhere" that
 * left the current device signed in would be a lie.
 */
router.post("/account/logout-all", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    await Consumer.updateOne({ _id: consumerId }, { $inc: { tokenVersion: 1 } });
    return res.json({ ok: true, revoked: true });
  } catch (err: any) {
    console.error("[consumer logout-all]", err?.message);
    return res.status(500).json({ error: "Failed to revoke sessions" });
  }
});

/**
 * Download My Data (DPDP). Real: assembles everything this module stores
 * about the caller, from their own rows only.
 *
 * Document BYTES are not included — only the metadata and the per-document
 * URL the consumer can already fetch. Streaming a zip of passport scans
 * through an endpoint that returns JSON is a different piece of work.
 */
router.get("/account/export", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const profile = await loadOwnProfile(consumerId);
    const docs = await ConsumerDocument.find({
      consumerId: new mongoose.Types.ObjectId(consumerId),
      deletedAt: null,
    }).lean();

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", 'attachment; filename="helloviza-my-data.json"');
    res.setHeader("Cache-Control", "private, no-store");

    return res.send(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          account: {
            email: req.consumer.email,
            name: req.consumer.name,
          },
          profile: publicProfile(profile, req.consumer),
          documents: docs.map(publicDocument),
        },
        null,
        2,
      ),
    );
  } catch (err: any) {
    console.error("[consumer export]", err?.message);
    return res.status(500).json({ error: "Failed to export data" });
  }
});

export default router;
