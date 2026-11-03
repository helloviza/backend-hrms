// apps/backend/src/routes/cstep.uploadSizeLimit.test.ts
//
// The CSTEP upload cap (REPORT_ATTACHMENT_MAX_MB = 20) on all four multipart
// routes that share reportAttachmentMw: an oversized file is refused with a
// clean 413 + message (it used to fall through to the global handler as a
// bare 500 "File too large"), a disallowed type is a 400, and a 16 MB file —
// over the old 15 MB cap — is no longer refused for size.
//
// Real: cstep router + its multer wrapper. No database: multer runs before
// every handler, so the refusals never reach Mongo; the 16 MB case only
// asserts it got past multer (mongoose buffering is off, so the handler
// fails fast instead of waiting for a connection).
// Stubbed: S3 upload/presign, mail, auth (req.user injected).
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_upload_size";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";

vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async () => ({ key: "qc" })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));

mongoose.set("bufferCommands", false);
const { default: cstepRouter } = await import("./cstep.js");

const oid = () => String(new mongoose.Types.ObjectId());
const USER = { _id: oid(), id: oid(), sub: oid(), email: "qc@qc.local", roles: ["REQUESTER"], workspaceId: oid() };

const app = express();
app.use(
  "/api/cstep",
  (req: any, _res: any, next: any) => {
    req.user = USER;
    req.workspaceObjectId = new mongoose.Types.ObjectId(USER.workspaceId);
    next();
  },
  cstepRouter,
);

const MB = 1024 * 1024;
const pdf = (bytes: number) => Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.alloc(bytes - 9, 0x20)]);
const ROUTES = [
  `/api/cstep/requests/${oid()}/report/legs/${oid()}/attachment`,
  `/api/cstep/requests/${oid()}/report/legs/${oid()}/travel-proof`,
  `/api/cstep/requests/${oid()}/arrangements/${oid()}/attachment`,
  "/api/cstep/attachments/staging",
];
const upload = (path: string, body: Buffer, contentType = "application/pdf", filename = "proof.pdf") =>
  request(app).post(path).attach("file", body, { filename, contentType });

describe("CSTEP upload size cap (20 MB)", () => {
  const over = pdf(20 * MB + 1);

  it.each(ROUTES)("refuses a file over 20 MB with a clean 413 — %s", async (path) => {
    const r = await upload(path, over);
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ error: "File too large. Maximum size is 20 MB." });
  });

  it("refuses a disallowed file type with a 400, not the old 500", async () => {
    const r = await upload(ROUTES[1], Buffer.from("<html></html>"), "text/html", "x.html");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Only PDF, PNG, JPEG, or WEBP files are allowed.");
  });

  it("lets a 16 MB file (over the old 15 MB cap) past the size check", async () => {
    const r = await upload(ROUTES[1], pdf(16 * MB));
    expect(r.status).not.toBe(413);
    expect(String(r.body?.error || "")).not.toMatch(/too large/i);
  });
});
