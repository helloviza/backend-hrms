// apps/backend/src/utils/piiMask.ts
// Shared last-4 masking for passport/PAN-shaped identifiers — used by any
// list/export view that must not hand out full numbers to every reader with
// READ access (see docs/audits/traveller-profiles-scoping.md §4.3).
export function maskTailId(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return value as any;
  const str = String(value);
  return str.length <= 4 ? "*".repeat(str.length) : "*".repeat(str.length - 4) + str.slice(-4);
}

/* ─────────────────────────────────────────────────────────────────────
 * PASSPORT VAULT MASKING — for the ops/cross-tenant dossier when the
 * caller does not hold travellerIdentityPII (models/UserPermission.ts).
 *
 * resolvePassportVault() (routes/workspace.travellers.ts) echoes the
 * passport number in THREE places besides the traveller record itself,
 * and masking the record alone would hand the number straight back through
 * the tab beside it:
 *   - mrz.line2         — a TD3 line 2 opens with the 9-character document
 *                         number field (positions 0–8), then its check digit;
 *   - scan.documentNumber — what the passport scan was read as;
 *   - mismatch.comparison — per-field rows whose `field` is "documentNumber"
 *                         carry the typed and extracted values side by side.
 * Everything else in the vault (names, dates, nationality, corroboration
 * state) is what the dossier's own fields already show, and stays.
 *
 * Deliberately a deep, key-driven walk rather than a hand-written copy of
 * the vault's shape: the vault has grown fields three times already, and a
 * shape-copy would silently stop masking the next one.
 * ───────────────────────────────────────────────────────────────────── */
const MRZ_TD3_DOC_NUMBER_LEN = 9;
const ALWAYS_MASK_KEYS = new Set(["passportNo", "documentNumber", "passportValue", "fileValue", "profileValue"]);
const VALUE_KEYS_MASKED_FOR_DOC_NUMBER = new Set(["typedValue", "extractedValue", "mrzValue", "vizValue", "value"]);

export function maskMrzLine2(line: unknown): unknown {
  if (typeof line !== "string" || !line) return line;
  const head = line.slice(0, MRZ_TD3_DOC_NUMBER_LEN);
  return (maskTailId(head) ?? head) + line.slice(MRZ_TD3_DOC_NUMBER_LEN);
}

export function maskPassportVault<T>(vault: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: any, parent?: any): any => {
    if (node === null || typeof node !== "object") return node;
    if (seen.has(node)) return node;
    seen.add(node);
    if (Array.isArray(node)) return node.map((v) => walk(v, node));
    const out: Record<string, any> = {};
    const isDocNumberRow = String(node.field ?? "") === "documentNumber";
    for (const [k, v] of Object.entries(node)) {
      if (k === "line2" && typeof v === "string") out[k] = maskMrzLine2(v);
      else if (ALWAYS_MASK_KEYS.has(k) && typeof v === "string") out[k] = maskTailId(v);
      else if (isDocNumberRow && VALUE_KEYS_MASKED_FOR_DOC_NUMBER.has(k) && typeof v === "string") out[k] = maskTailId(v);
      else out[k] = walk(v, node);
    }
    void parent;
    return out;
  };
  return walk(vault) as T;
}

/* ─────────────────────────────────────────────────────────────────────
 * CONTACT-CHANNEL MASKING — for surfaces that must show WHO a row is
 * about without handing out a way to reach them.
 *
 * ⚠ THESE ARE SERVER-SIDE MASKS. They exist to be applied BEFORE a value
 * is written into a response body, never in a component. A frontend that
 * receives the real value and hides it has not masked anything — the
 * value is in the network tab, in the browser cache and in any log that
 * captured the response. Every caller of these functions is a route.
 *
 * The bullet is U+2022, not an asterisk, so a masked value reads as a
 * deliberate redaction rather than a wildcard or a shell glob.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * "imran@gmail.com" -> "i•••@gmail.com".
 *
 * ── WHY THE DOMAIN SURVIVES ───────────────────────────────────────────
 * It is the half that is useful and the half that is not identifying: a
 * support agent needs "is this a Gmail address or their company's?" to
 * make sense of a deliverability question, and "@gmail.com" narrows the
 * person down to about two billion people. The local part is the actual
 * identifier and the actual delivery address, so it is what goes.
 *
 * A single leading character, not three: it is enough to tell two rows
 * apart at a glance, and any more starts reconstructing the address.
 * Anything that is not shaped like an email is masked WHOLE rather than
 * passed through — a value we cannot parse is a value we cannot promise
 * is safe.
 */
export function maskEmailAddress(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const str = String(value);
  const at = str.lastIndexOf("@");
  if (at <= 0 || at === str.length - 1) return "•••";
  return `${str[0]}•••${str.slice(at)}`;
}

/**
 * "+919876544417" -> "+91 •••••• 4417";  "9876544417" -> "•••••• 4417".
 *
 * Last four and nothing else — the same last-4 convention maskTailId()
 * above already sets for passport and PAN, because it is what lets a
 * person on a call confirm "yes, that's my number" without the number
 * ever being on the screen in front of the agent.
 *
 * A leading country code is kept when the value carries one explicitly
 * (a `+` prefix). It is not an identifier, it is a country, and dropping
 * it would make two numbers from different countries look identical.
 * A number with fewer than five digits is masked whole: there is nothing
 * left to hide behind the last four.
 */
export function maskPhoneNumber(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const str = String(value).trim();
  const digits = str.replace(/\D/g, "");
  if (digits.length <= 4) return "••••";

  // A `+` means the caller wrote the country code; anything else is a
  // bare national number and gets no invented prefix.
  let cc = "";
  let rest = digits;
  if (str.startsWith("+")) {
    // India is the only market this surface has today, so +91 is split
    // exactly. Any other code falls back to leaving the whole number
    // after the `+` masked-but-for-the-last-four, which is still correct
    // — just without the country broken out.
    if (digits.startsWith("91") && digits.length > 10) {
      cc = "+91 ";
      rest = digits.slice(2);
    } else {
      cc = "+";
    }
  }
  return `${cc}${"•".repeat(Math.max(2, rest.length - 4))} ${rest.slice(-4)}`;
}

/**
 * A date of birth, hidden but not erased: "••••-••-••" when one is on
 * file, null when none is.
 *
 * Returning null for both would collapse "we are not showing you this"
 * into "there is nothing here", and an agent would go and ask a consumer
 * for a date of birth we already hold. The mask says which it is.
 */
export function maskDateOfBirth(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return "••••-••-••";
}
