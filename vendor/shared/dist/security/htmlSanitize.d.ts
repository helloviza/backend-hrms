/**
 * THE ONE HTML ALLOWLIST.
 *
 * Every place this codebase turns stored HTML back into markup — the ticket
 * console thread, the consumer's case thread, the outbound quote trail — goes
 * through this file. It lives in @plumtrips/shared because the backend
 * sanitizes on write and the frontend sanitizes on render, and an allowlist
 * that exists twice is an allowlist that drifts once.
 *
 * WHY BOTH LAYERS. Write-sanitizing closes the hole for rows written from now
 * on; render-sanitizing closes it for the rows already in the collection and
 * for any write path a future change forgets to route through here. Neither
 * alone is enough, so we do both and accept the double cost.
 *
 * TWO PROFILES, ONE ENGINE.
 *
 *   STRICT — exactly what the console's TipTap editor can produce. Applies to
 *   agent-authored content: replies, internal notes, portal replies, and every
 *   byte the consumer's browser is ever handed.
 *
 *   EMAIL — STRICT plus the inert layout tags real mail is built out of:
 *   tables, divs, spans, images, style. Applies to ingested email and to the
 *   admin console's render of it. This profile exists because an ops user
 *   reading a supplier's fare table must still see a table; running mail
 *   through STRICT would keep the words and throw away the shape, which is a
 *   regression dressed up as a security fix.
 *
 * The two profiles remove EXACTLY the same dangerous things. EMAIL is wider
 * only in tags that cannot execute: script, iframe, object, embed, form, base,
 * svg, math, link, meta, every on* handler, and every non-http(s)/mailto/cid
 * URI scheme die in both. The difference is layout, never capability.
 */
export interface HtmlSanitizeProfile {
    readonly ALLOWED_TAGS: string[];
    readonly ALLOWED_ATTR: string[];
    readonly ALLOWED_URI_REGEXP: RegExp;
    readonly ADD_URI_SAFE_ATTR: string[];
}
export declare const STRICT_HTML_PROFILE: HtmlSanitizeProfile;
export declare const EMAIL_HTML_PROFILE: HtmlSanitizeProfile;
/**
 * Agent-authored content and anything a consumer's browser will render.
 * TipTap's output passes through unchanged.
 */
export declare function sanitizeStrictHtml(html: string | null | undefined): string;
/**
 * Ingested email, the quote trail, and the admin console's render of them.
 * Keeps mail looking like mail; keeps it from doing anything.
 */
export declare function sanitizeEmailHtml(html: string | null | undefined): string;
/**
 * Which profile a stored TicketMessage was written under. The backfill and the
 * admin renderer both need this answer and must not disagree about it, so the
 * rule lives here: anything that travelled as mail is mail-shaped; everything
 * else is agent-authored.
 */
export declare function sanitizeTicketBody(html: string | null | undefined, channel: string | null | undefined): string;
