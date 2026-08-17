// apps/backend/src/services/consumerDocumentStorage.ts
//
// Where a consumer document's BYTES go, and how they come back.
//
// ══════════════════════════════════════════════════════════════════════
// TWO DRIVERS. S3 IS THE PRODUCTION ONE. LOCAL DISK IS DEV-ONLY AND
// CANNOT ENGAGE IN PRODUCTION.
// ══════════════════════════════════════════════════════════════════════
//
// WHY A LOCAL DRIVER EXISTS AT ALL
// --------------------------------
// utils/s3Upload.ts builds its S3 client from AWS_REGION + credentials and
// IGNORES S3_ENDPOINT entirely. So the `S3_ENDPOINT=http://127.0.0.1:9000`
// line in .env.development.example does NOT redirect uploads to a local
// MinIO — it does nothing, and an upload in local dev is attempted against
// the REAL AWS endpoint with placeholder credentials. It fails, which is the
// correct failure, but it also means the document locker cannot be built or
// demonstrated locally at all.
//
// This module is the narrow fix: a disk driver used ONLY by the consumer
// document path, so passport scans can be uploaded, listed, viewed and
// deleted on a laptop with no AWS account and no Docker.
//
// ⚠ WHAT THIS IS NOT
// It is NOT a general storage abstraction for the repo. Every other upload
// path (HR documents, visa documents, vouchers, expense receipts) still goes
// straight to S3 and is untouched. Generalising this into a repo-wide driver
// layer is a deliberate, separate decision — not something to be arrived at
// by adding a sixth caller here.
//
// ── THE PRODUCTION GATE ───────────────────────────────────────────────
// Identical in shape to routes/consumer.devAuth.ts's: the driver choice is
// hard-wired to "s3" when NODE_ENV === "production", AND every local-disk
// function re-asserts it before touching the filesystem. The second check is
// not redundant — it means a future caller that selects a driver by some
// other route still cannot write consumer PII to a production container's
// ephemeral disk, where it would be both unbacked-up and invisible.
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

import { uploadBufferToS3, deleteObject, getObjectBuffer } from "../utils/s3Upload.js";
import type { ConsumerDocumentDriver } from "../models/ConsumerDocument.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/services -> src -> apps/backend -> apps -> <repo root>
const repoRoot = path.resolve(here, "../../../..");

/**
 * Dev upload root: <repo>/.devdata/uploads/consumer-documents
 *
 * Under .devdata/ on purpose — that directory is ALREADY gitignored at the
 * repo root (.gitignore:14, the same line that covers the dev mongod's
 * dbPath). Test passport scans therefore cannot be committed by an
 * absent-minded `git add -A`, which for this particular payload matters more
 * than the convenience of putting it somewhere prettier.
 */
const LOCAL_ROOT = path.join(repoRoot, ".devdata", "uploads", "consumer-documents");

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Which driver a NEW upload uses.
 *
 * Production is not a choice — it is "s3", unconditionally, with no env
 * override. An env-var escape hatch here would be a way to turn on
 * plaintext-on-disk PII storage in production by editing configuration,
 * which is not a capability worth having.
 */
export function activeDriver(): ConsumerDocumentDriver {
  return isProductionRuntime() ? "s3" : "local-disk";
}

function assertLocalDriverAllowed(): void {
  if (isProductionRuntime()) {
    throw new Error(
      "consumerDocumentStorage: the local-disk driver was invoked with NODE_ENV=production — " +
        "consumer documents must go to S3 in production",
    );
  }
}

function extensionFor(originalName: string, mime: string): string {
  const fromName = path.extname(String(originalName || "")).replace(/^\./, "").toLowerCase();
  if (fromName && /^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  const fromMime: Record<string, string> = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  return fromMime[mime] || "bin";
}

export interface StoredObject {
  driver: ConsumerDocumentDriver;
  storageKey: string;
  bucket?: string;
}

/**
 * Writes bytes and returns where they went.
 *
 * The key embeds consumerId in the PATH — mirroring the visa convention of
 * putting workspaceId in the key (models/VisaDocument.ts) — so two
 * consumers' files can never collide, and so an object's owner is readable
 * from the key alone when auditing a bucket.
 */
export async function putConsumerDocument(input: {
  buffer: Buffer;
  mime: string;
  originalName: string;
  consumerId: string;
}): Promise<StoredObject> {
  const driver = activeDriver();
  const ext = extensionFor(input.originalName, input.mime);
  const filename = `${Date.now()}-${randomBytes(8).toString("hex")}.${ext}`;
  const relKey = `consumer-documents/${input.consumerId}/${filename}`;

  if (driver === "s3") {
    const uploaded = await uploadBufferToS3({
      buffer: input.buffer,
      mime: input.mime,
      originalName: input.originalName,
      customerId: String(input.consumerId),
      createdBy: String(input.consumerId),
      keyPrefix: `consumer-documents/${input.consumerId}`,
    });
    return { driver: "s3", storageKey: uploaded.key, bucket: uploaded.bucket };
  }

  assertLocalDriverAllowed();
  const abs = path.join(LOCAL_ROOT, input.consumerId, filename);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, input.buffer);
  return { driver: "local-disk", storageKey: relKey };
}

/**
 * Resolves a local-disk key to an absolute path, refusing anything that
 * escapes the upload root.
 *
 * storageKey is read from the database, not from the request — but this
 * check is cheap and the consequence of being wrong is arbitrary file read,
 * so it is enforced rather than reasoned about.
 */
function resolveLocalPath(storageKey: string): string {
  const abs = path.resolve(repoRoot, ".devdata", "uploads", storageKey);
  const root = path.resolve(LOCAL_ROOT);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("consumerDocumentStorage: refusing a storage key outside the upload root");
  }
  return abs;
}

/** A readable stream of the object's bytes, for the authenticated file route. */
export async function openConsumerDocument(doc: {
  driver: ConsumerDocumentDriver;
  storageKey: string;
}): Promise<Readable> {
  if (doc.driver === "s3") {
    const buf = await getObjectBuffer(doc.storageKey);
    const { Readable: NodeReadable } = await import("node:stream");
    return NodeReadable.from(buf);
  }

  assertLocalDriverAllowed();
  const abs = resolveLocalPath(doc.storageKey);
  await stat(abs); // throws ENOENT rather than yielding an empty stream
  return createReadStream(abs);
}

/**
 * Removes the bytes. Called only when a row is hard-deleted, which today is
 * never — DELETE is a soft delete because documents are shared (see
 * models/ConsumerDocument.ts). Present so the erasure path has something to
 * call when it is built.
 */
export async function deleteConsumerDocumentBytes(doc: {
  driver: ConsumerDocumentDriver;
  storageKey: string;
}): Promise<void> {
  if (doc.driver === "s3") {
    await deleteObject(doc.storageKey);
    return;
  }

  assertLocalDriverAllowed();
  await rm(resolveLocalPath(doc.storageKey), { force: true });
}

/** Surfaced by the routes so the UI can say which store it is talking to. */
export function storageDescription(): { driver: ConsumerDocumentDriver; devLocalDisk: boolean } {
  const driver = activeDriver();
  return { driver, devLocalDisk: driver === "local-disk" };
}

export { LOCAL_ROOT as CONSUMER_DOCUMENT_LOCAL_ROOT };
