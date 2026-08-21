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
import DOMPurify from "isomorphic-dompurify";
/* ── the allowlists ───────────────────────────────────────────────────── */
/** Blocks + inline marks the TipTap StarterKit and extension-link can emit. */
const STRICT_TAGS = [
    // blocks
    "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "blockquote", "pre", "code", "hr",
    // inline marks
    "strong", "em", "s", "u",
    // links
    "a",
];
/** Inert layout tags that real email is built out of. Nothing here executes. */
const EMAIL_EXTRA_TAGS = [
    "div", "span",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
    "img",
    "b", "i", // mail clients still emit these; TipTap normalises them to strong/em
    "font",
];
/** STRICT permits one attribute in the whole document: the href on a link. */
const STRICT_ATTRS = ["href"];
const EMAIL_EXTRA_ATTRS = [
    "src", "alt", "title",
    "width", "height", "align", "valign",
    "colspan", "rowspan", "cellpadding", "cellspacing", "border",
    "style", "dir",
    "color", "face", "size", // <font>, which older mail clients still send
];
/**
 * href/src schemes. Anything not matched is dropped, which is what kills
 * `javascript:`, `data:`, `vbscript:` and the entity-encoded spellings of
 * them — DOMPurify decodes the attribute before this regexp sees it, so
 * `&#106;avascript:` is tested as `javascript:` and fails.
 *
 * Relative URLs are deliberately NOT allowed: nothing legitimate in a ticket
 * body is relative to the console's own origin, and permitting them would let
 * a mail author point a link at our routes.
 */
const STRICT_URI = /^(?:https?|mailto):/i;
/** Same, plus `cid:` — inline-image references in ingested mail. A browser
 *  cannot resolve cid:, so these render broken exactly as they do today; the
 *  scheme is allowed to preserve the existing shape, not to make it work. */
const EMAIL_URI = /^(?:https?|mailto|cid):/i;
/**
 * Attributes exempt from the URI scheme check above.
 *
 * DOMPurify tests EVERY allowed attribute's value against ALLOWED_URI_REGEXP,
 * not just the URL-bearing ones — an attribute only skips that test if it is
 * in the URI-safe set. With a scheme regexp as tight as ours, that silently
 * ate `width="100%"`, `dir="ltr"` and `border="1"` off legitimate mail while
 * `alt`/`title`/`style` survived purely because they are in DOMPurify's own
 * default safe set.
 *
 * None of these can carry a URL, so exempting them costs nothing. `href` and
 * `src` are deliberately absent: they are exactly what the regexp is for.
 */
