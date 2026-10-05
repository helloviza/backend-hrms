// apps/backend/src/services/approvalEmails/layout.ts
//
// The one email layout every approval email is built from (templates.ts), in
// the order of the design (docs/design/approval-emails/reference/
// Approval_Email_v2.png):
//
//   header → hero (badge, headline, one-line instruction) → summary strip →
//   trip summary → note → itinerary details → buttons → expiry box → footer
//
// Email-safe by construction: 600px, nested tables, inline CSS, system fonts,
// no SVG, VML buttons and hero background for Outlook desktop. Images are
// static PNGs served from the frontend (apps/frontend/public/email-assets,
// made by src/scripts/gen-email-assets.ts); every one is decorative or has
// alt text, so an email read with images off loses nothing. A dark-mode
// stylesheet covers Apple Mail / iOS / Outlook.com; Gmail's own inversion
// keeps it readable because no text sits on an image.
//
// Helpers take ALREADY-ESCAPED HTML for text arguments unless they say
// otherwise — templates.ts escapes (and price-strips) before calling.
import { escapeHtml } from "../../routes/approvals.email.js";

/* ───────────────────────── tokens ───────────────────────── */

export const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
const C = {
  page: "#f2f5f9",
  card: "#ffffff",
  soft: "#f5f8fc",
  hero: "#eef5fc",
  line: "#e2e8f0",
  ink: "#0f1f33",
  body: "#334155",
  muted: "#64748b",
  navy: "#00477f",
  navyDark: "#003866",
  noteBg: "#fdf1ee",
  noteLine: "#f5d3c9",
  noteInk: "#b9452b",
};

export type Tone = "orange" | "green" | "red" | "blue";
const TONE: Record<Tone, { bg: string; fg: string }> = {
  orange: { bg: "#fde8d7", fg: "#b4410c" },
  green: { bg: "#dcf3e4", fg: "#166534" },
  red: { bg: "#fde2e2", fg: "#b42318" },
  blue: { bg: "#dceafa", fg: "#00477f" },
};

export const CONTENT_W = 544; // 600 - 2 × 28 side padding

/** Where the email images live. Overridable for local renders (file:// or a preview host). */
export function assetBase(): string {
  return (process.env.EMAIL_ASSET_BASE || "https://plumbox.plumtrips.com/email-assets").replace(/\/+$/, "");
}
export const asset = (file: string) => `${assetBase()}/${file}`;

/** Every image the layout can reference (the asset list, and what the tests check against). */
export const EMAIL_ASSETS = [
  "logo.png",
  "hero-map.png",
  "route-plane.png",
  "i-workspace.png",
  "i-user.png",
  "i-items.png",
  "i-calendar.png",
  "i-travellers.png",
  "i-clock.png",
  "i-note.png",
  "i-help.png",
  ...["flight", "hotel", "visa", "cab", "forex", "esim", "holiday", "mice", "other"].flatMap((s) => [`s-${s}.png`, `c-${s}.png`]),
];

/* ───────────────────────── small pieces ───────────────────────── */

function img(file: string, w: number, h: number, alt = "", extra = "") {
  return `<img src="${asset(file)}" width="${w}" height="${h}" alt="${escapeHtml(alt)}" style="display:block;width:${w}px;height:${h}px;border:0;outline:none;text-decoration:none;${extra}" />`;
}

/** A spacer row. */
export const gap = (h: number) => `<tr><td height="${h}" style="height:${h}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;

/** Upper-case section label ("TRIP SUMMARY"). */
export function sectionLabel(text: string, color = C.muted) {
  return `<div class="t-muted" style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${color};">${text}</div>`;
}

/** Body paragraph. */
export function para(html: string) {
  return `<div class="t-body" style="font-family:${FONT};font-size:15px;line-height:23px;color:${C.body};">${html}</div>`;
}

