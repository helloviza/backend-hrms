// apps/backend/src/models/Airport.ts
import { Schema, model, type Document } from "mongoose";

/**
 * Airport Master — the geographic reference table the carbon engine resolves
 * flight segments against.
 * ---------------------------------------------------------------------------
 * Seeded from OpenFlights `airports.dat` (https://openflights.org/data.php,
 * https://github.com/jpatokal/openflights — Open Database Licence), filtered to
 * rows that carry BOTH a well-formed 3-letter IATA code and usable coordinates.
 * 6,071 of the 7,698 source rows survive that filter; the rest are heliports,
 * rail stops and airstrips with no IATA code or no position, and an airport we
 * cannot place on the globe is of no use to a distance calculation.
 *
 * DELIBERATELY A REFERENCE TABLE, NOT A CACHE. Nothing writes to it at request
 * time. It is replaced wholesale by scripts/seed-carbon-reference.ts when the
 * upstream dataset is refreshed, which is why `source` and `sourceVersion` are
 * stored per row rather than assumed — a future partial re-seed from a second
 * dataset has to be able to say which row came from where.
 *
 * NOT WORKSPACE-SCOPED, and that is correct: the position of DEL is not a
 * tenant's private fact. Only CarbonRecord — the computed output — is
 * workspace-scoped. This collection is read by every tenant's calculation and
 * owned by none of them.
 *
 * `countryIso3` is resolved at seed time by joining the OpenFlights country
 * NAME against DEFRA's published "Haul definition" territory list (which is the
 * only ISO3 authority in this dataset pair). 6,018 of 6,071 airports match;
 * the 53 that do not are small island territories absent from DEFRA's list
 * (Kiribati, Micronesia, Bhutan, Antarctica and similar). A null here is not a
 * defect to paper over — it means the DEFRA haul band cannot be derived for a
 * UK-touching flight via this airport, and the engine degrades rather than
 * guessing. It has no effect at all on a flight that touches neither the UK nor
 * its Crown dependencies, because that flight's band does not depend on the
 * country at all (see services/carbonEngine.service.ts).
 */

export interface AirportDoc extends Document {
  iata: string;
  icao?: string | null;
  name?: string | null;
  city?: string | null;
  country?: string | null;
  countryIso3?: string | null;

  lat: number;
  lon: number;
  timezone?: string | null;

  source: string;
  sourceVersion: string;

  createdAt: Date;
  updatedAt: Date;
}

const AirportSchema = new Schema<AirportDoc>(
  {
    // Stored uppercase; the engine uppercases its lookup key to match. The
    // unique index below is what makes the seed re-runnable.
    iata: { type: String, required: true, uppercase: true, trim: true },
    icao: { type: String, default: null, uppercase: true, trim: true },

    name: { type: String, default: null },
    city: { type: String, default: null },
    country: { type: String, default: null },
    countryIso3: { type: String, default: null, uppercase: true, trim: true },

    // Decimal degrees, WGS84, as published by OpenFlights. Required because a
    // row without a position cannot serve this collection's only purpose.
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    timezone: { type: String, default: null },

    source: { type: String, required: true, default: "OpenFlights airports.dat" },
    sourceVersion: { type: String, required: true },
  },
  { timestamps: true },
);

// One row per IATA code, enforced by the database rather than by a
// read-then-write in the seed script. OpenFlights itself has no duplicate IATA
// codes in the filtered set (verified at build: 0 dropped), so this index
// records an invariant that already holds rather than papering over collisions.
AirportSchema.index({ iata: 1 }, { unique: true });

export const Airport = model<AirportDoc>("Airport", AirportSchema);

export default Airport;
