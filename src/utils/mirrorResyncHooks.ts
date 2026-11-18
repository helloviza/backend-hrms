/**
 * Keeps a source model's TravelBooking mirror row in step with writes that
 * bypass `doc.save()` — `updateOne` / `updateMany` / `findOneAndUpdate`
 * (and so `findByIdAndUpdate`). The models only sync in `post("save")`, so
 * every bulk or query write used to leave the mirror stale (Travel Spend
 * audit 2026-11, N1 + N4).
 *
 * How it works:
 *   pre   — if the update touches a path the mirror copies, capture the _ids
 *           the filter matches (BEFORE the write: the write can move a doc
 *           out of its own filter, e.g. `status: {$ne: "INVOICED"}`).
 *   post  — re-run the model's own sync for those _ids, reading the source
 *           as committed. Inside a transaction the source isn't committed
 *           yet, so the ids wait on the session and are synced when the
 *           owner calls `flushMirrorResync(session)` after `withTransaction`
 *           (or, as a safety net, when the session ends).
 *
 * A mirror failure never fails the source write (same as the save hooks).
 * Resyncing a row that didn't actually change is harmless — the sync is an
 * idempotent upsert from the source document.
 */
import type { Schema, Types, ClientSession } from "mongoose";

type ResyncFn = (ids: Types.ObjectId[]) => Promise<unknown>;

const HOOKED_OPS = ["updateOne", "updateMany", "findOneAndUpdate"] as const;

/** session → model label → { ids, resync } waiting for the commit. */
const pending = new WeakMap<object, Map<string, { ids: Map<string, Types.ObjectId>; resync: ResyncFn }>>();

/** Top-level paths an update writes. `null` = can't tell (pipeline /
 *  replacement) → treat as touching everything. */
export function updatedTopLevelPaths(update: unknown, opts: { upsert?: boolean } = {}): string[] | null {
  if (!update || typeof update !== "object") return [];
  if (Array.isArray(update)) return null; // aggregation-pipeline update
  const out = new Set<string>();
  for (const [k, v] of Object.entries(update as Record<string, unknown>)) {
    // Mongoose timestamps add $setOnInsert:{createdAt} to EVERY update; it
    // only writes on an upsert insert.
    if (k === "$setOnInsert" && !opts.upsert) continue;
    if (k.startsWith("$")) {
      if (v && typeof v === "object") {
        for (const p of Object.keys(v as Record<string, unknown>)) out.add(p.split(".")[0]);
      }
    } else {
      out.add(k.split(".")[0]); // bare field = implicit $set
    }
  }
  return [...out];
}

export function touchesMirrorPaths(
  update: unknown,
  mirrorPaths: ReadonlySet<string>,
  opts: { upsert?: boolean } = {},
): boolean {
  const paths = updatedTopLevelPaths(update, opts);
  if (paths === null) return true;
  return paths.some((p) => mirrorPaths.has(p));
}

function inTransaction(session: any): boolean {
  return !!session && typeof session.inTransaction === "function" && session.inTransaction();
}

async function runResync(label: string, resync: ResyncFn, ids: Types.ObjectId[]): Promise<void> {
  if (!ids.length) return;
  try {
    await resync(ids);
  } catch (e) {
    console.warn(`TravelBooking resync (${label}) failed:`, (e as any)?.message);
  }
}

/** Sync every mirror row a transaction on `session` touched. Call after
 *  `withTransaction` settles (committed or not — the sync reads committed
 *  state, so after an abort it simply rewrites the same row). */
export async function flushMirrorResync(session: ClientSession | null | undefined): Promise<void> {
  if (!session) return;
  const byModel = pending.get(session as any);
  if (!byModel) return;
  pending.delete(session as any);
  for (const [label, { ids, resync }] of byModel) {
    await runResync(label, resync, [...ids.values()]);
  }
}

function queue(session: any, label: string, resync: ResyncFn, ids: Types.ObjectId[]) {
  let byModel = pending.get(session);
  if (!byModel) {
    byModel = new Map();
    pending.set(session, byModel);
    // Safety net for a transaction owner that doesn't flush explicitly.
    if (typeof session.once === "function") {
      session.once("ended", () => {
        void flushMirrorResync(session);
      });
    }
  }
  let entry = byModel.get(label);
  if (!entry) {
    entry = { ids: new Map(), resync };
    byModel.set(label, entry);
  }
  for (const id of ids) entry.ids.set(String(id), id);
}

export function attachMirrorResyncHooks(
  schema: Schema,
  opts: { label: string; mirrorPaths: readonly string[]; resync: ResyncFn },
): void {
  const mirrorPaths = new Set(opts.mirrorPaths);

  schema.pre(HOOKED_OPS as any, { document: false, query: true }, async function (this: any) {
    this._mirrorResyncIds = undefined;
    if (!touchesMirrorPaths(this.getUpdate(), mirrorPaths, { upsert: !!this.getOptions()?.upsert })) return;
    const session = this.getOptions()?.session ?? null;
    try {
      const rows = await this.model
        .find(this.getFilter(), { _id: 1 })
        .session(session)
        .lean();
      this._mirrorResyncIds = rows.map((r: any) => r._id);
    } catch (e) {
      // Never block the source write over the mirror.
      console.warn(`TravelBooking resync (${opts.label}) id capture failed:`, (e as any)?.message);
      this._mirrorResyncIds = [];
    }
  });

  schema.post(HOOKED_OPS as any, { document: false, query: true }, async function (this: any, res: any) {
    const captured: Types.ObjectId[] | undefined = this._mirrorResyncIds;
    if (captured === undefined) return; // update didn't touch a mirrored path
    const ids = [...captured];
    // Upserts create a doc the pre-find couldn't see.
    if (res?.upsertedId) ids.push(res.upsertedId);
    if (this.op === "findOneAndUpdate") {
      const docId = res?._id ?? res?.value?._id; // plain doc, or includeResultMetadata
      if (docId && !ids.some((i) => String(i) === String(docId))) ids.push(docId);
    }
    if (!ids.length) return;
    const session = this.getOptions()?.session ?? null;
    if (inTransaction(session)) {
      queue(session, opts.label, opts.resync, ids);
      return;
    }
    await runResync(opts.label, opts.resync, ids);
  });
}
