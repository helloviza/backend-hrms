// apps/backend/src/services/cstepEmailLayout.ts
//
// The CSTEP Travel & Claim Portal email skin — every CSTEP notification
// (services/cstepNotifications.ts renderCstepEmail) and the settings page's
// test email (routes/cstep.notificationSettings.ts). White-label CSTEP: no
// Plumtrips branding anywhere. Visual reference: docs/design/cstep-emails/
// Email_Layout.png (a design mock-up — never served, never referenced from
// an email). Self-contained on purpose: it shares nothing with Plumtrips'
// approvalEmails/layout.ts except where images are served from (assetBase).
//
//   header (logo · portal name · EVIDENCE / INSIGHT / IMPACT)
//   → band: the airport photo (positive events) or a plain CSTEP-blue band
//     (corrective events) — never text over an image
//   → hero section (eyebrow, badge, headline)
//   → "Dear …," + instruction → facts grid → reason box → button + plain link
//   → "What happens next" → footer (small logo, contacts, notice, copyright)
//
// Email-safe by construction: 600px, nested tables, inline CSS, system fonts
// (Georgia for headings), no SVG, no background images, a VML button for
// Outlook desktop, an MSO ghost table, a dark-mode stylesheet for Apple Mail /
// iOS / Outlook.com ([data-ogsc]). The header and footer stay white in dark
// mode so the colour logo keeps its contrast.
//
// Every text input is PLAIN text: this module escapes all of it, and the same
// input renders the plain-text alternative (renderCstepEmailText), so the two
// parts of a message can never say different things.
import { escapeHtml } from "../routes/approvals.email.js";
import { assetBase } from "./approvalEmails/layout.js";

/* ───────────────────────── tokens ───────────────────────── */

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
const SERIF = `Georgia,'Times New Roman',Times,serif`;
const C = {
  page: "#eef2f8",
  card: "#ffffff",
  soft: "#f3f6fb",
  line: "#dfe5ee",
  ink: "#14213d",
  body: "#3d4b63",
  muted: "#6b778c",
  blue: "#24448e", // the logo's blue
  orange: "#f58d22", // the logo's orange
  noteBg: "#fff5ec",
  noteLine: "#f6c99c",
  noteInk: "#a3510b",
};

export type CstepTone = "orange" | "green" | "red" | "blue";
const TONE: Record<CstepTone, { bg: string; fg: string; line: string }> = {
  orange: { bg: "#fdecd9", fg: "#a3510b", line: "#f6c99c" },
  green: { bg: "#e3f4e9", fg: "#17663a", line: "#b9e2c6" },
  red: { bg: "#fde4e2", fg: "#b42318", line: "#f5b8b2" },
  blue: { bg: "#e4ebf7", fg: "#24448e", line: "#bfcde8" },
};

const W = 600;
const PAD = 32;
const CONTENT_W = W - 2 * PAD; // 536

/**
 * The fixed part of the footer's contact line. The email address is not here:
 * it comes from the workspace's notification settings (input.contactEmail).
 */
export const CSTEP_CONTACT = {
  phone: "+91 11 4063 4300",
  website: "www.cstep.in",
  websiteHref: "https://www.cstep.in",
};
const CSTEP_LEGAL_NAME = "Center for Study of Science, Technology & Policy (CSTEP)";

/** Every image this skin references — served from assetBase(), like the approval emails. */
export const CSTEP_EMAIL_ASSETS = ["CSTEP-Logo_Color.png", "Airport_Hero.jpg"] as const;
const asset = (file: (typeof CSTEP_EMAIL_ASSETS)[number]) => `${assetBase()}/${file}`;

// Intrinsic sizes: logo 2963×1313; hero photo 1200×450 (2× the 600px band,
// JPG ~70 KB — the 2048px source PNG was 1.8 MB).
const LOGO = { header: { w: 150, h: 66 }, footer: { w: 104, h: 46 } };
const PHOTO_H = Math.round((W * 450) / 1200); // 225

/* ───────────────────────── input ───────────────────────── */

export type CstepFact = { label: string; value: string };
export type CstepStep = { title: string; detail: string };

