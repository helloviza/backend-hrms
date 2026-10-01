// apps/backend/src/services/approvalSearch/cartSelections.ts
//
// Server side of "the requester attached a live search option to an item".
// Used by POST /requests, PUT /requests/:id and PUT /requests/:id/resubmit.
//
//  - meta.selection sent by the client is ALWAYS dropped.
//  - An item carrying meta.optionRef gets meta.selection rebuilt here: from
//    this request's existing snapshot when the ref is already bound to it
//    (edit/resubmit, whoever edits), else from the caller's own unexpired
//    search session.
//  - A ref that doesn't resolve → SelectionError (400). The request is not
//    written.

import type { Types } from "mongoose";
import ApprovalSelectionSnapshot from "../../models/ApprovalSelectionSnapshot.js";
import { resolveOptionRef, type OptionRefFailure } from "./optionRef.js";
import { toFlightSelection, toHotelSelection, type ApprovalSelection } from "./selection.js";

export class SelectionError extends Error {
  status = 400;
  constructor(
    public code: "OPTION_REF_INVALID" | "OPTION_REF_EXPIRED",
    message: string,
    public itemIndex: number,
  ) {
    super(message);
  }
}

export type PendingSnapshot = {
  itemKey: string;
  optionRef: string;
  returnOptionRef?: string;
  kind: "flight" | "hotel";
  rawOption: any;
  selection: ApprovalSelection;
  searchParams: any;
  searchedAt: Date;
};

const refOf = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function failure(reason: OptionRefFailure, itemIndex: number): SelectionError {
  const n = itemIndex + 1;
  if (reason === "EXPIRED") {
    return new SelectionError(
      "OPTION_REF_EXPIRED",
      `Item ${n}: the search results for the option you picked have expired (they are kept for 60 minutes). Search again and pick it, or remove the selection.`,
      itemIndex,
    );
  }
  return new SelectionError(
    "OPTION_REF_INVALID",
    `Item ${n}: the option you picked is not a valid search result for you. Search again and pick it, or remove the selection.`,
    itemIndex,
  );
}

export async function prepareCartSelections(args: {
  cartItems: any[];
  userId: string;
  workspaceId: Types.ObjectId | string;
  /** Edit / resubmit: refs already bound to this request resolve from its snapshot. */
  requestId?: Types.ObjectId | string;
  now?: Date;
}): Promise<{ cartItems: any[]; snapshots: PendingSnapshot[] }> {
  const out: any[] = [];
  const snapshots: PendingSnapshot[] = [];

  for (let i = 0; i < args.cartItems.length; i++) {
    const src = args.cartItems[i];
    if (!src || typeof src !== "object") {
      out.push(src);
      continue;
    }
    const item: any = { ...src };
    const meta: any = item.meta && typeof item.meta === "object" && !Array.isArray(item.meta) ? { ...item.meta } : {};
    delete meta.selection;

    const optionRef = refOf(meta.optionRef);
    const returnOptionRef = refOf(meta.returnOptionRef);
    delete meta.optionRef;
    delete meta.returnOptionRef;

    if (!optionRef) {
      if (item.meta !== undefined) item.meta = meta;
      out.push(item);
      continue;
    }

    const kind = String(item.type || "").toLowerCase();
    if (kind !== "flight" && kind !== "hotel") throw failure("WRONG_KIND", i);
    if (returnOptionRef && kind !== "flight") throw failure("WRONG_KIND", i);

    let pending: PendingSnapshot | null = null;

    if (args.requestId) {
      const existing: any = await ApprovalSelectionSnapshot.findOne({
        requestId: args.requestId,
        workspaceId: args.workspaceId,
        optionRef,
      }).lean();
      if (existing && existing.kind === kind && (existing.returnOptionRef || "") === returnOptionRef) {
        pending = {
          itemKey: String(i),
          optionRef,
          ...(returnOptionRef ? { returnOptionRef } : {}),
          kind,
          rawOption: existing.rawOption,
          selection: existing.selection,
          searchParams: existing.searchParams,
          searchedAt: existing.searchedAt,
        };
      }
    }

    if (!pending) {
      const scope = { userId: args.userId, workspaceId: args.workspaceId, kind: kind as "flight" | "hotel", now: args.now };
      const main = await resolveOptionRef(optionRef, scope);
      if (main.ok === false) throw failure(main.reason, i);
      const { session, raw, room } = main.value;
      const searchedAt = session.createdAt ?? new Date();

      if (kind === "flight") {
        let back: any;
        if (returnOptionRef) {
          const ret = await resolveOptionRef(returnOptionRef, scope);
          if (ret.ok === false) throw failure(ret.reason, i);
          back = ret.value.raw;
        }
        pending = {
          itemKey: String(i),
          optionRef,
          ...(returnOptionRef ? { returnOptionRef } : {}),
          kind,
          rawOption: back ? { out: raw, back } : { out: raw },
          selection: toFlightSelection({ out: raw, back, optionRef, returnOptionRef: returnOptionRef || undefined, searchedAt }),
          searchParams: session.params,
          searchedAt,
        };
      } else {
        const p: any = session.params || {};
        const { Rooms: _rooms, ...hotelOnly } = raw || {};
        pending = {
          itemKey: String(i),
          optionRef,
          kind,
          rawOption: { hotel: hotelOnly, room },
          selection: toHotelSelection({
            hotel: raw,
            room,
            optionRef,
            checkIn: p.CheckIn ?? p.checkIn ?? "",
            checkOut: p.CheckOut ?? p.checkOut ?? "",
            searchedAt,
          }),
          searchParams: session.params,
          searchedAt,
        };
      }
    }

    meta.optionRef = optionRef;
    if (returnOptionRef) meta.returnOptionRef = returnOptionRef;
    meta.selection = pending.selection;
    item.meta = meta;
    out.push(item);
    snapshots.push(pending);
  }

  return { cartItems: out, snapshots };
}

/** True when any item carries a live-search optionRef (old or new cart). */
export function cartHasOptionRefs(items: unknown): boolean {
  return Array.isArray(items) && items.some((it: any) => refOf(it?.meta?.optionRef) !== "");
}

/**
 * Upserts one snapshot row per bound optionRef. With `prune`, rows of this
 * request whose ref is no longer on any item are removed (edit/resubmit).
 */
export async function writeSelectionSnapshots(args: {
  requestId: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  userId: string;
  snapshots: PendingSnapshot[];
  prune: boolean;
}): Promise<void> {
  for (const s of args.snapshots) {
    await ApprovalSelectionSnapshot.updateOne(
      { requestId: args.requestId, optionRef: s.optionRef },
      {
        $set: {
          workspaceId: args.workspaceId,
          itemKey: s.itemKey,
          kind: s.kind,
          rawOption: s.rawOption,
          selection: s.selection,
          searchParams: s.searchParams,
          searchedAt: s.searchedAt,
          ...(s.returnOptionRef ? { returnOptionRef: s.returnOptionRef } : {}),
        },
        ...(s.returnOptionRef ? {} : { $unset: { returnOptionRef: "" } }),
        $setOnInsert: { createdBy: String(args.userId) },
      },
      { upsert: true },
    );
  }
  if (args.prune) {
    await ApprovalSelectionSnapshot.deleteMany({
      requestId: args.requestId,
      workspaceId: args.workspaceId,
      optionRef: { $nin: args.snapshots.map((s) => s.optionRef) },
    });
  }
}
