// apps/backend/src/plugins/emptyEnumToUnset.plugin.ts
//
// An empty string on an enum path means "not set", and is stored as unset.
// Same shape as plugins/fieldEncryption.plugin.ts and plugins/
// workspaceScope.plugin.ts — a schema opts in with one line:
//
//     MySchema.plugin(emptyEnumToUnsetPlugin);
//
// ══ THE BUG THIS EXISTS TO CLOSE ══════════════════════════════════════
// Mongoose skips enum validation for `undefined` and `null`, but it does
// NOT skip it for `""` — the empty string is a value, and it is not in any
// of our enum lists. So this save:
//
//     profile.personal.maritalStatus = "";
//     await profile.save();
//
// throws
//
//     ConsumerProfile validation failed: personal.maritalStatus:
//     `` is not a valid enum value for path `maritalStatus`.
//
// which the route turns into a 500.
//
// That is not a hypothetical. The consumer profile's selects render an
// empty first option (`<option value="">—</option>`) and their drafts
// initialise with `?? ""`, so an untouched optional dropdown submits `""`
// on EVERY save. Two paths reached it in production code:
//
//   1. Any save of the Personal section by someone who never picked a
//      marital status — the whole draft is sent, not a diff, so the key is
//      always present.
//   2. UNTICKING "Business Class" or "Window Seat" on the Travel tab,
//      which writes `{ cabinClass: "" }` deliberately.
//
// ══ WHY A PLUGIN AND NOT A FIX AT THE ROUTE ═══════════════════════════
// routes/consumer.profile.ts funnels every section write through one
// `pick()` allowlist, so a coercion there would have reached all of them
// today. It would not reach a script, a seed, an importer or the next
// route — and it would have to be enum-AWARE, because `""` is meaningful
// on the free-text fields sitting beside these (clearing a middle name is
// how you erase it). Doing it here means the rule lives with the schema
// that declares the enums, applies to every writer, and cannot drift out
// of step with the field list because it does not keep one.
//
// ══ WHAT IT DELIBERATELY DOES NOT TOUCH ═══════════════════════════════
// See shouldCoerce() below. The short version: a path whose schema says it
// ALWAYS holds a value — `required: true`, or a `default` — is left alone,
// because unsetting it would contradict the declaration. On
// ConsumerProfile that is exactly `passports[].type`, which declares
// `default: "ORDINARY"`; stripping it would leave a passport with no type.
//
// A consequence worth stating plainly: `""` on passports[].type still
// fails validation. The passport form offers an empty "—" option for that
// field, so that path is still reachable — fixing the form is a separate
// change, and this plugin is not a licence to skip it.
import type { Schema } from "mongoose";

/** Marks a SchemaType we have already wrapped, so a double `.plugin()`
 *  registration cannot stack two setters on one path. */
const COERCED = Symbol("emptyEnumToUnset");

/**
 * Whether this path should treat `""` as unset.
 *
 * Three ways to be excluded, and each is a statement the schema already
 * makes — none of them is a list this file has to maintain:
 *
 *   - no enum at all           → `""` is ordinary text, and clearing a
 *                                free-text field by sending `""` is a
 *                                thing callers legitimately do
 *   - `""` is IN the enum      → the schema has declared empty a valid
 *                                value (ManualBooking.subStatus and
 *                                TravelForm do this), so unsetting it
 *                                would fight the declaration
 *   - required, or has a default → the schema says this path always holds
 *                                a value; see the header on
 *                                passports[].type
 */
function shouldCoerce(schemaType: any): boolean {
  const values = schemaType?.enumValues;
  if (!Array.isArray(values) || values.length === 0) return false;
  if (values.includes("")) return false;
  if (schemaType.isRequired) return false;
  // `options.default` rather than `defaultValue`: it reflects what the
  // field DECLARED, and reads the same way as the schema line it came from.
  if (schemaType.options?.default !== undefined) return false;
  return true;
}

/**
 * Walks a schema and every sub-schema under it.
 *
 * The recursion is the whole reason this is not three lines: a Mongoose
 * plugin applies to the schema it is registered on and NOT to that
 * schema's children, and on ConsumerProfile every enum without exception
 * lives in a child — personal, travel and travelPreferences are
 * single-nested sub-schemas, passports and coTravellers are document
 * arrays. Registering without recursing would have been a no-op that
 * looked like a fix.
 *
 * `seen` guards shared sub-schemas: AddressSchema is embedded twice
 * (current + permanent) as the SAME Schema object, so its paths would
 * otherwise be visited — and wrapped — twice.
 */
function walk(schema: Schema, seen: Set<Schema>): void {
  if (seen.has(schema)) return;
  seen.add(schema);

  schema.eachPath((_path: string, schemaType: any) => {
    const child: Schema | undefined = schemaType?.schema;
    if (child) {
      walk(child, seen);
      return;
    }
    if (schemaType[COERCED]) return;
    if (!shouldCoerce(schemaType)) return;

    schemaType[COERCED] = true;
    /* Mongoose runs setters LAST-ADDED-FIRST, so this one sees the raw
     * assigned value before any trim/uppercase declared on the field. That
     * ordering is irrelevant for the enum paths here (none declare other
     * setters) but it is the safe direction: `""` is decided before
     * anything else can transform it into something that is no longer
     * recognisably empty. */
    schemaType.set((v: unknown) => (v === "" ? undefined : v));
  });
}

export function emptyEnumToUnsetPlugin(schema: Schema): void {
  walk(schema, new Set<Schema>());
}

export default emptyEnumToUnsetPlugin;
