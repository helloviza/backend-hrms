// Test-database guard: tests (and seeds) only ever run against a local DB.
import { describe, it, expect, afterEach } from "vitest";
import { isLocalMongoUri, assertLocalDatabase } from "./assertLocalDatabase.js";
import {
  guardTestDatabase,
  guardTestStorage,
  isProdBucket,
  TEST_MONGO_PLACEHOLDER,
  TEST_S3_BUCKET_PLACEHOLDER,
} from "../../vitest.dbGuard.js";

describe("isLocalMongoUri", () => {
  it.each([
    "mongodb://127.0.0.1:27017/x",
    "mongodb://localhost/x",
    "mongodb://user:pw@127.0.0.1:27027/x?directConnection=true",
    "mongodb://127.0.0.1:1/vitest-never-connected",
  ])("local: %s", (u) => expect(isLocalMongoUri(u)).toBe(true));

  it.each([
    "mongodb+srv://u:p@cluster0.abcde.mongodb.net/Plumtrips_hrms?retryWrites=true",
    "mongodb://u:p@cluster0-shard-00-00.abcde.mongodb.net:27017/db",
    "mongodb://127.0.0.1:27017,db.example.com:27017/x",
    "postgres://localhost/x",
    "",
  ])("not local: %s", (u) => expect(isLocalMongoUri(u)).toBe(false));

  it("assertLocalDatabase still refuses Atlas and remote hosts", () => {
    expect(() => assertLocalDatabase("mongodb+srv://a:b@x.mongodb.net/db")).toThrow(/REFUSING/);
    expect(() => assertLocalDatabase("mongodb://db.example.com/x")).toThrow(/non-local host/);
    expect(() => assertLocalDatabase("mongodb://127.0.0.1/x")).not.toThrow();
  });
});

describe("guardTestDatabase", () => {
  const saved = process.env.MONGO_URI;
  afterEach(() => { process.env.MONGO_URI = saved; });

  it("the worker running this file already has a local MONGO_URI", () => {
    expect(isLocalMongoUri(String(saved))).toBe(true);
  });

  it("unset → pins the never-connecting placeholder (dotenv can no longer fill it)", () => {
    delete process.env.MONGO_URI;
    guardTestDatabase();
    expect(process.env.MONGO_URI).toBe(TEST_MONGO_PLACEHOLDER);
  });

  it("an Atlas URI refuses to run, and the message hides the credentials", () => {
    process.env.MONGO_URI = "mongodb+srv://admin:s3cret@prod.abcde.mongodb.net/Plumtrips_hrms?w=majority";
    expect(() => guardTestDatabase()).toThrow(/REFUSING TO RUN TESTS/);
    try { guardTestDatabase(); } catch (e: any) { expect(e.message).not.toContain("s3cret"); }
  });

  it("a local URI passes untouched", () => {
    process.env.MONGO_URI = "mongodb://127.0.0.1:27017/some-test";
    guardTestDatabase();
    expect(process.env.MONGO_URI).toBe("mongodb://127.0.0.1:27017/some-test");
  });
});

describe("guardTestStorage", () => {
  const keys = ["S3_BUCKET", "S3_BASE_URL", "AWS_S3_PUBLIC_BASE_URL"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("the worker running this file has no production bucket", () => {
    for (const k of keys) expect(isProdBucket(String(saved[k] ?? ""))).toBe(false);
  });

  it.each(["plumtrips-hrms-prod", "PLUMTRIPS-HRMS-PROD", "acme_production", "https://plumtrips-hrms-prod.s3.ap-south-1.amazonaws.com"])(
    "production: %s",
    (v) => expect(isProdBucket(v)).toBe(true),
  );
  it.each(["plumbox-dev-local", "test-bucket", "qc-unused", TEST_S3_BUCKET_PLACEHOLDER, "products-assets"])(
    "not production: %s",
    (v) => expect(isProdBucket(v)).toBe(false),
  );

  it("unset → pins a bucket that does not exist (dotenv can no longer fill the prod one)", () => {
    delete process.env.S3_BUCKET;
    delete process.env.S3_BASE_URL;
    guardTestStorage();
    expect(process.env.S3_BUCKET).toBe(TEST_S3_BUCKET_PLACEHOLDER);
    expect(process.env.S3_BASE_URL).toContain(TEST_S3_BUCKET_PLACEHOLDER);
  });

  it.each(keys)("a production value in %s refuses to run", (k) => {
    process.env[k] = k === "S3_BUCKET" ? "plumtrips-hrms-prod" : "https://plumtrips-hrms-prod.s3.ap-south-1.amazonaws.com";
    expect(() => guardTestStorage()).toThrow(new RegExp(`REFUSING TO RUN TESTS: ${k}`));
  });

  it("a non-production bucket passes untouched", () => {
    process.env.S3_BUCKET = "test-bucket";
    guardTestStorage();
    expect(process.env.S3_BUCKET).toBe("test-bucket");
  });
});