export type CstepEmailInput = {
  /** <title>; also the plain-text first line when there is no headline. */
  title: string;
  /** Inbox preview line. */
  preheader: string;
  /** "photo" on positive events, "plain" (CSTEP blue, no photo) on corrective ones. */
  band: "photo" | "plain";
  hero: { badge: string; tone: CstepTone; headline: string };
  /** "Dear …," line, without the comma. Empty = no greeting. */
  greeting: string;
  /** The one-line instruction under the greeting. */
  intro: string;
  /** Label / value pairs, two per row. */
  facts: CstepFact[];
  /** Reason / note box; multi-line text keeps its line breaks. */
  note?: { label: string; text: string };
  /** The button; omitted = no button and no link (the test email). */
  cta?: { label: string; href: string };
  /** "What happens next" steps; empty = no strip. */
  nextSteps?: CstepStep[];
  /**
   * The footer's contact address — the settings' reply-to, else the sender
   * mailbox (cstepContactEmail), so it always matches where replies go.
   * Empty = the footer shows no email.
   */
  contactEmail?: string;
};

/* ───────────────────────── small pieces ───────────────────────── */

const esc = (s: unknown) => escapeHtml(s);

/** Escaped text with its line breaks kept (Outlook ignores white-space:pre-wrap). */
export const escapeMultiline = (s: unknown) => esc(String(s ?? "").replace(/\r\n?/g, "\n")).replace(/\n/g, "<br />");

const T = `role="presentation" cellpadding="0" cellspacing="0" border="0"`;

const gap = (h: number, cls = "bg-card", bg = C.card) =>
  `<tr><td class="${cls}" height="${h}" style="height:${h}px;font-size:0;line-height:0;background:${bg};" bgcolor="${bg}">&nbsp;</td></tr>`;

/** A full-width body row with side padding. */
const row = (inner: string, top = 0) =>
  `<tr><td class="px bg-card" style="padding:${top}px ${PAD}px 0 ${PAD}px;background:${C.card};" bgcolor="${C.card}">${inner}</td></tr>`;

const hairline = (color = C.line) =>
  `<table ${T} width="100%"><tr><td class="bd" height="1" style="height:1px;font-size:0;line-height:0;border-top:1px solid ${color};">&nbsp;</td></tr></table>`;

/* ───────────────────────── header ───────────────────────── */

function header() {
  return `<tr><td class="px keep-white" style="padding:22px ${PAD}px 20px ${PAD}px;background:#ffffff;" bgcolor="#ffffff">
    <table ${T} width="100%"><tr>
      <td class="stack" width="${LOGO.header.w}" valign="middle" style="width:${LOGO.header.w}px;">
        <img src="${asset("CSTEP-Logo_Color.png")}" width="${LOGO.header.w}" height="${LOGO.header.h}" alt="CSTEP" style="display:block;width:${LOGO.header.w}px;height:${LOGO.header.h}px;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:28px;line-height:${LOGO.header.h}px;font-weight:800;color:${C.blue};" />
      </td>
      <td class="stack head-mid" valign="middle" align="center" style="padding:0 12px;font-family:${FONT};">
        <div style="font-family:${SERIF};font-size:16px;line-height:22px;font-weight:700;color:${C.blue};">CSTEP Travel &amp; Claim Portal</div>
        <div style="margin-top:3px;font-size:12px;line-height:17px;color:${C.muted};">Official Travel Management System</div>
      </td>
      <td class="stack head-tag" width="104" valign="middle" style="width:104px;padding-left:16px;border-left:1px solid ${C.line};font-family:${FONT};font-size:10px;line-height:17px;font-weight:600;letter-spacing:1.6px;color:${C.blue};">
        EVIDENCE<br />INSIGHT<br />IMPACT
        <table ${T} width="44" style="width:44px;margin-top:6px;"><tr><td height="2" style="height:2px;font-size:0;line-height:0;background:${C.orange};" bgcolor="${C.orange}">&nbsp;</td></tr></table>
      </td>
    </tr></table>
  </td></tr>`;
}

/* ───────────────────────── band + hero ───────────────────────── */

function band(kind: CstepEmailInput["band"]) {
  if (kind === "photo") {
    // Decorative (empty alt): with images off, the hero section below still says everything.
    return `<tr><td style="padding:0;font-size:0;line-height:0;background:${C.blue};" bgcolor="${C.blue}">
      <img src="${asset("Airport_Hero.jpg")}" width="${W}" height="${PHOTO_H}" alt="" class="hero-img" style="display:block;width:100%;max-width:${W}px;height:auto;border:0;outline:none;text-decoration:none;" />
    </td></tr>`;
  }
  return `<tr><td height="14" style="height:14px;font-size:0;line-height:0;background:${C.blue};" bgcolor="${C.blue}">&nbsp;</td></tr>`;
}

