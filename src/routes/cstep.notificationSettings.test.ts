// apps/backend/src/routes/cstep.notificationSettings.test.ts
//
// CSTEP notification settings (routes/cstep.notificationSettings.ts) and the
// CSTEP mail transport they drive (services/cstepMailTransport.ts →
// services/emailOutbox.ts → utils/mailer.ts):
//   - every route is CSTEP-Admin only;
//   - the SMTP password is write-only: encrypted at rest, never returned,
//     kept / replaced / cleared exactly as asked, and a missing production
//     key fails the save with nothing stored;
//   - the change log names fields, never values;
//   - a CSTEP outbox row sends over that workspace's own SMTP server, a
//     DEFAULT row over the env transport exactly as before, and a workspace
//     without enabled settings sends nothing — no fallback.
//
// Real: the settings router, models, cstepMailTransport, emailOutbox,
//   utils/mailer, fieldCrypto; in-memory Mongo on a fresh database.
// Stubbed: nodemailer itself (records each transport's options and every
//   message, nothing leaves the process), auth (x-test-user) and the
//   workspace resolver (x-test-ws).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_notif_settings";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
process.env.DISABLE_EMAILS = "";
// The env (Plumtrips) transport — DEFAULT rows must keep using it.
process.env.SMTP_HOST = "smtp.plumtrips-default.local";
process.env.SMTP_USER = "default-user";
process.env.SMTP_PASS = "default-pass";
process.env.CSTEP_NOTIFICATIONS_ENABLED = "true";
delete process.env.CSTEP_SMTP_KEY;

const nm = vi.hoisted(() => ({
  transports: [] as any[],
  sent: [] as Array<{ transport: any; mail: any }>,
  closed: [] as any[],
  failNext: "" as string,
}));
vi.mock("nodemailer", () => {
  const createTransport = (opts: any) => {
    const t = {
      opts,
      async sendMail(mail: any) {
        if (nm.failNext) {
          const msg = nm.failNext;
          nm.failNext = "";
          throw new Error(msg);
        }
        nm.sent.push({ transport: opts, mail });
        return { messageId: `<qc-${nm.sent.length}@local>` };
      },
      close() {
        nm.closed.push(opts);
      },
    };
    nm.transports.push(opts);
    return t;
  };
  return { default: { createTransport }, createTransport };
});

const { default: settingsRouter } = await import("./cstep.notificationSettings.js");
const { default: CstepNotificationSettings } = await import("../models/cstep/CstepNotificationSettings.js");
const { decryptCstepSmtpPass } = await import("../services/cstepMailTransport.js");
const { enqueueEmail } = await import("../services/emailOutbox.js");

const DB = "cstep_qc_notif_settings";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const WS_BARE = oid(); // no settings at all
const U = { admin: oid(), user: oid() };
const who = (id: mongoose.Types.ObjectId, roles: string[]) => ({ _id: String(id), id: String(id), sub: String(id), roles });
const ADMIN = who(U.admin, ["ADMIN"]);
const USER = who(U.user, ["REQUESTER"]);