/** A white card with a hairline border. */
export function card(inner: string, opts: { bg?: string; padding?: string; cls?: string } = {}) {
  const bg = opts.bg || C.card;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="${opts.cls || "bg-card"} bd" style="width:100%;border:1px solid ${C.line};border-radius:12px;background:${bg};border-collapse:separate;" bgcolor="${bg}">
    <tr><td style="padding:${opts.padding || "16px 18px"};">${inner}</td></tr>
  </table>`;
}

/* ───────────────────────── header ───────────────────────── */

function header() {
  return `<tr><td class="px bg-card" style="padding:18px 28px;background:${C.card};" bgcolor="${C.card}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td valign="middle" style="font-family:${FONT};">
          <img src="${asset("logo.png")}" width="150" height="48" alt="PLUMTRIPS" style="display:block;width:150px;height:48px;border:0;font-family:${FONT};font-size:22px;line-height:48px;font-weight:800;letter-spacing:1px;color:${C.navy};" />
        </td>
        <td valign="middle" align="right" class="hide-sm t-muted" style="font-family:${FONT};font-size:13px;line-height:18px;color:${C.muted};">Your Travel Operations Partner</td>
      </tr>
    </table>
  </td></tr>`;
}

/* ───────────────────────── hero ───────────────────────── */

export type Hero = {
  badge: string;
  tone: Tone;
  /** Escaped HTML. */
  headline: string;
  /** Escaped HTML, one line. */
  instruction?: string;
};

function hero(h: Hero) {
  const t = TONE[h.tone];
  const map = asset("hero-map.png");
  const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td class="px" style="padding:30px 28px 30px 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td class="badge-${h.tone}" style="background:${t.bg};border-radius:6px;padding:5px 10px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${t.fg};" bgcolor="${t.bg}">${h.badge}</td>
        </tr></table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="w100" style="width:300px;max-width:100%;"><tr><td>
          <h1 class="t-main hero-h" style="margin:14px 0 0 0;font-family:${FONT};font-size:30px;line-height:36px;font-weight:800;color:${C.ink};mso-line-height-rule:exactly;">${h.headline}</h1>
          ${h.instruction ? `<p class="t-body" style="margin:10px 0 0 0;font-family:${FONT};font-size:16px;line-height:24px;color:${C.body};">${h.instruction}</p>` : ""}
        </td></tr></table>
      </td></tr>
    </table>`;
  // Background map for every client; VML for Outlook desktop. The map PNG is
  // transparent, so the hero colour (or a dark-mode colour) shows through.
  return `<tr><td class="hero" background="${map}" bgcolor="${C.hero}" valign="top" style="background-color:${C.hero};background-image:url('${map}');background-repeat:no-repeat;background-position:right top;background-size:600px 230px;">
    <!--[if gte mso 9]>
    <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;height:230px;">
      <v:fill type="frame" src="${map}" color="${C.hero}" />
      <v:textbox inset="0,0,0,0">
    <![endif]-->
    ${inner}
    <!--[if gte mso 9]></v:textbox></v:rect><![endif]-->
  </td></tr>`;
}

/* ───────────────────────── summary strip ───────────────────────── */

export type StripCell = { icon: string; label: string; /** Escaped HTML. */ value: string };

