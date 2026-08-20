// apps/backend/src/services/ticketAttachmentStorage.ts
//
// TWO DRIVERS FOR TICKET ATTACHMENT BYTES. S3 IS THE PRODUCTION ONE.
// LOCAL DISK IS DEV-ONLY AND REFUSES TO RUN IN PRODUCTION.
//
// ══════════════════════════════════════════════════════════════════════
// This is deliberately a SIBLING of services/ticketAttachments.ts, not a
// replacement for it.
// ══════════════════════════════════════════════════════════════════════
// That module is the Gmail path: ingestion calls uploadTicketAttachment()
// and puts bytes straight in S3. It is untouched, so an emailed
// attachment is written exactly as it was before D2C support existed —
// same key shape, same bucket, same md5. Rewriting it to route through
// here would put the B2B path's behaviour on the outcome of this file's
// driver choice, which is precisely the risk not worth taking for a
// feature that only needed a new entry point.
//
// ── WHY A LOCAL DRIVER AT ALL ────────────────────────────────────────
// Local development cannot reach S3. The credentials in .env.development
// are placeholders — a real PutObject with them fails
// `InvalidAccessKeyId` — and the `S3_ENDPOINT=http://127.0.0.1:9000` line
// suggesting a MinIO is inert, because neither S3 client in this repo
// passes an `endpoint` (services/consumerDocumentStorage.ts says the same
// thing about the same line). Without a disk driver, the consumer upload
// path could be written but never once exercised before production.
//
// ── THE PRODUCTION GUARD IS DOUBLED ON PURPOSE ───────────────────────
// Identical in shape to consumerDocumentStorage.ts's: the driver choice
// is hard-wired to "s3" when NODE_ENV === "production", AND every
// local-disk entry point re-asserts that it is not running in production.
// The second check is not redundant — it means a future caller that picks
// a driver some other way still cannot write a customer's passport scan
// to an App Runner container's ephemeral filesystem.
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import crypto from "node:crypto";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import type { TicketAttachmentDriver } from "../models/TicketAttachment.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** src/services → src → apps/backend → apps → <repo root> */
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const LOCAL_ROOT = path.join(repoRoot, ".devdata", "uploads", "ticket-attachments");

const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined,
});

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Which driver a NEW upload uses.
 *
 * Production is not a choice — it is "s3", unconditionally, with no env
 * var that can flip it.
 */
export function activeTicketAttachmentDriver(): TicketAttachmentDriver {
  return isProductionRuntime() ? "s3" : "local-disk";
}

function assertLocalDriverAllowed(): void {
  if (isProductionRuntime()) {
    throw new Error(
      "ticketAttachmentStorage: the local-disk driver was invoked with NODE_ENV=production — " +
        "ticket attachments must go to S3 in production",
    );
  }
}

/** The same sanitiser services/ticketAttachments.ts uses, so keys match. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_{2,}/g, "_");
}

export interface StoredTicketAttachment {
  driver: TicketAttachmentDriver;
  storageKey: string;
  s3Key?: string;
  s3Bucket?: string;
  size: number;
  checksum: string;
}

/**
 * Writes attachment bytes and returns where they went.
 *
 * The key shape is IDENTICAL to the Gmail path's —
 * `tickets/{ticketRef}/{sanitised}` — under both drivers, so a bucket
 * listing does not reveal which entry point produced an object and a
 * local-disk tree mirrors what production's bucket would hold. A
 * timestamp prefix disambiguates two uploads of the same filename onto
 * one case, which the Gmail path never had to handle because a re-sent
 * email is deduped upstream by gmailMessageId.
 */
export async function putTicketAttachmentBytes(input: {
  ticketRef: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}): Promise<StoredTicketAttachment> {
  const driver = activeTicketAttachmentDriver();
  const safe = sanitizeFilename(input.filename);
  const key = `tickets/${input.ticketRef}/${Date.now()}-${safe}`;
  const checksum = crypto.createHash("md5").update(input.data).digest("hex");

  if (driver === "s3") {
    const bucket = env.S3_BUCKET;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: input.data,
        ContentType: input.mimeType,
        Metadata: {
          ticketRef: input.ticketRef,
          originalName: input.filename,
          md5: checksum,
        },
      }),
    );
    return {
      driver: "s3",
      storageKey: key,
      s3Key: key,
      s3Bucket: bucket,
      size: input.data.length,
      checksum,
    };
  }

  assertLocalDriverAllowed();
  const abs = resolveLocalPath(key);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, input.data);
  return { driver: "local-disk", storageKey: key, size: input.data.length, checksum };
}

/**
 * Resolves a local-disk key to an absolute path, refusing anything that
 * escapes the upload root.
 *
 * storageKey is read from the database rather than from a request, but the
 * check is cheap and the consequence of being wrong is an arbitrary file
 * read served to an authenticated agent, so it is enforced rather than
 * reasoned about — same posture as consumerDocumentStorage.ts.
 */
function resolveLocalPath(storageKey: string): string {
  // Keys are stored as `tickets/<ref>/<file>`; the local tree drops the
  // leading `tickets/` segment because LOCAL_ROOT already names it.
  const relative = storageKey.replace(/^tickets\//, "");
  const abs = path.resolve(LOCAL_ROOT, relative);
  const root = path.resolve(LOCAL_ROOT);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("ticketAttachmentStorage: refusing a storage key outside the upload root");
  }
  return abs;
}

/** A readable stream of a LOCAL-DISK object's bytes. */
export async function openLocalTicketAttachment(storageKey: string): Promise<Readable> {
  assertLocalDriverAllowed();
  const abs = resolveLocalPath(storageKey);
  await stat(abs); // throws ENOENT rather than yielding an empty stream
  return createReadStream(abs);
}

/** Removes local bytes. Present so a future erasure path has a callee. */
export async function deleteLocalTicketAttachment(storageKey: string): Promise<void> {
  assertLocalDriverAllowed();
  await rm(resolveLocalPath(storageKey), { force: true });
}

/** Exposed for tests and for the dev-only tidy-up in the support suite. */
export const TICKET_ATTACHMENT_LOCAL_ROOT = LOCAL_ROOT;
