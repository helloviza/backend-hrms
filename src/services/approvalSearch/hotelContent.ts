// apps/backend/src/services/approvalSearch/hotelContent.ts
//
// Static hotel content (images, facilities, description, check-in/out times,
// map position) for the approval request form's hotel cards. TBO HotelDetails
// through services/tbo.hotel.details.service.ts (shared with SBT, per-code
// cache), projected through an allow-list: no price field exists here, and
// every text goes through stripPriceText.
//
// Only hotels the caller's OWN unexpired hotel search returned may be asked
// for; any other code is dropped silently (never reveal it exists).

import type { Types } from "mongoose";
import ApprovalSearchSession from "../../models/ApprovalSearchSession.js";
import { fetchHotelContent, imageUrlsOf } from "../tbo.hotel.details.service.js";
import { stripPriceText } from "../../routes/approvals.security.js";
import type { SearchReply } from "./search.js";

export const HOTEL_CONTENT_MAX_CODES = 20;
const MAX_IMAGES = 8;
const MAX_FACILITIES = 20;
const MAX_DESCRIPTION = 2000;
const MAX_TEXT = 120;

export type HotelContent = {
  images: string[];
  facilities: string[];
  description: string;
  checkInTime: string | null;
  checkOutTime: string | null;
  latitude: number | null;
  longitude: number | null;
};

export const EMPTY_HOTEL_CONTENT: HotelContent = {
  images: [],
  facilities: [],
  description: "",
  checkInTime: null,
  checkOutTime: null,
  latitude: null,
  longitude: null,
};

const line = (v: unknown, max = MAX_TEXT): string => stripPriceText(String(v ?? "").replace(/\s+/g, " ").trim()).slice(0, max);

/**
 * TBO writes sections as "Location : …": tidied to "Location: …". "HeadLine"
 * is TBO's field name, not a heading for a reader, so only its text stays.
 */
export function sectionLine(text: string): string {
  const m = text.match(/^([A-Za-z][A-Za-z ]{0,30}?)\s*:\s*(.*)$/);
  if (!m) return text;
  const label = m[1].trim();
  const rest = m[2].trim();
  if (/^head\s*line$/i.test(label)) return rest;
  return rest ? `${label}: ${rest}` : "";
}

/** TBO descriptions may carry HTML: tags out, entities decoded, paragraphs kept as line breaks. */
function plainText(v: unknown): string {
  const s = String(v ?? "")
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
  const text = s
    .split(/\n/)
    .map((l) => sectionLine(stripPriceText(l.replace(/[ \t\r\f\v]+/g, " ").trim())))
    .filter(Boolean)
    .join("\n");
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION).trimEnd()}…` : text;
}

/** "lat|long" (TBO Map) → numbers, or nulls when absent, unparsable, out of range or 0,0. */
export function coordsOf(map: unknown): { latitude: number | null; longitude: number | null } {
  const [a, b] = String(map ?? "").split("|").map((x) => Number(String(x).trim()));
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0);
  return ok ? { latitude: a, longitude: b } : { latitude: null, longitude: null };
}

const hostOf = (u: string): string | null => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Image URLs safe to hand the browser: https only, never http (mixed content).
 * An http URL becomes the same URL over https (any host). Anything else
 * (relative, data:, other schemes, no host) is dropped.
 */
export function httpsImages(urls: string[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    let safe: string | null = null;
    if (/^https:\/\//i.test(u)) safe = u;
    else if (/^http:\/\//i.test(u)) safe = `https://${u.slice("http://".length)}`;
    if (safe && hostOf(safe) && !out.includes(safe)) out.push(safe);
  }
  return out;
}

/** One TBO HotelDetails entry → the allow-listed content. */
export function toHotelContent(h: any): HotelContent {
  const images = httpsImages(imageUrlsOf(Array.isArray(h?.Images) ? h.Images : [])).slice(0, MAX_IMAGES);
  const rawFacilities: unknown[] = Array.isArray(h?.HotelFacilities)
    ? h.HotelFacilities
    : String(h?.HotelFacilities ?? "").split(",");
  const facilities = [...new Set(rawFacilities.map((f) => line(f)).filter(Boolean))].slice(0, MAX_FACILITIES);
  return {
    images,
    facilities,
    description: plainText(h?.Description),
    checkInTime: line(h?.CheckInTime, 20) || null,
    checkOutTime: line(h?.CheckOutTime, 20) || null,
    ...coordsOf(h?.Map),
  };
}

/** "a, b,a" → ["a","b"], at most HOTEL_CONTENT_MAX_CODES. */
export function parseHotelCodes(v: unknown): string[] {
  const list = Array.isArray(v) ? v.join(",") : String(v ?? "");
  return [...new Set(list.split(",").map((c) => c.trim()).filter((c) => /^[A-Za-z0-9_-]{1,20}$/.test(c)))].slice(
    0,
    HOTEL_CONTENT_MAX_CODES,
  );
}

/** Hotel codes in the caller's own unexpired hotel searches. */
async function searchedHotelCodes(caller: { userId: string; workspaceId: Types.ObjectId | string }, now: Date): Promise<Set<string>> {
  const sessions: any[] = await ApprovalSearchSession.find({
    userId: String(caller.userId),
    workspaceId: caller.workspaceId,
    kind: "hotel",
    expiresAt: { $gt: now },
  })
    .select("results.HotelCode")
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  return new Set(sessions.flatMap((s) => (Array.isArray(s.results) ? s.results : []).map((r: any) => String(r?.HotelCode ?? ""))).filter(Boolean));
}

/**
 * GET /approvals/search/hotel-content?hotelCodes=a,b,c. Codes the caller didn't
 * search are dropped; a TBO failure gives those hotels empty content, never an error.
 */
export async function hotelContentForApproval(
  query: any,
  caller: { userId: string; workspaceId: Types.ObjectId | string },
  now: Date = new Date(),
): Promise<SearchReply> {
  const asked = parseHotelCodes(query?.hotelCodes);
  if (!asked.length) return { status: 400, body: { error: "hotelCodes required", code: "BAD_REQUEST" } };

  const allowed = await searchedHotelCodes(caller, now);
  const codes = asked.filter((c) => allowed.has(c));
  const fetched = codes.length ? await fetchHotelContent(codes) : new Map<string, any>();

  const hotels: Record<string, HotelContent> = {};
  for (const code of codes) {
    const h = fetched.get(code);
    hotels[code] = h ? toHotelContent(h) : { ...EMPTY_HOTEL_CONTENT };
  }
  return { status: 200, body: { ok: true, hotels } };
}
