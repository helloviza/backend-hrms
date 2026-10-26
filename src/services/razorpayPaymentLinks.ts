// apps/backend/src/services/razorpayPaymentLinks.ts
//
// Razorpay Payment Links calls, on the Plumtrips Travel (B2B) MID ONLY:
// RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET. There is deliberately no fallback to
// the helloviza D2C keys, nor from them — money collected here belongs to the
// B2B account (see config/razorpayMode.ts and docs/audits/payment-links-audit.md).
//
// Kept apart from services/sbtRazorpay.ts so the SBT payment gate is untouched
// and so tests can stub the network with one vi.mock.
//
// LIVE-KEY GATE: until the payment-links screens are signed off, creation is
// refused on a live key unless PAYMENT_LINKS_LIVE=true. Test keys always work.
// Fetch and cancel are never gated — a link that exists must stay manageable.

const API = "https://api.razorpay.com/v1";

export class RazorpayLinkError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function paymentLinksConfigured(): boolean {
  return !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET;
}

/** True when a link may be CREATED with the configured key. */
export function paymentLinksCreationAllowed(): boolean {
  const key = String(process.env.RAZORPAY_KEY_ID || "");
  if (!key.startsWith("rzp_live_")) return true;
  return process.env.PAYMENT_LINKS_LIVE === "true";
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`;
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new RazorpayLinkError(data?.error?.description || `Razorpay ${method} ${path} failed (${res.status})`, res.status, data);
  }
  return data;
}

export type CreateLinkInput = {
  amountPaise: number;
  referenceId: string;
  description: string;
  expireBy: Date;
  customer?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
};

/**
 * POST /payment_links — a fixed-amount Standard link. accept_partial is sent
 * as false and first_min_partial_amount is omitted (Razorpay rejects it when
 * partial payment is off). Razorpay's own SMS / email / reminders are off:
 * Plumtrips sends its own email.
 */
export function createPaymentLink(input: CreateLinkInput): Promise<any> {
  const customer: Record<string, string> = {};
  if (input.customer?.name) customer.name = input.customer.name.slice(0, 100);
  if (input.customer?.email) customer.email = input.customer.email;
  if (input.customer?.contact) customer.contact = input.customer.contact;
  const notes: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.notes || {}).slice(0, 15)) notes[k] = String(v).slice(0, 255);
  return call("POST", "/payment_links", {
    amount: input.amountPaise,
    currency: "INR",
    accept_partial: false,
    reference_id: input.referenceId,
    description: input.description.slice(0, 2048),
    expire_by: Math.floor(input.expireBy.getTime() / 1000),
    ...(Object.keys(customer).length ? { customer } : {}),
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes,
  });
}

export function fetchPaymentLink(id: string): Promise<any> {
  return call("GET", `/payment_links/${encodeURIComponent(id)}`);
}

/** The link carrying this reference_id, or null. */
export async function fetchPaymentLinkByReference(referenceId: string): Promise<any | null> {
  const data = await call("GET", `/payment_links?reference_id=${encodeURIComponent(referenceId)}`);
  const list = Array.isArray(data?.payment_links) ? data.payment_links : [];
  return list[0] ?? null;
}

/** The link a payment was made on, or null (e.g. a plain checkout payment). */
export async function fetchPaymentLinkByPaymentId(paymentId: string): Promise<any | null> {
  const data = await call("GET", `/payment_links?payment_id=${encodeURIComponent(paymentId)}`);
  const list = Array.isArray(data?.payment_links) ? data.payment_links : [];
  return list[0] ?? null;
}

/** POST /payment_links/:id/cancel — only a `created` link can be cancelled. */
export function cancelPaymentLink(id: string): Promise<any> {
  return call("POST", `/payment_links/${encodeURIComponent(id)}/cancel`);
}
