import { sanitizeEmailHtml } from "@plumtrips/shared/security/htmlSanitize";

export interface QuotedMessage {
  fromName: string;
  fromEmail: string;
  sentAt: Date;
  bodyHtml: string;
}

export function buildQuotedBody(
  newContent: string,
  priorMessages: QuotedMessage[],
): string {
  if (priorMessages.length === 0) return newContent;

  const msg = priorMessages[priorMessages.length - 1];
  const date = formatQuoteDate(msg.sentAt);
  const safeName = msg.fromName.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeEmail = msg.fromEmail.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /* The name and the address were already escaped above; the BODY was not,
   * and it is the larger surface by far. What gets quoted here is a prior
   * message — for the console reply path the last inbound email, for the
   * auto-ack the sender's own words — so a quote trail is a way for markup
   * from outside to ride into a message we compose, send over Gmail, and
   * store as OUTBOUND. Sanitizing here rather than at the two call sites
   * means neither caller can forget.
   *
   * Rows written before ingestion started sanitizing are the reason this is
   * not merely belt-and-braces: those bodies are still dirty in the
   * collection, and this is what a reply quoting one passes through. */
  const safeBody = sanitizeEmailHtml(msg.bodyHtml);

  return (
    `<div>${newContent}</div>\n<br>\n` +
    `<div class="gmail_quote_attribution">On ${date}, ${safeName} &lt;${safeEmail}&gt; wrote:</div>\n` +
    `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">\n` +
    `${safeBody}\n` +
    `</blockquote>`
  );
}

function formatQuoteDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h24 = date.getUTCHours();
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 || 12;
  return `${days[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()} at ${h12}:${min} ${ampm}`;
}
