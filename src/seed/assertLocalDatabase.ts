// apps/backend/src/seed/assertLocalDatabase.ts
//
// The guard that keeps a seed script off a real cluster.
//
// This lived inline in seed-dev.ts and is now shared, because the SECOND seed
// script (seed-consumer-dev.ts) needs exactly the same refusal and a safety
// check that exists in two hand-copied versions is a safety check that will
// drift. One definition, imported by both.
//
// It refuses by DEFAULT — the test is on the host, so a remote provider
// nobody has thought of yet is rejected without needing to be listed
// anywhere.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"]);

export function assertLocalDatabase(uri: string): void {
  if (!uri) {
    throw new Error(
      "MONGO_URI is empty. Copy apps/backend/.env.development.example to .env.development.",
    );
  }

  // mongodb+srv is Atlas-shaped by definition — never local. Rejected before
  // parsing, because the SRV form has no port and parses oddly.
  if (uri.startsWith("mongodb+srv://")) {
    throw new Error(
      "REFUSING TO SEED: MONGO_URI is a mongodb+srv:// (Atlas) connection string.\n" +
        "This script only ever runs against a local database. Check that\n" +
        "NODE_ENV=development and apps/backend/.env.development exists — see docs/dev-setup.md.",
    );
  }

  let hosts: string[];
  try {
    // Strip the scheme and any credentials, then take the host list.
    const afterScheme = uri.replace(/^mongodb:\/\//, "");
    const afterCreds = afterScheme.includes("@")
      ? afterScheme.slice(afterScheme.indexOf("@") + 1)
      : afterScheme;
    hosts = afterCreds
      .split("/")[0]
      .split(",")
      .map((h) => h.split(":")[0].trim().toLowerCase());
  } catch {
    throw new Error(`REFUSING TO SEED: could not parse MONGO_URI to verify it is local.`);
  }

  const remote = hosts.filter((h) => !LOCAL_HOSTS.has(h));
  if (remote.length) {
    throw new Error(
      `REFUSING TO SEED: MONGO_URI points at a non-local host (${remote.join(", ")}).\n` +
        "This script only ever runs against a local database. See docs/dev-setup.md.",
    );
  }
}

export default assertLocalDatabase;