function hero(h: CstepEmailInput["hero"]) {
  const t = TONE[h.tone];
  return `<tr><td class="px bg-card" style="padding:26px ${PAD}px 0 ${PAD}px;background:${C.card};" bgcolor="${C.card}">
    <table ${T}><tr>
      <td width="28" style="width:28px;padding-right:10px;" valign="middle"><table ${T} width="28" style="width:28px;"><tr><td height="3" style="height:3px;font-size:0;line-height:0;background:${C.orange};" bgcolor="${C.orange}">&nbsp;</td></tr></table></td>
      <td valign="middle" class="t-muted" style="font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;color:${C.blue};">Travel &amp; Claim Portal</td>
    </tr></table>
    <table ${T} style="margin-top:16px;"><tr>
      <td class="badge-${h.tone}" style="background:${t.bg};border:1px solid ${t.line};border-radius:6px;padding:5px 11px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${t.fg};" bgcolor="${t.bg}">${esc(h.badge)}</td>
    </tr></table>
    <h1 class="t-main hero-h" style="margin:14px 0 0 0;font-family:${SERIF};font-size:30px;line-height:37px;font-weight:700;color:${C.ink};mso-line-height-rule:exactly;">${esc(h.headline)}</h1>
  </td></tr>`;
}

/* ───────────────────────── body ───────────────────────── */

function greeting(name: string, intro: string) {
  return row(
    `${name ? `<div class="t-main" style="font-family:${SERIF};font-size:20px;line-height:28px;font-weight:700;color:${C.ink};">Dear ${esc(name)},</div>` : ""}
     ${intro ? `<p class="t-body" style="margin:${name ? 8 : 0}px 0 0 0;font-family:${FONT};font-size:15px;line-height:23px;color:${C.body};">${esc(intro)}</p>` : ""}`,
    22,
  );
}

/** Label above value, two per row (one per row on phones). Labels sit alone in their element. */
function factsGrid(facts: CstepFact[]) {
  if (!facts.length) return "";
  const rows: string[] = [];
  for (let i = 0; i < facts.length; i += 2) {
    const pair = facts.slice(i, i + 2);
    const last = i + 2 >= facts.length;
    const cell = (f: CstepFact, right: boolean) =>
      `<td class="stack fact${right ? " fact-r" : ""}" width="50%" valign="top" style="width:50%;padding:12px ${right ? 0 : 16}px 12px ${right ? 16 : 0}px;${last ? "" : `border-bottom:1px solid ${C.line};`}font-family:${FONT};">
        <div class="t-muted" style="font-size:12px;line-height:16px;color:${C.muted};">${esc(f.label)}</div>
        <div class="t-main" style="margin-top:2px;font-size:14px;line-height:20px;font-weight:700;color:${C.ink};">${esc(f.value)}</div>
      </td>`;
    rows.push(`<tr>${cell(pair[0], false)}${pair[1] ? cell(pair[1], true) : `<td class="stack hide-sm" width="50%" style="width:50%;${last ? "" : `border-bottom:1px solid ${C.line};`}">&nbsp;</td>`}</tr>`);
  }
  return row(
    `<table ${T} width="100%" class="bd" style="width:100%;border:1px solid ${C.line};border-radius:10px;border-collapse:separate;">
      <tr><td style="padding:4px 18px;">
        <table ${T} width="100%">${rows.join("")}</table>
      </td></tr>
    </table>`,
    20,
  );
}

function noteBox(note: CstepEmailInput["note"]) {
  if (!note || !String(note.text || "").trim()) return "";
  return row(
    `<table ${T} width="100%" class="bg-note" style="width:100%;background:${C.noteBg};border:1px solid ${C.noteLine};border-left:4px solid ${C.orange};border-radius:8px;border-collapse:separate;" bgcolor="${C.noteBg}">
      <tr><td style="padding:14px 18px;font-family:${FONT};">
        <div class="t-note" style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${C.noteInk};">${esc(note.label)}</div>
        <div class="t-main" style="margin-top:4px;font-size:15px;line-height:23px;color:${C.ink};">${escapeMultiline(note.text)}</div>
      </td></tr>
    </table>`,
    18,
  );
}

/**
 * Bulletproof button: a VML roundrect for Outlook desktop, a padded link for
 * everything else. Solid colours only. Centred, fixed width.
 */
