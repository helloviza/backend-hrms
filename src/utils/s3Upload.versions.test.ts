// deleteAllObjectVersions against a versioned bucket (in-memory S3 double):
// every version and delete marker of the key goes; nothing else is touched.
import { describe, it, expect, beforeEach } from "vitest";
import { ListObjectVersionsCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { deleteAllObjectVersions } from "./s3Upload.js";

type Entry = { Key: string; VersionId: string; marker: boolean };

/** A versioned bucket: listings are key-ordered and paged 2 at a time, as S3 pages (smaller). */
function versionedBucket(entries: Entry[], opts: { failKeys?: string[] } = {}) {
  const store = [...entries];
  const calls: string[] = [];
  return {
    store,
    calls,
    async send(cmd: any) {
      if (cmd instanceof ListObjectVersionsCommand) {
        calls.push("list");
        const { Prefix = "", KeyMarker, VersionIdMarker } = cmd.input;
        const all = store.filter((e) => e.Key.startsWith(Prefix)).sort((a, b) => (a.Key + a.VersionId).localeCompare(b.Key + b.VersionId));
        let start = 0;
        if (KeyMarker) start = all.findIndex((e) => e.Key === KeyMarker && e.VersionId === VersionIdMarker) + 1;
        const page = all.slice(start, start + 2);
        const truncated = start + 2 < all.length;
        const last = page[page.length - 1];
        return {
          Versions: page.filter((e) => !e.marker).map(({ Key, VersionId }) => ({ Key, VersionId })),
          DeleteMarkers: page.filter((e) => e.marker).map(({ Key, VersionId }) => ({ Key, VersionId })),
          IsTruncated: truncated,
          NextKeyMarker: truncated ? last.Key : undefined,
          NextVersionIdMarker: truncated ? last.VersionId : undefined,
        };
      }
      if (cmd instanceof DeleteObjectsCommand) {
        calls.push("delete");
        const errors: any[] = [];
        for (const o of cmd.input.Delete!.Objects!) {
          if (opts.failKeys?.includes(o.Key!)) { errors.push({ Key: o.Key, Code: "AccessDenied", Message: "denied" }); continue; }
          const i = store.findIndex((e) => e.Key === o.Key && e.VersionId === o.VersionId);
          if (i >= 0) store.splice(i, 1);
        }
        return { Errors: errors.length ? errors : undefined };
      }
      throw new Error("unexpected command " + cmd?.constructor?.name);
    },
  };
}

const KEY = "hrms/vouchers/69679a7628330a58d29f2254/69f38ed1/1791965313785-3a14.pdf";
const NEIGHBOUR = `${KEY}.bak`; // shares the listing prefix — must survive
const HR_POLICY = "hrms/vouchers/69679a7628330a58d29f2254/69f38ed1/1791965313000-hrpolicy.pdf";

let bucket: ReturnType<typeof versionedBucket>;
beforeEach(() => {
  bucket = versionedBucket([
    { Key: KEY, VersionId: "v1", marker: false },
    { Key: KEY, VersionId: "v2", marker: false },
    { Key: KEY, VersionId: "v3", marker: false },
    { Key: KEY, VersionId: "m1", marker: true },
    { Key: NEIGHBOUR, VersionId: "n1", marker: false },
    { Key: HR_POLICY, VersionId: "h1", marker: false },
    { Key: HR_POLICY, VersionId: "h2", marker: true },
  ]);
});

describe("deleteAllObjectVersions", () => {
  it("removes every version and delete marker of the key, across pages", async () => {
    const n = await deleteAllObjectVersions(KEY, "plumtrips-hrms-prod", bucket);
    expect(n).toBe(4);
    expect(bucket.store.filter((e) => e.Key === KEY)).toEqual([]);
  });

  it("leaves a prefix-sharing neighbour and an HR-policy key (with its own marker) untouched", async () => {
    await deleteAllObjectVersions(KEY, "plumtrips-hrms-prod", bucket);
    expect(bucket.store).toEqual([
      { Key: NEIGHBOUR, VersionId: "n1", marker: false },
      { Key: HR_POLICY, VersionId: "h1", marker: false },
      { Key: HR_POLICY, VersionId: "h2", marker: true },
    ]);
  });

  it("an already-gone key is a no-op (0), not an error", async () => {
    await deleteAllObjectVersions(KEY, "b", bucket);
    expect(await deleteAllObjectVersions(KEY, "b", bucket)).toBe(0);
  });

  it("refuses keys outside hrms/vouchers/ without calling S3", async () => {
    for (const k of ["hrms/expenses/x.pdf", "hrms/vouchersX/a.pdf", "", "hrms/vouchers/../expenses/x.pdf"]) {
      await expect(deleteAllObjectVersions(k, "b", bucket)).rejects.toThrow(/refusing key/);
    }
    expect(bucket.calls).toEqual([]);
  });

  it("throws when S3 refuses a version, so the caller retries next run", async () => {
    const denied = versionedBucket([{ Key: KEY, VersionId: "v1", marker: false }], { failKeys: [KEY] });
    await expect(deleteAllObjectVersions(KEY, "b", denied)).rejects.toThrow(/not deleted: AccessDenied/);
  });
});
