// Coverage for the hand-rolled half of GeoLite2 provisioning.
//
// The download itself needs a MaxMind licence key and pulls ~70 MB, so it is
// not something a test suite should do. What IS worth pinning is the tar
// walking: it is raw 512-byte-block arithmetic, and getting it wrong doesn't
// throw — it writes a plausible-looking, corrupt .mmdb to disk that then
// satisfies the existsSync() fast path forever. The archives below are built
// byte-by-byte here rather than fetched, so the assertions are about our
// parser and nothing else.

import { describe, it, expect } from "vitest";
import { findMmdbInTar, buildDateFromMemberName, GEOLITE2_ATTRIBUTION, GEOIP_DB_PATH } from "./geoipProvision.js";

/** A single POSIX (ustar) tar member: 512-byte header + NUL-padded payload. */
function tarMember(name: string, payload: Buffer, typeFlag = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, "ascii");
  header.write("0000644\0", 100, "ascii"); // mode
  header.write("0000000\0", 108, "ascii"); // uid
  header.write("0000000\0", 116, "ascii"); // gid
  header.write(payload.length.toString(8).padStart(11, "0") + "\0", 124, "ascii"); // size, octal
  header.write("00000000000\0", 136, "ascii"); // mtime
  header.write("        ", 148, "ascii"); // checksum field, spaces while computing
  header.write(typeFlag, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");

  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

  const padded = Buffer.alloc(Math.ceil(payload.length / 512) * 512);
  payload.copy(padded);
  return Buffer.concat([header, padded]);
}

/** Members plus the two zero blocks a real archive ends with. */
function tarArchive(...members: Buffer[]): Buffer {
  return Buffer.concat([...members, Buffer.alloc(1024)]);
}

describe("findMmdbInTar", () => {
  it("extracts the .mmdb from an archive shaped like MaxMind's", () => {
    // The real layout: a directory entry, licence/readme files, then the data.
    const db = Buffer.from("MMDB-PAYLOAD-BYTES");
    const tar = tarArchive(
      tarMember("GeoLite2-City_20260804/", Buffer.alloc(0), "5"),
      tarMember("GeoLite2-City_20260804/COPYRIGHT.txt", Buffer.from("MaxMind")),
      tarMember("GeoLite2-City_20260804/LICENSE.txt", Buffer.from("EULA text")),
      tarMember("GeoLite2-City_20260804/GeoLite2-City.mmdb", db),
      tarMember("GeoLite2-City_20260804/README.txt", Buffer.from("readme")),
    );

    const found = findMmdbInTar(tar);
    expect(found?.name).toBe("GeoLite2-City_20260804/GeoLite2-City.mmdb");
    // Exact length, not just a prefix — an off-by-one in the block maths would
    // trail NUL padding into the payload and still "look right".
    expect(found!.data.length).toBe(db.length);
    expect(found!.data.equals(db)).toBe(true);
  });

  it("walks past members whose payload is not a whole number of blocks", () => {
    // 700 bytes occupies two blocks. If the walker advanced by the raw size
    // instead of the padded size it would land mid-payload and read garbage
    // as the next header.
    const db = Buffer.from("X".repeat(1500));
    const tar = tarArchive(
      tarMember("GeoLite2-City_20260804/README.txt", Buffer.from("Y".repeat(700))),
      tarMember("GeoLite2-City_20260804/GeoLite2-City.mmdb", db),
    );
    expect(findMmdbInTar(tar)!.data.equals(db)).toBe(true);
  });

  it("ignores a directory entry that ends in .mmdb", () => {
    // typeFlag '5' is a directory: it has no payload, and returning it would
    // write a zero-byte database.
    const db = Buffer.from("REAL");
    const tar = tarArchive(
      tarMember("weird/GeoLite2-City.mmdb/", Buffer.alloc(0), "5"),
      tarMember("weird/GeoLite2-City.mmdb", db),
    );
    expect(findMmdbInTar(tar)!.data.equals(db)).toBe(true);
  });

  it("returns null instead of throwing when the archive has no .mmdb", () => {
    const tar = tarArchive(tarMember("GeoLite2-City_20260804/README.txt", Buffer.from("nothing here")));
    expect(findMmdbInTar(tar)).toBeNull();
  });

  it("stops at the end-of-archive blocks rather than running off the buffer", () => {
    expect(findMmdbInTar(Buffer.alloc(1024))).toBeNull();
    expect(findMmdbInTar(Buffer.alloc(0))).toBeNull();
  });
});

describe("buildDateFromMemberName", () => {
  it("reads the build date out of the member path", () => {
    expect(buildDateFromMemberName("GeoLite2-City_20260804/GeoLite2-City.mmdb")).toBe("20260804");
  });

  it("is null when the path carries no date", () => {
    expect(buildDateFromMemberName("GeoLite2-City/GeoLite2-City.mmdb")).toBeNull();
  });
});

describe("licence and placement", () => {
  it("carries the attribution the GeoLite2 EULA requires", () => {
    expect(GEOLITE2_ATTRIBUTION).toContain("GeoLite2");
    expect(GEOLITE2_ATTRIBUTION).toContain("MaxMind");
  });

  it("puts the database under bin/, which is gitignored", () => {
    // ~70 MB and non-redistributable — it must never be committable.
    expect(GEOIP_DB_PATH.replace(/\\/g, "/")).toContain("/bin/GeoLite2-City.mmdb");
  });
});
