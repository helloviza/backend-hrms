// apps/backend/src/routes/consumer.saved.ts
//
// The consumer's saved countries. Mounted at /api/consumer/saved.
//
// ══════════════════════════════════════════════════════════════════════
// THE ONE RULE, AS EVERYWHERE ELSE: THE CONSUMER ID COMES FROM
// req.consumer.id. ALWAYS.
// ══════════════════════════════════════════════════════════════════════
// Never from a route param, a query string or a body field. The only
// caller-supplied value any handler here reads is an ISO-3166-1 alpha-2
// code, which is validated against the static catalogue before it is
// stored — so the worst a malicious body can do is ask for a country
// that does not exist, and get a 400.
//
// ── ENRICHMENT HAPPENS HERE, NOT ON THE CLIENT ───────────────────────
// A stored row is `{consumerId, iso2, source}` — three fields, none of
// them displayable. The name, visa category and difficulty a card needs
// come from config/visaCountrySeed.ts and utils/visaDifficulty.ts, the
// SAME two modules routes/public.visa.ts builds the world map from.
//
// Doing it server-side rather than shipping bare codes is the cheaper
// AND the more correct half of that choice:
//   - cheaper: these are in-process lookups over static config. No DB
//     read, no second round trip. The alternative is a client fetching
//     all 196 destinations to label three saves.
//   - correct: one join, in the one place that already owns the
//     catalogue vocabulary. A client-side join is a second copy of
//     "what does difficulty mean", and it goes stale the day the rubric
//     moves.
import { Router } from "express";
import mongoose from "mongoose";

import { requireConsumer } from "../middleware/requireConsumer.js";
import SavedCountry, { SAVED_COUNTRY_SOURCES } from "../models/SavedCountry.js";
import { d2cWorkspaceObjectId } from "../services/consumerWorkspace.js";
import { findSeedCountry } from "../config/visaCountrySeed.js";
import { difficultyFor } from "../utils/visaDifficulty.js";
import VisaRule from "../models/VisaRule.js";

/**
 * The nationality the public catalogue is authored for.
 *
 * Declared here as a local constant exactly as routes/public.visa.ts and
 * routes/consumer.applications.ts each do — the third copy of a value
 * that is one word and, more importantly, is the SAME word by
 * coincidence of the current product rather than by a shared rule. When
 * a second nationality ships, each of these three sites has a different
 * question to answer about where its value comes from.
 *
 * What must NOT differ is that this file's `serviced` and the map's
 * `serviced` are computed from the same filter. They are: PUBLISHED +
 * this nationality, on VisaRule.
 */
const PUBLIC_NATIONALITY = "IN";

const router = Router();

// EVERY route in this file. Mounted here rather than per-route so a new
// handler cannot be added unguarded.
router.use(requireConsumer);

/** The ONLY source of the acting consumer's id in this file. */
function me(req: any): string {
  const id = req?.consumer?.id;
  if (!id) {
    throw new Error("consumer.saved: reached a handler with no req.consumer");
  }
  return String(id);
}

/**
 * Validates and normalises a caller-supplied country code.
 *
 * Returns the canonical uppercase code, or null if the catalogue does
 * not carry it. Validating against the SEED rather than against a regex
 * matters: `/^[A-Z]{2}$/` accepts "ZZ", which would store a bookmark for
 * a country that can never render and can never be explored.
 */
function canonicalIso2(raw: unknown): string | null {
  const code = String(raw ?? "").trim().toUpperCase();
  if (code.length !== 2) return null;
  return findSeedCountry(code) ? code : null;
}

/* ── GET / — the saved list, enriched ───────────────────────────────── */

router.get("/", async (req: any, res: any) => {
  try {
    const consumerId = me(req);

    const rows = await SavedCountry.find({
      consumerId: new mongoose.Types.ObjectId(consumerId),
    })
      .sort({ createdAt: -1 })
      .lean();

    /**
     * WHICH SAVED CORRIDORS WE ACTUALLY RUN.
     *
     * `serviced` on the map means a PUBLISHED VisaRule exists for
     * IN -> iso2, and the saved card uses it for exactly what the map
     * uses it for: whether "Start application" is an honest link or
     * whether the only honest action is "Explore". One query for the
     * whole list rather than one per row.
     *
     * A failure here must not take the list down — the saves are the
     * subject, this is a decoration on them — so it degrades to an empty
     * set and every card renders as unserviced, which is the
     * conservative direction to be wrong in.
     */
    let servicedCodes = new Set<string>();
    try {
      const codes = rows.map((r: any) => r.iso2);
      if (codes.length) {
        const published = await VisaRule.find({
          destinationIso2: { $in: codes },
          status: "PUBLISHED",
          nationality: PUBLIC_NATIONALITY,
        })
          .select("destinationIso2")
          .lean();
        servicedCodes = new Set(published.map((r: any) => String(r.destinationIso2).toUpperCase()));
      }
    } catch (err: any) {
      console.warn("[consumer saved] serviced lookup failed:", err?.message);
    }

    const countries = rows
      .map((row: any) => {
        const seed = findSeedCountry(row.iso2);
        /* A code the catalogue no longer carries is DROPPED, not rendered
         * blank. There is nothing true to put on a card whose country has
         * left the seed — no name, no category, no difficulty — and a row
         * of dashes is worse than an absence. The stored row survives, so
         * if the country returns so does the save. */
        if (!seed) return null;

        return {
          iso2: row.iso2,
          countryName: seed.countryName,
          visaCategory: seed.visaCategory,
          difficulty: difficultyFor(row.iso2, seed.visaCategory),
          continent: seed.continent,
          serviced: servicedCodes.has(row.iso2),
          source: row.source,
          savedAt: row.createdAt,
        };
      })
      .filter(Boolean);

    return res.json({ ok: true, countries });
  } catch (err: any) {
    console.error("[consumer saved GET]", err?.message);
    return res.status(500).json({ error: "Failed to load saved countries" });
  }
});