function button(cta: NonNullable<CstepEmailInput["cta"]>) {
  const w = 300;
  const href = esc(cta.href);
  const label = `${esc(cta.label)}&nbsp;&nbsp;&rarr;`;
  return row(
    `<table ${T} width="100%"><tr><td align="center">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:50px;v-text-anchor:middle;width:${w}px;" arcsize="12%" stroke="f" fillcolor="${C.blue}">
        <w:anchorlock/>
        <center style="color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:bold;">${label}</center>
      </v:roundrect>
      <![endif]--><!--[if !mso]><!-- --><a href="${href}" class="btn" style="display:inline-block;width:${w}px;max-width:100%;box-sizing:border-box;background:${C.blue};border-radius:6px;color:#ffffff;font-family:${FONT};font-size:16px;line-height:50px;font-weight:700;text-align:center;text-decoration:none;mso-hide:all;">${label}</a><!--<![endif]-->
    </td></tr>
    <tr><td align="center" class="t-muted" style="padding-top:12px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">
      Button not working? Open <a href="${href}" class="t-blue" style="color:${C.blue};text-decoration:underline;word-break:break-all;">${esc(cta.href)}</a>
    </td></tr></table>`,
    24,
  );
}

function nextSteps(steps: CstepStep[] | undefined) {
  if (!steps?.length) return "";
  const w = Math.floor(100 / steps.length);
  const cells = steps
    .map(
      (s, i) => `<td class="stack step${i ? " step-div" : ""}" width="${w}%" valign="top" style="width:${w}%;padding:4px ${i < steps.length - 1 ? 14 : 0}px 4px ${i ? 14 : 0}px;${i ? `border-left:1px solid ${C.line};` : ""}font-family:${FONT};">
        ${steps.length > 1 ? `<div class="t-blue" style="font-size:12px;line-height:16px;font-weight:700;color:${C.orange};">${i + 1}</div>` : ""}
        <div class="t-main" style="margin-top:2px;font-size:14px;line-height:19px;font-weight:700;color:${C.ink};">${esc(s.title)}</div>
        <div class="t-body" style="margin-top:3px;font-size:13px;line-height:19px;color:${C.body};">${esc(s.detail)}</div>
      </td>`,
    )
    .join("");
  return row(
    `<table ${T} width="100%" class="bg-soft" style="width:100%;background:${C.soft};border-radius:10px;border-collapse:separate;" bgcolor="${C.soft}">
      <tr><td style="padding:18px 20px;">
        <div class="t-main" style="font-family:${SERIF};font-size:18px;line-height:24px;font-weight:700;color:${C.blue};">What happens next?</div>
        <table ${T} width="100%" style="margin-top:12px;"><tr>${cells}</tr></table>
      </td></tr>
    </table>`,
    28,
  );
}

/* ───────────────────────── footer ───────────────────────── */

function footer(contactEmail: string) {
  const c = CSTEP_CONTACT;
  const link = (href: string, text: string) =>
    `<a href="${esc(href)}" style="color:${C.blue};text-decoration:none;">${esc(text)}</a>`;
  const contacts = [
    ...(contactEmail ? [link(`mailto:${contactEmail}`, contactEmail)] : []),
    link(`tel:${c.phone.replace(/\s+/g, "")}`, c.phone),
    link(c.websiteHref, c.website),
  ].join(`<span style="color:${C.line};">&nbsp;&nbsp;|&nbsp;&nbsp;</span>`);
  const year = new Date().getFullYear();
  return `<tr><td class="px keep-white" style="padding:28px ${PAD}px 26px ${PAD}px;background:#ffffff;" bgcolor="#ffffff">
    ${hairline()}
    <table ${T} width="100%" style="margin-top:18px;"><tr>
      <td class="stack" width="${LOGO.footer.w + 16}" valign="middle" style="width:${LOGO.footer.w + 16}px;padding-right:16px;">
        <img src="${asset("CSTEP-Logo_Color.png")}" width="${LOGO.footer.w}" height="${LOGO.footer.h}" alt="CSTEP" style="display:block;width:${LOGO.footer.w}px;height:${LOGO.footer.h}px;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:18px;line-height:${LOGO.footer.h}px;font-weight:800;color:${C.blue};" />
      </td>
      <td class="stack foot-contacts" valign="middle" align="right" style="font-family:${FONT};font-size:13px;line-height:22px;color:${C.blue};">
        ${contacts}
      </td>
    </tr></table>
    <div style="margin-top:18px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};text-align:center;">
      This is an automated email from the CSTEP Travel &amp; Claim Portal.<br />
      &copy; ${year} ${esc(CSTEP_LEGAL_NAME)}. All rights reserved.
    </div>
  </td></tr>`;
}

/* ───────────────────────── document ───────────────────────── */