const app = express();
app.use(express.json());
app.use(
  "/api/cstep/notifications",
  (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.workspaceObjectId = new mongoose.Types.ObjectId(String(req.headers["x-test-ws"] || WS));
    next();
  },
  settingsRouter,
);
const call = (method: "get" | "put" | "post", as: any, path: string, body?: any, ws = WS) => {
  const r = request(app)[method](`/api/cstep/notifications${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(ws));
  return body === undefined ? r : r.send(body);
};

const PASSWORD = "Exch-App-Pass-1!";
const BASE = {
  senderMailbox: "Notify@CSTEP-qc.in",
  senderName: "CSTEP",
  replyTo: "travel@cstep-qc.in",
  smtpHost: "smtp.office365.com",
  smtpPort: 587,
  adminRecipients: ["admin1@cstep-qc.in", "ADMIN1@cstep-qc.in", "admin2@cstep-qc.in"],
  enabled: false,
};
const rawSettings = () => col("cstepnotificationsettings").findOne({ workspaceId: WS });

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);
  await mongoose.connection.syncIndexes();
  await col("users").insertMany([
    { _id: U.admin, email: "admin@qc.local", firstName: "Ada", lastName: "Admin" },
    { _id: U.user, email: "user@qc.local" },
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(() => {
  nm.sent.length = 0;
  nm.failNext = "";
});

describe("gating — CSTEP Admin only", () => {
  it("a non-Admin gets 403 on every route and nothing is written", async () => {
    expect((await call("get", USER, "/settings")).status).toBe(403);
    expect((await call("put", USER, "/settings", { ...BASE, smtpPass: PASSWORD })).status).toBe(403);
    expect((await call("post", USER, "/settings/test", { to: "x@qc.local" })).status).toBe(403);
    expect(await rawSettings()).toBeNull();
    expect(await col("cstepnotificationsettingschanges").countDocuments()).toBe(0);
  });

  it("an Admin reads defaults before anything is saved", async () => {
    const r = await call("get", ADMIN, "/settings");
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ enabled: false, senderMailbox: "", smtpPort: 587, adminRecipients: [], passwordSet: false });
    expect(r.body.changes).toEqual([]);
  });
});

describe("validation", () => {
  it.each([
    [{ senderMailbox: "not-an-email" }, /Sender mailbox/],
    [{ replyTo: "nope" }, /Reply-to/],
    [{ smtpHost: "smtp office365 com" }, /SMTP host/],
    [{ smtpPort: 0 }, /SMTP port/],
    [{ smtpPort: 70000 }, /SMTP port/],
    [{ adminRecipients: ["ok@qc.in", "bad"] }, /not an email address/],
    [{ adminRecipients: "a@qc.in" }, /must be a list/],
    [{ smtpPass: "x".repeat(257) }, /too long/],
    [{ enabled: "yes" }, /true or false/],
  ])("%o is refused", async (over, msg) => {
    const r = await call("put", ADMIN, "/settings", { ...BASE, ...over });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(msg);
  });

  it("turning it on needs a host, a mailbox and a password", async () => {
    const r = await call("put", ADMIN, "/settings", { ...BASE, enabled: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/set the sender mailbox, the SMTP host and the password first/);
    expect(await rawSettings()).toBeNull();
  });
});

describe("the password is write-only and encrypted at rest", () => {
  it("in production, a missing CSTEP_SMTP_KEY fails the save loudly and stores nothing", async () => {
    process.env.NODE_ENV = "production";
    try {
      const r = await call("put", ADMIN, "/settings", { ...BASE, smtpPass: PASSWORD });
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/could not be encrypted, so nothing was saved: CSTEP_SMTP_KEY is not set/);
    } finally {
      process.env.NODE_ENV = "test";
    }
    expect(await rawSettings()).toBeNull();
    expect(await col("cstepnotificationsettingschanges").countDocuments()).toBe(0);
  });

  it("a malformed CSTEP_SMTP_KEY fails the save in any environment", async () => {
    process.env.CSTEP_SMTP_KEY = Buffer.from("too-short").toString("base64");
    try {
      const r = await call("put", ADMIN, "/settings", { ...BASE, smtpPass: PASSWORD });
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/must decode to exactly 32 bytes/);
    } finally {
      delete process.env.CSTEP_SMTP_KEY;
    }
    expect(await rawSettings()).toBeNull();
  });

  let firstEnvelope = "";

  it("a save stores a fieldCrypto envelope bound to the workspace, and returns only passwordSet", async () => {
    const r = await call("put", ADMIN, "/settings", { ...BASE, smtpPass: PASSWORD });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(r.body)).not.toMatch(/penc\.|"smtpPassEnc"/);
    expect(r.body.settings).toMatchObject({
      senderMailbox: "notify@cstep-qc.in",
      adminRecipients: ["admin1@cstep-qc.in", "admin2@cstep-qc.in"],
      passwordSet: true,
      enabled: false,
    });

    const raw: any = await rawSettings();
    firstEnvelope = raw.smtpPassEnc;
    expect(firstEnvelope.startsWith("penc.1.")).toBe(true);
    expect(firstEnvelope).not.toContain(PASSWORD);
    expect(decryptCstepSmtpPass(firstEnvelope, WS)).toBe(PASSWORD);
    // Bound to its workspace: the same envelope does not decrypt as another one's.
    expect(() => decryptCstepSmtpPass(firstEnvelope, WS_BARE)).toThrow();

    const g = await call("get", ADMIN, "/settings");
    expect(JSON.stringify(g.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(g.body)).not.toMatch(/penc\./);
    expect(g.body.settings.passwordSet).toBe(true);
  });

  it("an empty / absent password keeps the stored one", async () => {
    ok(await call("put", ADMIN, "/settings", { ...BASE, smtpPass: "", senderName: "CSTEP Travel Desk" }));
    ok(await call("put", ADMIN, "/settings", { ...BASE, senderName: "CSTEP Travel Desk" }));
    const raw: any = await rawSettings();
    expect(raw.smtpPassEnc).toBe(firstEnvelope);
  });

  it("a new value replaces it", async () => {
    ok(await call("put", ADMIN, "/settings", { ...BASE, senderName: "CSTEP Travel Desk", smtpPass: "second-pass" }));
    const raw: any = await rawSettings();
    expect(raw.smtpPassEnc).not.toBe(firstEnvelope);
    expect(decryptCstepSmtpPass(raw.smtpPassEnc, WS)).toBe("second-pass");
  });

  it("clearPassword removes it (and cannot be combined with a new one)", async () => {
    expect((await call("put", ADMIN, "/settings", { ...BASE, smtpPass: "x", clearPassword: true })).status).toBe(400);
    const r = ok(await call("put", ADMIN, "/settings", { ...BASE, senderName: "CSTEP Travel Desk", clearPassword: true }));
    expect(r.body.settings.passwordSet).toBe(false);
    const raw: any = await rawSettings();
    expect(raw.smtpPassEnc).toBeUndefined();
  });
});

describe("the change log names fields, never values", () => {
  it("one row per save that changed something; values and the password never appear", async () => {
    const rows = await col("cstepnotificationsettingschanges").find({ workspaceId: WS }).sort({ changedAt: 1 }).toArray();
    // first save, senderName change (the "" save above changed it; the absent one did not), new password, clear.
    expect(rows.map((r: any) => r.fields)).toEqual([
      ["senderMailbox", "senderName", "replyTo", "smtpHost", "adminRecipients", "smtpPass"],
      ["senderName"],
      ["smtpPass"],
      ["smtpPass"],
    ]);
    const blob = JSON.stringify(rows);
    for (const v of [PASSWORD, "second-pass", "notify@cstep-qc.in", "smtp.office365.com", "admin1@cstep-qc.in", "CSTEP Travel Desk", "penc."]) {
      expect(blob).not.toContain(v);
    }
  });

  it("a save that changes nothing writes nothing", async () => {
    const before = await col("cstepnotificationsettingschanges").countDocuments();
    const r = ok(await call("put", ADMIN, "/settings", { ...BASE, senderName: "CSTEP Travel Desk" }));
    expect(r.body.changed).toEqual([]);
    expect(await col("cstepnotificationsettingschanges").countDocuments()).toBe(before);
  });

  it("GET lists the recent changes with the Admin's name", async () => {
    const g = ok(await call("get", ADMIN, "/settings"));
    expect(g.body.changes[0]).toMatchObject({ action: "UPDATE", fields: ["smtpPass"], changedByName: "Ada Admin" });
  });
});

describe("POST /settings/test", () => {
  it("refuses until a sender with a password is saved", async () => {
    const r = await call("post", ADMIN, "/settings/test", { to: "me@qc.local" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/password not set/);
    expect(nm.sent).toHaveLength(0);
  });

  it("sends one email through the CSTEP mailbox even while disabled, and logs a TEST row", async () => {
    ok(await call("put", ADMIN, "/settings", { ...BASE, senderName: "CSTEP Travel Desk", smtpPass: PASSWORD }));
    const r = ok(await call("post", ADMIN, "/settings/test", { to: "me@qc.local" }));
    expect(r.body.ok).toBe(true);
    expect(nm.sent).toHaveLength(1);
    const { transport, mail } = nm.sent[0];
    expect(transport).toMatchObject({
      host: "smtp.office365.com", port: 587, secure: false, requireTLS: true,
      auth: { user: "notify@cstep-qc.in", pass: PASSWORD },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    });
    expect(mail.from).toBe('"CSTEP Travel Desk" <notify@cstep-qc.in>');
    expect(mail.replyTo).toBe("travel@cstep-qc.in");
    expect(mail.to).toBe("me@qc.local");
    expect(mail.subject).toBe("[CSTEP Travel Desk] Test email — CSTEP notifications");
    // The CSTEP skin, multipart: no button (nothing to open), the sender's details in both parts.
    expect(mail.html).toMatch(/\/CSTEP-Logo_New\.png"/);
    expect(mail.html).not.toMatch(/logo\.png|hero-map|PLUMTRIPS|ops@plumtrips/);
    expect(mail.html).not.toMatch(/v:roundrect/);
    // The footer's contact address is the configured reply-to, never a hardcoded one.
    expect(mail.html).toContain('href="mailto:travel@cstep-qc.in"');
    expect(mail.text).toMatch(/\ntravel@cstep-qc\.in \| /);
    expect(mail.html + mail.text).not.toMatch(/travelnotification@cstep\.in/);
    expect(mail.text).toContain("Your notification sender is working");
    expect(mail.text).toContain("SMTP server: smtp.office365.com:587");
    const row: any = await col("cstepnotificationsettingschanges").find({ action: "TEST" }).sort({ changedAt: -1 }).next();
    expect(row).toMatchObject({ action: "TEST", testOk: true, fields: [] });
  });

  it("an SMTP failure comes back as the error, logged as a failed test", async () => {
    nm.failNext = "Invalid login: 535 5.7.139 Authentication unsuccessful";
    const r = await call("post", ADMIN, "/settings/test", { to: "me@qc.local" });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/535 5\.7\.139/);
    const row: any = await col("cstepnotificationsettingschanges").find({ action: "TEST" }).sort({ changedAt: -1 }).next();
    expect(row.testOk).toBe(false);
  });

  it("needs a valid address", async () => {
    expect((await call("post", ADMIN, "/settings/test", { to: "nope" })).status).toBe(400);
  });
});

describe("transport selection (emailOutbox → mailer)", () => {
  const msg = (over: any = {}) => ({ event: "qc_event", kind: "NOTIFICATIONS" as const, to: ["x@qc.local"], subject: "QC", html: "<p>qc</p>", ...over });

  it("a DEFAULT row uses the env transport, exactly as before", async () => {
    const r = await enqueueEmail(msg());
    expect(r.status).toBe("SENT");
    expect(nm.sent).toHaveLength(1);
    expect(nm.sent[0].transport.host).toBe("smtp.plumtrips-default.local");
    expect(nm.sent[0].mail.from).toMatch(/^Plumtrips Notification </);
    const row: any = await col("emailoutboxes").findOne({ _id: new mongoose.Types.ObjectId(r.id) });
    expect(row.transport).toBe("DEFAULT");
  });

  it("a CSTEP row with enabled settings uses that workspace's SMTP server and sender", async () => {
    ok(await call("put", ADMIN, "/settings", { ...BASE, senderName: "CSTEP Travel Desk", enabled: true }));
    const r = await enqueueEmail(msg({ transport: "CSTEP", workspaceId: WS, from: "ignored <x@y.z>" }));
    expect(r.status).toBe("SENT");
    expect(nm.sent).toHaveLength(1);
    expect(nm.sent[0].transport).toMatchObject({ host: "smtp.office365.com", auth: { user: "notify@cstep-qc.in", pass: PASSWORD } });
    expect(nm.sent[0].mail.from).toBe('"CSTEP Travel Desk" <notify@cstep-qc.in>');
    expect(nm.sent[0].mail.replyTo).toBe("travel@cstep-qc.in");
  });

  it("a row's plain-text part is stored and sent with its HTML (multipart); a row without one stays HTML-only", async () => {
    ok(await call("put", ADMIN, "/settings", { ...BASE, senderName: "CSTEP Travel Desk", enabled: true }));
    const r = await enqueueEmail(msg({ transport: "CSTEP", workspaceId: WS, text: "qc plain part" }));
    expect(r.status).toBe("SENT");
    expect(nm.sent[0].mail).toMatchObject({ html: "<p>qc</p>", text: "qc plain part" });
    const row: any = await col("emailoutboxes").findOne({ _id: new mongoose.Types.ObjectId(r.id) });
    expect(row.text).toBe("qc plain part");

    const r2 = await enqueueEmail(msg());
    expect(r2.status).toBe("SENT");
    expect(nm.sent[1].mail.text).toBeUndefined();
  });

  it("a settings change builds a new CSTEP transport and closes the old one", async () => {
    const before = nm.transports.length;
    ok(await call("put", ADMIN, "/settings", { ...BASE, senderName: "CSTEP Travel Desk", enabled: true, smtpPort: 465 }));
    await enqueueEmail(msg({ transport: "CSTEP", workspaceId: WS }));
    expect(nm.transports.length).toBe(before + 1);
    expect(nm.sent[0].transport).toMatchObject({ port: 465, secure: true, requireTLS: false });
    expect(nm.closed.some((o) => o.host === "smtp.office365.com" && o.port === 587)).toBe(true);
  });

  it("a workspace with no settings, or settings switched off, sends nothing — FAILED at once, no fallback, no desk alert", async () => {
    const r1 = await enqueueEmail(msg({ transport: "CSTEP", workspaceId: WS_BARE }));
    expect(r1).toMatchObject({ ok: false, status: "FAILED" });
    expect(r1.error).toMatch(/no CSTEP notification settings/);

    ok(await call("put", ADMIN, "/settings", { ...BASE, senderName: "CSTEP Travel Desk", enabled: false, smtpPort: 465 }));
    const r2 = await enqueueEmail(msg({ transport: "CSTEP", workspaceId: WS }));
    expect(r2).toMatchObject({ ok: false, status: "FAILED" });
    expect(r2.error).toMatch(/disabled for this workspace/);

    expect(nm.sent).toHaveLength(0); // neither the CSTEP server nor the env one, nor an alert to the desk
    expect(await col("emailoutboxes").countDocuments({ event: "email_send_failed_alert" })).toBe(0);
  });

  it("the global switch off stops a CSTEP row at send time too", async () => {
    ok(await call("put", ADMIN, "/settings", { ...BASE, senderName: "CSTEP Travel Desk", enabled: true, smtpPort: 465 }));
    delete process.env.CSTEP_NOTIFICATIONS_ENABLED;
    try {
      const r = await enqueueEmail(msg({ transport: "CSTEP", workspaceId: WS }));
      expect(r).toMatchObject({ ok: false, status: "FAILED", error: "CSTEP_NOTIFICATIONS_ENABLED is off" });
    } finally {
      process.env.CSTEP_NOTIFICATIONS_ENABLED = "true";
    }
    expect(nm.sent).toHaveLength(0);
  });

  it("DISABLE_EMAILS still silences the CSTEP transport", async () => {
    process.env.DISABLE_EMAILS = "1";
    try {
      const r = await enqueueEmail(msg({ transport: "CSTEP", workspaceId: WS }));
      expect(r.status).toBe("SENT"); // the mailer's kill switch reports a skipped send as delivered, as for every row
    } finally {
      process.env.DISABLE_EMAILS = "";
    }
    expect(nm.sent).toHaveLength(0);
  });
});

function ok(r: request.Response) {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