/* ── POST / — save, idempotently ────────────────────────────────────── */

/**
 * ALREADY SAVED IS A SUCCESS, NOT AN ERROR.
 *
 * Both callers depend on this. The heart toggle can be double-clicked,
 * and the apply-flow save fires on a page a reader may open repeatedly
 * for a country they bookmarked by hand months ago. Neither should ever
 * see a failure for asking for a state that already holds.
 *
 * Implemented as an upsert-on-the-unique-index rather than
 * find-then-insert, because find-then-insert loses the race: two
 * concurrent clicks both find nothing and both insert. Here the second
 * one either updates nothing or trips E11000, and both mean "the row
 * exists", which is what the caller asked for.
 *
 * ── WHY $setOnInsert AND NOT $set ────────────────────────────────────
 * `source` records how a country FIRST came to be saved. A reader who
 * bookmarks Thailand by hand and later opens its apply flow has not
 * stopped having bookmarked it by hand — overwriting "manual" with
 * "get-started" would erase the more deliberate of the two signals, and
 * it is the deliberate one that is worth keeping.
 */
router.post("/", async (req: any, res: any) => {
  try {
    const consumerId = me(req);

    const iso2 = canonicalIso2(req.body?.iso2);
    if (!iso2) {
      return res.status(400).json({ error: "A known 2-letter country code is required" });
    }

    const requested = String(req.body?.source ?? "manual").trim();
    const source = (SAVED_COUNTRY_SOURCES as readonly string[]).includes(requested)
      ? requested
      : "manual";

    const _id = new mongoose.Types.ObjectId(consumerId);

    try {
      await SavedCountry.updateOne(
        { consumerId: _id, iso2 },
        {
          $setOnInsert: {
            consumerId: _id,
            iso2,
            source,
            workspaceId: d2cWorkspaceObjectId(),
          },
        },
        { upsert: true },
      );
    } catch (err: any) {
      // E11000 — a concurrent request won the race. The row exists, which
      // is exactly the postcondition this endpoint promises.
      if (err?.code !== 11000) throw err;
    }

    const row: any = await SavedCountry.findOne({ consumerId: _id, iso2 }).lean();
    const seed = findSeedCountry(iso2)!;

    return res.status(201).json({
      ok: true,
      country: {
        iso2,
        countryName: seed.countryName,
        visaCategory: seed.visaCategory,
        difficulty: difficultyFor(iso2, seed.visaCategory),
        continent: seed.continent,
        source: row?.source ?? source,
        savedAt: row?.createdAt ?? null,
      },
    });
  } catch (err: any) {
    console.error("[consumer saved POST]", err?.message);
    return res.status(500).json({ error: "Failed to save that country" });
  }
});

/* ── DELETE /:iso2 — unsave ─────────────────────────────────────────── */

/**
 * Also idempotent: removing something that is not saved returns 200.
 *
 * The alternative — 404 for "you had not saved this" — would make an
 * un-heart that raced with another tab look like a failure, and there is
 * no state a caller could reach on the 404 that differs from the state
 * they reach on the 200. The postcondition is "this country is not
 * saved", and it holds either way.
 *
 * THE OWNERSHIP CLAUSE is part of the query, not a check on a loaded
 * row, so another consumer's save is never matched — the delete simply
 * removes nothing, and the response is the same 200 it would give for a
 * code you had never saved. It reveals nothing about whether the row
 * exists for somebody else.
 */
router.delete("/:iso2", async (req: any, res: any) => {
  try {
    const consumerId = me(req);

    const code = String(req.params.iso2 ?? "").trim().toUpperCase();
    if (code.length !== 2) {
      return res.status(400).json({ error: "A 2-letter country code is required" });
    }

    await SavedCountry.deleteOne({
      consumerId: new mongoose.Types.ObjectId(consumerId),
      iso2: code,
    });

    return res.json({ ok: true, iso2: code });
  } catch (err: any) {
    console.error("[consumer saved DELETE]", err?.message);
    return res.status(500).json({ error: "Failed to remove that country" });
  }
});

export default router;
