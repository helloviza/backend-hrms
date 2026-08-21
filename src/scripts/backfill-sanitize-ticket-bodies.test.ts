// apps/backend/src/scripts/backfill-sanitize-ticket-bodies.test.ts
//
// A backfill is a bulk overwrite of a collection nobody re-reads afterwards.
// The two things that make one safe are asserted here rather than assumed:
//
//   1. It changes ONLY what is dirty. A clean row must come back
//      byte-identical — if the sanitizer normalises harmless markup, the
//      backfill rewrites the entire collection and the diff becomes
//      unreviewable.
//   2. It is idempotent. Run twice, the second run changes nothing. Without
//      that, a re-run after a partial failure is a second mutation.
//
// Real Mongo, no mocks.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/backfill-sanitize-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

const { backfillTicketBodies } = await import("./backfill-sanitize-ticket-bodies.js");

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.collection("ticketmessages").deleteMany({});
});

const CLEAN_EMAIL =
  `<div dir="ltr"><table width="100%" border="1"><tbody><tr>` +
  `<td style="padding:6px">PNR</td><td>ABC123</td></tr></tbody></table></div>`;

const CLEAN_PORTAL = `<p>Your documents are <strong>verified</strong>.</p>`;

const DIRTY = `<p>Delayed flight</p><img src=x onerror=alert(1)><script>alert(2)</script>`;

async function seed(rows: Array<{ channel: string; bodyHtml: string }>) {
  await mongoose.connection.db!.collection("ticketmessages").insertMany(
    rows.map((r) => ({ ...r, direction: "INBOUND", createdAt: new Date() })),
  );
}

async function bodies(): Promise<string[]> {
  const docs = await mongoose.connection
    .db!.collection("ticketmessages")
    .find({}, { projection: { bodyHtml: 1 } })
    .sort({ _id: 1 })
    .toArray();
  return docs.map((d) => String((d as any).bodyHtml));
}

describe("backfill-sanitize-ticket-bodies", () => {
  it("cleans a dirty row and leaves clean rows byte-identical", async () => {
    await seed([
      { channel: "EMAIL", bodyHtml: CLEAN_EMAIL },
      { channel: "EMAIL", bodyHtml: DIRTY },
      { channel: "PORTAL", bodyHtml: CLEAN_PORTAL },
    ]);

    const counts = await backfillTicketBodies(mongoose.connection.db!, true);

    expect(counts.scanned).toBe(3);
    expect(counts.changed).toBe(1);
    expect(counts.unchanged).toBe(2);
    // The one changed row genuinely had markup removed, not just re-spelled.
    expect(counts.normalizedOnly).toBe(0);

    const [email, dirty, portal] = await bodies();
    expect(email).toBe(CLEAN_EMAIL);
    expect(portal).toBe(CLEAN_PORTAL);
    expect(dirty).not.toMatch(/<script/i);
    expect(dirty).not.toMatch(/\son[a-z]+\s*=/i);
    expect(dirty).toContain("Delayed flight");
  });

  it("is idempotent — a second run changes nothing", async () => {
    await seed([
      { channel: "EMAIL", bodyHtml: CLEAN_EMAIL },
      { channel: "EMAIL", bodyHtml: DIRTY },
      { channel: "PORTAL", bodyHtml: CLEAN_PORTAL },
    ]);

    await backfillTicketBodies(mongoose.connection.db!, true);
    const afterFirst = await bodies();

    const second = await backfillTicketBodies(mongoose.connection.db!, true);

    expect(second.scanned).toBe(3);
    expect(second.changed).toBe(0);
    expect(second.unchanged).toBe(3);
    expect(await bodies()).toEqual(afterFirst);
  });

  it("labels an entity re-spelling as normalized, not as markup removal", async () => {
    // `&#39;` comes back as a literal apostrophe. It renders identically, so
    // the rewrite is lossless — but it must not be reported as if a payload
    // had been stripped, or the production run's diff becomes unreadable.
    await seed([{ channel: "EMAIL", bodyHtml: `<p>Consumer B&#39;s case.</p>` }]);

    const counts = await backfillTicketBodies(mongoose.connection.db!, true);

    expect(counts.changed).toBe(1);
    expect(counts.normalizedOnly).toBe(1);
    expect((await bodies())[0]).toBe(`<p>Consumer B's case.</p>`);
  });

  it("dry run reports what it would change but writes nothing", async () => {
    await seed([{ channel: "EMAIL", bodyHtml: DIRTY }]);

    const counts = await backfillTicketBodies(mongoose.connection.db!, false);

    expect(counts.changed).toBe(1);
    expect((await bodies())[0]).toBe(DIRTY); // untouched on disk
  });

  it("applies the EMAIL profile to mail and STRICT to agent-authored rows", async () => {
    // The same table survives on an EMAIL row and is flattened on a PORTAL
    // row, because a consumer's browser has no business rendering one.
    await seed([
      { channel: "EMAIL", bodyHtml: CLEAN_EMAIL },
      { channel: "PORTAL", bodyHtml: CLEAN_EMAIL },
    ]);

    await backfillTicketBodies(mongoose.connection.db!, true);

    const [email, portal] = await bodies();
    expect(email).toBe(CLEAN_EMAIL);
    expect(portal).not.toMatch(/<table/i);
    expect(portal).toContain("ABC123");
  });
});