export function summaryStrip(cells: StripCell[]) {
  const w = Math.floor(100 / cells.length);
  const tds = cells
    .map(
      (c, i) => `<td class="stack strip-cell${i ? " strip-div" : ""}" width="${w}%" valign="middle" style="width:${w}%;padding:12px 12px;${i ? `border-left:1px solid ${C.line};` : ""}">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="middle" width="36" style="width:36px;padding-right:10px;">${img(c.icon, 36, 36)}</td>
          <td valign="middle" style="font-family:${FONT};">
            <div class="t-muted" style="font-size:12px;line-height:16px;color:${C.muted};">${escapeHtml(c.label)}</div>
            <div class="t-main" style="font-size:14px;line-height:20px;font-weight:700;color:${C.ink};">${c.value}</div>
          </td>
        </tr></table>
      </td>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-card bd" style="width:100%;border:1px solid ${C.line};border-radius:12px;border-collapse:separate;" bgcolor="${C.card}"><tr>${tds}</tr></table>`;
}

/* ───────────────────────── trip summary ───────────────────────── */

export type Fact = { label: string; /** Escaped HTML. */ value: string };

/** Label / value pairs, two per row (one per row on phones). */
export function factsGrid(facts: Fact[]) {
  if (!facts.length) return "";
  const rows: string[] = [];
  for (let i = 0; i < facts.length; i += 2) {
    const pair = facts.slice(i, i + 2);
    rows.push(
      `<tr>${pair
        .map(
          (f) => `<td width="50%" valign="top" style="width:50%;padding:8px 12px 8px 0;font-family:${FONT};">
            <div class="t-muted" style="font-size:12px;line-height:16px;color:${C.muted};">${escapeHtml(f.label)}</div>
            <div class="t-main" style="font-size:14px;line-height:20px;font-weight:600;color:${C.ink};">${f.value}</div>
          </td>`,
        )
        .join("")}${pair.length === 1 ? `<td width="50%" style="width:50%;">&nbsp;</td>` : ""}</tr>`,
    );
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join("")}</table>`;
}

export type RoutePoint = { code: string; city: string };

/** BLR ··· ✈ ··· BOM with the cities underneath. Arguments are plain text. */
export function routeBlock(from: RoutePoint, to: RoutePoint) {
  const end = (p: RoutePoint, align: "left" | "right") => `<td class="route-end" width="120" valign="middle" align="${align}" style="width:120px;font-family:${FONT};">
      <div class="t-main" style="font-size:30px;line-height:34px;font-weight:800;color:${C.ink};letter-spacing:0.5px;">${escapeHtml(p.code || "—")}</div>
      <div class="t-muted" style="font-size:13px;line-height:18px;color:${C.muted};">${escapeHtml(p.city)}</div>
    </td>`;
  const dash = `<td valign="middle" style="padding:0 6px;"><div class="bd" style="border-top:2px dashed #b8cde3;height:0;line-height:0;font-size:0;">&nbsp;</div></td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      ${end(from, "left")}
      <td valign="middle"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        ${dash}<td width="28" valign="middle" style="width:28px;">${img("route-plane.png", 28, 28)}</td>${dash}
      </tr></table></td>
      ${end(to, "right")}
    </tr></table>`;
}

/** The heading row of a non-flight card: service icon, title, subtitle (escaped HTML). */
export function placeBlock(service: string, title: string, subtitle: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="44" valign="middle" style="width:44px;padding-right:12px;">${img(`c-${service}.png`, 44, 44)}</td>
      <td valign="middle" style="font-family:${FONT};">
        <div class="t-main" style="font-size:20px;line-height:26px;font-weight:800;color:${C.ink};">${title}</div>
        ${subtitle ? `<div class="t-muted" style="font-size:13px;line-height:18px;color:${C.muted};">${subtitle}</div>` : ""}
      </td>
    </tr></table>`;
}

/** Multi-city legs: one line each. Arguments are escaped HTML. */
export function legList(legs: Array<{ route: string; detail: string }>) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${legs
    .map(
      (l, i) => `<tr>
        <td width="26" valign="top" style="width:26px;padding:6px 0;font-family:${FONT};font-size:12px;line-height:20px;font-weight:700;color:${C.navy};" class="t-navy">${i + 1}</td>
        <td valign="top" style="padding:6px 0;font-family:${FONT};">
          <span class="t-main" style="font-size:14px;line-height:20px;font-weight:700;color:${C.ink};">${l.route}</span>
          <span class="t-muted" style="font-size:13px;line-height:20px;color:${C.muted};">&nbsp;·&nbsp;${l.detail}</span>
        </td>
      </tr>`,
    )
    .join("")}</table>`;
}

/** A section label with the request number on the right ("TRIP SUMMARY ··· REQ-AB34CD"). `code` is plain text. */
export function requestHeading(label: string, code = "") {
  if (!code) return sectionLabel(escapeHtml(label));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle">${sectionLabel(escapeHtml(label))}</td>
      <td valign="middle" align="right" class="t-muted" style="font-family:${FONT};font-size:13px;line-height:16px;color:${C.muted};">Request <b class="t-main" style="color:${C.ink};">${escapeHtml(code)}</b></td>
    </tr></table>`;
}

