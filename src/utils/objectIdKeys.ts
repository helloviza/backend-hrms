// apps/backend/src/utils/objectIdKeys.ts
//
// ONE HELPER, EIGHT CALL SITES, ONE PRE-EXISTING 500.
//
// ══════════════════════════════════════════════════════════════════════
// THE BUG THIS EXISTS TO KILL
// ══════════════════════════════════════════════════════════════════════
// Every ops surface that joins applications to their parents does it the
// same way — collect the ids off the page, then one `$in` query:
//
//   const requestIds = [...new Set(pageDocs.map((a) => String(a.requestId)))];
//   await VisaRequest.find({ _id: { $in: requestIds } })
//
// `String(null)` is the four-character string "null", and Mongoose casts
// every element of an `$in` against the path's type. Casting "null" to an
// ObjectId THROWS:
//
//   CastError: Cast to ObjectId failed for value "null" (type string)
//                at path "_id"
//
// A query that throws takes the whole handler with it. So ONE row with a
// null id 500s the ENTIRE page — every other case on it included. The
// failure is not proportional to the bad data, which is what makes it
// worth a shared fix rather than eight local guards.
//
// ── THIS IS NOT A D2C BUG. IT IS ALREADY LIVE. ───────────────────────
// `travellerProfileId` has been nullable since scripts/erase-traveller-
// profile.ts shipped (models/VisaApplication.ts documents exactly why).
// GET /queue?includeErased=true selects those rows and then joins on
// them — so that query 500s today, before any D2C row exists. The D2C
// channel makes `requestId` nullable too and would have added a second
// way in.
//
// ── WHY FILTERING IS THE RIGHT FIX, NOT COALESCING ───────────────────
// The obvious alternative is to keep the id and let the lookup miss. But
// there is nothing to keep: a null id has no row to find. Everything
// downstream is ALREADY written for a miss —
//   requestById.get(String(a.requestId)) || null
//   computeRowRisk(a, request)  ->  assessProcessingRisk(r?.travelDateFrom, …)
//   travellerDisplayName(travellerById.get(…))  ->  "" for undefined
// — so dropping the id from the query changes nothing about the rendered
// row. It only stops the query from being asked an impossible question.
import mongoose from "mongoose";

/**
 * The distinct, castable ObjectId keys in `values`, as strings.
 *
 * Nulls, undefineds and anything that is not a valid ObjectId are
 * DROPPED rather than stringified into the query. Strings (not
 * ObjectIds) come back because every call site also builds a
 * `Map<string, row>` keyed by `String(row._id)` and looks up with
 * `String(a.field)` — keeping one representation avoids a second
 * conversion that could disagree at the boundary.
 *
 * Returns [] for an empty input, which callers can test to skip the
 * round trip entirely.
 */
export function objectIdKeys(values: Iterable<unknown>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (v == null) continue;
    const s = String(v);
    // isValidObjectId is the same predicate the routes' own id-parameter
    // validation uses, so a value this accepts is one Mongoose will cast
    // without throwing.
    if (mongoose.isValidObjectId(s)) out.add(s);
  }
  return [...out];
}
