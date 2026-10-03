// Razorpay calls for SBT (Plumtrips Travel MID: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).
// Kept in one small module so the payment gate's tests can stub the network.
import { createHmac, timingSafeEqual } from "crypto";

const API = "https://api.razorpay.com/v1";

export function razorpayConfigured(): boolean {
  return !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET;
}

export function razorpayKeyId(): string {
  return process.env.RAZORPAY_KEY_ID || "";
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`;
}

/** Checkout signature: HMAC-SHA256(order_id|payment_id, key secret). */
export function checkoutSignatureValid(orderId: string, paymentId: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET || "";
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex"));
  const received = Buffer.from(String(signature));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const err = new Error(data?.error?.description || `Razorpay ${method} ${path} failed (${res.status})`);
    (err as any).status = res.status;
    throw err;
  }
  return data;
}

export function createRazorpayOrder(amountPaise: number, receipt: string): Promise<any> {
  return call("POST", "/orders", { amount: amountPaise, currency: "INR", receipt });
}

export function fetchRazorpayPayment(paymentId: string): Promise<any> {
  return call("GET", `/payments/${encodeURIComponent(paymentId)}`);
}

export function captureRazorpayPayment(paymentId: string, amountPaise: number): Promise<any> {
  return call("POST", `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency: "INR" });
}