/** "TRIP SUMMARY" card: heading block, optional legs, then facts. */
export function tripSummary(opts: { top: string; legs?: string; facts: Fact[]; code?: string }) {
  return card(
    `${requestHeading("Trip summary", opts.code)}
     <div style="height:12px;line-height:12px;font-size:0;">&nbsp;</div>
     ${opts.top}
     ${opts.legs ? `<div class="bd" style="border-top:1px solid ${C.line};margin:14px 0 6px 0;height:0;line-height:0;font-size:0;">&nbsp;</div>${opts.legs}` : ""}
     ${opts.facts.length ? `<div class="bd" style="border-top:1px solid ${C.line};margin:14px 0 4px 0;height:0;line-height:0;font-size:0;">&nbsp;</div>${factsGrid(opts.facts)}` : ""}`,
    { bg: C.soft, cls: "bg-soft", padding: "18px 20px" },
  );
}

/* ───────────────────────── note box ───────────────────────── */

/** Tinted note ("REQUEST NOTE", "QUESTION", "REASON"…). `html` is escaped text. */
export function noteBox(label: string, html: string) {
  if (!html) return "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-note" style="width:100%;border:1px solid ${C.noteLine};border-radius:12px;background:${C.noteBg};border-collapse:separate;" bgcolor="${C.noteBg}"><tr>
      <td width="36" valign="top" style="width:36px;padding:16px 0 16px 16px;">${img("i-note.png", 36, 36)}</td>
      <td valign="top" style="padding:14px 18px 16px 12px;font-family:${FONT};">
        ${sectionLabel(escapeHtml(label), C.noteInk).replace('class="t-muted"', 'class="t-note"')}
        <div class="t-main" style="margin-top:4px;font-size:15px;line-height:23px;color:${C.ink};white-space:pre-wrap;">${html}</div>
      </td>
    </tr></table>`;
}

/* ───────────────────────── itinerary ───────────────────────── */

export type ItineraryRow = {
  service: string;
  /** Escaped HTML. */
  title: string;
  /** Escaped HTML lines. */
  lines: string[];
};

export function itinerary(rows: ItineraryRow[], href: string, label = "Itinerary details") {
  if (!rows.length) return "";
  const body = rows
    .map((r) => {
      const title = href
        ? `<a href="${href}" class="t-main" style="color:${C.ink};text-decoration:none;">${r.title}</a>`
        : r.title;
      return `<tr><td style="padding:0 0 10px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-card bd" style="width:100%;border:1px solid ${C.line};border-radius:12px;border-collapse:separate;" bgcolor="${C.card}"><tr>
          <td width="48" valign="top" style="width:48px;padding:14px 0 14px 14px;">${img(`s-${r.service}.png`, 48, 48)}</td>
          <td valign="middle" style="padding:12px 14px;font-family:${FONT};">
            <div style="font-size:15px;line-height:22px;font-weight:700;color:${C.ink};" class="t-main">${title}</div>
            ${r.lines.map((l) => `<div class="t-muted" style="font-size:14px;line-height:21px;color:${C.muted};">${l}</div>`).join("")}
          </td>
          ${href ? `<td width="28" valign="middle" align="center" style="width:28px;padding-right:12px;font-family:${FONT};"><a href="${href}" class="t-muted" style="font-size:24px;line-height:24px;color:#94a3b8;text-decoration:none;">&rsaquo;</a></td>` : ""}
        </tr></table>
      </td></tr>`;
    })
    .join("");
  return `${sectionLabel(escapeHtml(label))}
    <div style="height:10px;line-height:10px;font-size:0;">&nbsp;</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>`;
}

/* ───────────────────────── buttons ───────────────────────── */

export type ButtonStyle = "primary" | "danger" | "warn";
const BTN: Record<ButtonStyle, { fill: string; text: string; line: string }> = {
  primary: { fill: C.navy, text: "#ffffff", line: C.navy },
  danger: { fill: "#ffffff", text: "#b42318", line: "#e5484d" },
  warn: { fill: "#ffffff", text: "#b4410c", line: "#ea8a3c" },
};

/**
 * Bulletproof button: a VML roundrect for Outlook desktop, a padded link for
 * everything else. Solid colours only. `label` is plain text.
 */
export function button(label: string, href: string, style: ButtonStyle, width: number, glyph = "") {
  const b = BTN[style];
  const text = `${glyph ? `${glyph}&nbsp;&nbsp;` : ""}${escapeHtml(label)}`;
  return `<!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:${width}px;" arcsize="17%" strokecolor="${b.line}" strokeweight="1.5px" fillcolor="${b.fill}">
      <w:anchorlock/>
      <center style="color:${b.text};font-family:'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:bold;">${text}</center>
    </v:roundrect>
    <![endif]--><!--[if !mso]><!-- --><a href="${href}" class="btn btn-${style}" style="display:block;width:100%;box-sizing:border-box;background:${b.fill};border:1.5px solid ${b.line};border-radius:8px;color:${b.text};font-family:${FONT};font-size:16px;line-height:46px;font-weight:700;text-align:center;text-decoration:none;mso-hide:all;">${text}</a><!--<![endif]-->`;
}

/** A full-width primary button, then (optionally) two side-by-side secondaries. */
export function buttonGroup(primary: { label: string; href: string; glyph?: string }, secondary: Array<{ label: string; href: string; style: ButtonStyle; glyph?: string }> = []) {
  const half = Math.floor((CONTENT_W - 12) / 2);
  const second = secondary.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;"><tr>
        ${secondary
          .map(
            (s, i) =>
              `<td class="stack${i ? " btn-gap" : ""}" width="${half}" valign="top" style="width:${half}px;${i ? "padding-left:12px;" : ""}">${button(s.label, s.href, s.style, half, s.glyph)}</td>`,
          )
          .join("")}
      </tr></table>`
    : "";
  return `${button(primary.label, primary.href, "primary", CONTENT_W, primary.glyph)}${second}`;
}