const STYLE = `
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
  img{-ms-interpolation-mode:bicubic;}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;}
  @media screen and (max-width:620px){
    .container{width:100%!important;max-width:100%!important;}
    .px{padding-left:18px!important;padding-right:18px!important;}
    .stack{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box;}
    .head-mid{padding:12px 0 0 0!important;text-align:left!important;}
    .head-tag{border-left:0!important;padding:10px 0 0 0!important;}
    .fact,.fact-r{padding-left:0!important;padding-right:0!important;}
    .step{padding:10px 0!important;}
    .step-div{border-left:0!important;border-top:1px solid #dfe5ee!important;}
    .foot-contacts{text-align:left!important;padding-top:12px!important;}
    .hide-sm{display:none!important;}
    .hero-h{font-size:26px!important;line-height:32px!important;}
  }
  @media (prefers-color-scheme:dark){
    .bg-page{background:#0b1220!important;}
    .bg-card{background:#111a2b!important;}
    .bg-soft{background:#16233a!important;}
    .bg-note{background:#2a1d12!important;border-color:#5a3a1c!important;}
    .keep-white{background:#ffffff!important;}
    .bd{border-color:#26354d!important;}
    .t-main{color:#eef3fa!important;}
    .t-body{color:#cbd5e1!important;}
    .t-muted{color:#9fb0c5!important;}
    .t-blue{color:#9bb8f0!important;}
    .t-note{color:#f3b27a!important;}
  }
  [data-ogsc] .t-main{color:#eef3fa!important;}
  [data-ogsc] .t-body{color:#cbd5e1!important;}
  [data-ogsc] .t-muted{color:#9fb0c5!important;}
  [data-ogsc] .t-blue{color:#9bb8f0!important;}
  [data-ogsc] .t-note{color:#f3b27a!important;}
`;

export function renderCstepEmailHtml(m: CstepEmailInput): string {
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${esc(m.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>table,td,div,p,a,h1{font-family:'Segoe UI',Arial,sans-serif!important;}</style><![endif]-->
<style>${STYLE}</style>
</head>
<body class="bg-page" style="margin:0;padding:0;width:100%;background:${C.page};" bgcolor="${C.page}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${esc(m.preheader)}&nbsp;&#8199;&#65279;&nbsp;&#8199;&#65279;&nbsp;&#8199;&#65279;&nbsp;&#8199;&#65279;&nbsp;&#8199;&#65279;&nbsp;&#8199;&#65279;</div>
<table ${T} width="100%" class="bg-page" bgcolor="${C.page}" style="background:${C.page};">
<tr><td align="center" style="padding:24px 8px;">
<!--[if mso]><table role="presentation" width="${W}" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table ${T} class="container bg-card" width="${W}" bgcolor="${C.card}" style="width:${W}px;max-width:${W}px;background:${C.card};border-radius:14px;overflow:hidden;border-collapse:separate;">
${header()}
${band(m.band)}
${hero(m.hero)}
${greeting(m.greeting, m.intro)}
${factsGrid(m.facts)}
${noteBox(m.note)}
${m.cta ? button(m.cta) : ""}
${nextSteps(m.nextSteps)}
${gap(8)}
${footer(String(m.contactEmail || "").trim())}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

/** The plain-text alternative, from the same input. */
export function renderCstepEmailText(m: CstepEmailInput): string {
  const out: string[] = [`CSTEP Travel & Claim Portal`, "", `${m.hero.badge.toUpperCase()}: ${m.hero.headline}`, ""];
  if (m.greeting) out.push(`Dear ${m.greeting},`, "");
  if (m.intro) out.push(m.intro, "");
  if (m.facts.length) {
    for (const f of m.facts) out.push(`${f.label}: ${f.value}`);
    out.push("");
  }
  if (m.note && String(m.note.text || "").trim()) out.push(`${m.note.label}:`, String(m.note.text).replace(/\r\n?/g, "\n"), "");
  if (m.cta) out.push(`${m.cta.label}: ${m.cta.href}`, "");
  if (m.nextSteps?.length) {
    out.push("What happens next?");
    m.nextSteps.forEach((s, i) => out.push(`${m.nextSteps!.length > 1 ? `${i + 1}. ` : "- "}${s.title} — ${s.detail}`));
    out.push("");
  }
  const c = CSTEP_CONTACT;
  const contactEmail = String(m.contactEmail || "").trim();
  out.push(
    "--",
    [...(contactEmail ? [contactEmail] : []), c.phone, c.website].join(" | "),
    "This is an automated email from the CSTEP Travel & Claim Portal.",
    `© ${new Date().getFullYear()} ${CSTEP_LEGAL_NAME}. All rights reserved.`,
  );
  return out.join("\n");
}

export function renderCstepEmailLayout(m: CstepEmailInput): { html: string; text: string } {
  return { html: renderCstepEmailHtml(m), text: renderCstepEmailText(m) };
}