const PRESENTATIONAL_URI_SAFE = [
    "dir", "width", "height", "align", "valign",
    "colspan", "rowspan", "cellpadding", "cellspacing", "border",
    "color", "face", "size",
];
export const STRICT_HTML_PROFILE = {
    ALLOWED_TAGS: STRICT_TAGS,
    ALLOWED_ATTR: STRICT_ATTRS,
    ALLOWED_URI_REGEXP: STRICT_URI,
    // STRICT allows only href, which must stay URI-checked. Nothing is exempt.
    ADD_URI_SAFE_ATTR: [],
};
export const EMAIL_HTML_PROFILE = {
    ALLOWED_TAGS: [...STRICT_TAGS, ...EMAIL_EXTRA_TAGS],
    ALLOWED_ATTR: [...STRICT_ATTRS, ...EMAIL_EXTRA_ATTRS],
    ALLOWED_URI_REGEXP: EMAIL_URI,
    ADD_URI_SAFE_ATTR: PRESENTATIONAL_URI_SAFE,
};
/* ── shared DOMPurify options ─────────────────────────────────────────── */
const BASE_OPTIONS = {
    // Belt and braces. An allowlist already excludes these, but naming them
    // means a future widening of ALLOWED_TAGS cannot readmit them by accident.
    FORBID_TAGS: [
        "script", "style", "iframe", "object", "embed", "form", "input", "button",
        "textarea", "select", "option", "base", "link", "meta", "svg", "math",
        "template", "noscript", "frame", "frameset", "applet", "marquee",
    ],
    FORBID_ATTR: ["srcset", "formaction", "action", "background", "ping", "xlink:href"],
    // Drop what a removed dangerous tag was carrying rather than reflowing its
    // source into the document as text.
    FORBID_CONTENTS: ["script", "style", "noscript", "template", "iframe", "object", "embed"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // NO `USE_PROFILES` HERE. Setting it makes DOMPurify ignore ALLOWED_TAGS and
    // ALLOWED_ATTR entirely and fall back to its own built-in HTML profile —
    // which let <img> through STRICT and simultaneously stripped dir/width/
    // cellpadding off legitimate mail. The allowlists below ARE the profile.
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    WHOLE_DOCUMENT: false,
    // <template>/<slot> shadow tricks and mXSS carriers.
    SANITIZE_DOM: true,
};
/* ── hooks ────────────────────────────────────────────────────────────── */
/**
 * CSS scrub. Modern browsers no longer execute `expression()` or
 * `-moz-binding`, and `url(javascript:…)` is inert in a style attribute — but
 * `style` is the one attribute we let through with a free-form value, so it
 * gets checked rather than trusted. `url()` goes entirely: a background image
 * in a support email is a tracking pixel with extra steps.
 */
const DANGEROUS_CSS = /(?:expression\s*\(|behaviou?r\s*:|-moz-binding|@import|javascript\s*:|url\s*\()/gi;
function scrubStyle(value) {
    if (!DANGEROUS_CSS.test(value)) {
        DANGEROUS_CSS.lastIndex = 0;
        return value;
    }
    DANGEROUS_CSS.lastIndex = 0;
    // Drop only the offending declarations, keep the rest of the rule intact so
    // a table that also sets padding does not lose its padding.
    return value
        .split(";")
        .filter((decl) => {
        const dirty = DANGEROUS_CSS.test(decl);
        DANGEROUS_CSS.lastIndex = 0;
        return !dirty;
    })
        .join(";");
}
let hooksInstalled = false;
function installHooks() {
    if (hooksInstalled)
        return;
    hooksInstalled = true;
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
        if (!node || typeof node.getAttribute !== "function")
            return;
        // Every surviving link opens away from the console and carries no
        // referrer, no opener handle, and no ranking signal. window.opener is the
        // one capability a plain <a> can still hand an attacker, so it is closed
        // here rather than left to whatever target the author wrote.
        if (node.tagName === "A" && node.hasAttribute("href")) {
            node.setAttribute("target", "_blank");
            node.setAttribute("rel", "noopener noreferrer nofollow");
        }
        if (node.hasAttribute && node.hasAttribute("style")) {
            const cleaned = scrubStyle(node.getAttribute("style") || "");
            if (cleaned.trim())
                node.setAttribute("style", cleaned);
            else
                node.removeAttribute("style");
        }
    });
}
/* ── the public surface ───────────────────────────────────────────────── */
function run(html, profile) {
    const input = String(html ?? "");
    if (!input)
        return "";
    installHooks();
    return DOMPurify.sanitize(input, {
        ...BASE_OPTIONS,
        ALLOWED_TAGS: profile.ALLOWED_TAGS,
        ALLOWED_ATTR: profile.ALLOWED_ATTR,
        ALLOWED_URI_REGEXP: profile.ALLOWED_URI_REGEXP,
        ADD_URI_SAFE_ATTR: profile.ADD_URI_SAFE_ATTR,
        // target/rel are set by the hook above, so they must survive the
        // attribute allowlist even though no author is permitted to write them.
        ADD_ATTR: ["target", "rel"],
    });
}
/**
 * Agent-authored content and anything a consumer's browser will render.
 * TipTap's output passes through unchanged.
 */
export function sanitizeStrictHtml(html) {
    return run(html, STRICT_HTML_PROFILE);
}
/**
 * Ingested email, the quote trail, and the admin console's render of them.
 * Keeps mail looking like mail; keeps it from doing anything.
 */
export function sanitizeEmailHtml(html) {
    return run(html, EMAIL_HTML_PROFILE);
}
/**
 * Which profile a stored TicketMessage was written under. The backfill and the
 * admin renderer both need this answer and must not disagree about it, so the
 * rule lives here: anything that travelled as mail is mail-shaped; everything
 * else is agent-authored.
 */
export function sanitizeTicketBody(html, channel) {
    return String(channel).toUpperCase() === "EMAIL"
        ? sanitizeEmailHtml(html)
        : sanitizeStrictHtml(html);
}