/* ───────────────────────── expiry box ───────────────────────── */

/** The decision-link notice. `text` is plain text. */
export function expiryBox(text: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-soft" style="width:100%;border-radius:12px;background:${C.soft};border-collapse:separate;" bgcolor="${C.soft}"><tr>
      <td width="36" valign="middle" style="width:36px;padding:14px 0 14px 16px;">${img("i-clock.png", 36, 36)}</td>
      <td valign="middle" class="t-body" style="padding:14px 18px 14px 12px;font-family:${FONT};font-size:14px;line-height:21px;color:${C.body};">${escapeHtml(text)}</td>
    </tr></table>`;
}

/* ───────────────────────── footer ───────────────────────── */

export const DESK_MAILBOX = "ops@plumtrips.com";

function customerFooter() {
  return `<tr><td class="px bg-card" style="padding:0 28px 28px 28px;background:${C.card};" bgcolor="${C.card}">
    <div class="bd" style="border-top:1px solid ${C.line};height:0;line-height:0;font-size:0;">&nbsp;</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;"><tr>
      <td class="stack" width="136" valign="middle" style="width:136px;padding-right:14px;">
        <img src="${asset("logo.png")}" width="120" height="38" alt="PLUMTRIPS" style="display:block;width:120px;height:38px;border:0;font-family:${FONT};font-size:15px;line-height:19px;font-weight:800;letter-spacing:1px;color:${C.navy};" />
      </td>
      <td class="stack foot-mid" valign="middle" style="padding:0 16px;border-left:1px solid ${C.line};font-family:${FONT};font-size:13px;line-height:19px;color:${C.muted};"><span class="t-muted">Your Travel Operations Partner for Businesses That Move</span></td>
      <td class="stack foot-mid" width="200" valign="middle" style="width:200px;padding-left:16px;border-left:1px solid ${C.line};">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="32" valign="top" style="width:32px;padding-right:10px;">${img("i-help.png", 32, 32)}</td>
          <td valign="top" style="font-family:${FONT};font-size:13px;line-height:19px;color:${C.body};" class="t-body">
            <b class="t-main" style="color:${C.ink};">Questions?</b><br />
            Reply to this email or write to <a href="mailto:${DESK_MAILBOX}" class="t-navy" style="color:${C.navy};text-decoration:underline;">${DESK_MAILBOX}</a>
          </td>
        </tr></table>
      </td>
    </tr></table>
  </td></tr>`;
}

function staffFooter() {
  return `<tr><td class="px bg-card" style="padding:0 28px 24px 28px;background:${C.card};" bgcolor="${C.card}">
    <div class="bd" style="border-top:1px solid ${C.line};height:0;line-height:0;font-size:0;">&nbsp;</div>
    <div class="t-muted" style="margin-top:14px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">
      Plumtrips Travel Desk — internal notification for the ops team. Do not forward to customers.
    </div>
  </td></tr>`;
}

/* ───────────────────────── document ───────────────────────── */

export type EmailLayout = {
  /** <title> and preheader are plain text. */
  title: string;
  preheader: string;
  hero: Hero;
  /** Body blocks in order; empty strings are skipped. Each is a full-width block. */
  blocks: string[];
  footer: "customer" | "staff";
};

const STYLE = `
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
  img{-ms-interpolation-mode:bicubic;}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;}
  @media screen and (max-width:620px){
    .container{width:100%!important;max-width:100%!important;}
    .px{padding-left:16px!important;padding-right:16px!important;}
    .stack{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box;}
    .strip-div{border-left:0!important;border-top:1px solid #e2e8f0!important;}
    .foot-mid{border-left:0!important;padding:12px 0 0 0!important;}
    .btn-gap{padding-left:0!important;padding-top:12px!important;}
    .hide-sm{display:none!important;}
    .w100{width:100%!important;}
    .hero-h{font-size:26px!important;line-height:32px!important;}
    .hero{background-image:none!important;}
    .route-end{width:96px!important;}
  }
  @media (prefers-color-scheme:dark){
    .bg-page{background:#0b1220!important;}
    .bg-card{background:#111a2b!important;}
    .bg-soft{background:#16233a!important;}
    .bg-note{background:#2a1b17!important;border-color:#5a3328!important;}
    .hero{background-color:#0f2037!important;}
    .bd{border-color:#26354d!important;}
    .t-main{color:#eef3fa!important;}
    .t-body{color:#cbd5e1!important;}
    .t-muted{color:#9fb0c5!important;}
    .t-navy{color:#8cc4f5!important;}
    .t-note{color:#f0a18b!important;}
    .btn-danger,.btn-warn{background:#111a2b!important;}
  }
  [data-ogsc] .t-main{color:#eef3fa!important;}
  [data-ogsc] .t-body{color:#cbd5e1!important;}
  [data-ogsc] .t-muted{color:#9fb0c5!important;}
  [data-ogsc] .t-navy{color:#8cc4f5!important;}
`;

export function renderLayout(l: EmailLayout): string {
  const blocks = l.blocks
    .filter(Boolean)
    .map((b, i) => `<tr><td class="px bg-card" style="padding:${i ? 20 : 24}px 28px 0 28px;background:${C.card};" bgcolor="${C.card}">${b}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${escapeHtml(l.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>table,td,div,p,a,h1{font-family:'Segoe UI',Arial,sans-serif!important;}</style><![endif]-->
<style>${STYLE}</style>
</head>
<body class="bg-page" style="margin:0;padding:0;width:100%;background:${C.page};" bgcolor="${C.page}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${escapeHtml(l.preheader)}&nbsp;&#8199;&#65279;&nbsp;&#8199;&#65279;&nbsp;&#8199;&#65279;&nbsp;&#8199;&#65279;&nbsp;&#8199;&#65279;&nbsp;&#8199;&#65279;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-page" bgcolor="${C.page}" style="background:${C.page};">
<tr><td align="center" style="padding:24px 8px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" class="container bg-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="width:600px;max-width:600px;background:${C.card};border-radius:14px;overflow:hidden;border-collapse:separate;">
${header()}
${hero(l.hero)}
${blocks}
<tr><td class="bg-card" height="28" style="height:28px;font-size:0;line-height:0;background:${C.card};" bgcolor="${C.card}">&nbsp;</td></tr>
${l.footer === "customer" ? customerFooter() : staffFooter()}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}
