// The Payment Links client: what goes over the wire (B2B keys, no partial
// payment, Razorpay's own notifications off) and the live-key gate.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createPaymentLink,
  cancelPaymentLink,
  fetchPaymentLinkByReference,
  paymentLinksCreationAllowed,
  paymentLinksConfigured,
  RazorpayLinkError,
} from "./razorpayPaymentLinks.js";

const calls: Array<{ url: string; init: any }> = [];
let reply: { status: number; body: any } = { status: 200, body: {} };

beforeEach(() => {
  calls.length = 0;
  reply = { status: 200, body: { id: "plink_1", status: "created" } };
  process.env.RAZORPAY_KEY_ID = "rzp_test_b2b";
  process.env.RAZORPAY_KEY_SECRET = "b2b_secret";
  process.env.RAZORPAY_D2C_KEY_ID = "rzp_test_d2c_must_not_be_used";
  process.env.RAZORPAY_D2C_KEY_SECRET = "d2c_secret";
  delete process.env.PAYMENT_LINKS_LIVE;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as any;
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("createPaymentLink", () => {
  it("sends a fixed-amount link on the B2B keys with partial payment and Razorpay notifications off", async () => {
    await createPaymentLink({
      amountPaise: 51000,
      referenceId: "PBX-abc-1",
      description: "Plumtrips — Booking MB-1",
      expireBy: new Date("2026-10-29T10:00:00Z"),
      customer: { name: "Pax", email: "pax@client.com", contact: "+919876543210" },
      notes: { source: "plumbox_payment_request", paymentRequestId: "abc" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.razorpay.com/v1/payment_links");
    expect(calls[0].init.method).toBe("POST");
    const auth = Buffer.from(String(calls[0].init.headers.Authorization).replace("Basic ", ""), "base64").toString();
    expect(auth).toBe("rzp_test_b2b:b2b_secret");
    const body = JSON.parse(calls[0].init.body);
    expect(body).toMatchObject({
      amount: 51000,
      currency: "INR",
      accept_partial: false,
      reference_id: "PBX-abc-1",
      expire_by: Math.floor(new Date("2026-10-29T10:00:00Z").getTime() / 1000),
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { source: "plumbox_payment_request", paymentRequestId: "abc" },
    });
    expect("first_min_partial_amount" in body).toBe(false);
  });

  it("surfaces Razorpay errors with their status", async () => {
    reply = { status: 400, body: { error: { description: "reference_id already exists" } } };
    await expect(createPaymentLink({ amountPaise: 100, referenceId: "r", description: "d", expireBy: new Date() })).rejects.toMatchObject({
      status: 400,
      message: "reference_id already exists",
    });
    await expect(cancelPaymentLink("plink_x")).rejects.toBeInstanceOf(RazorpayLinkError);
  });

  it("fetch by reference returns the first match or null", async () => {
    reply = { status: 200, body: { payment_links: [{ id: "plink_9", reference_id: "PBX-r-1" }] } };
    expect(await fetchPaymentLinkByReference("PBX-r-1")).toMatchObject({ id: "plink_9" });
    expect(calls[0].url).toBe("https://api.razorpay.com/v1/payment_links?reference_id=PBX-r-1");
    reply = { status: 200, body: { payment_links: [] } };
    expect(await fetchPaymentLinkByReference("none")).toBeNull();
  });
});

describe("keys and the live gate", () => {
  it("needs the B2B pair; the D2C keys never count", () => {
    expect(paymentLinksConfigured()).toBe(true);
    delete process.env.RAZORPAY_KEY_ID;
    expect(paymentLinksConfigured()).toBe(false);
  });

  it("test keys may create; a live key may not unless PAYMENT_LINKS_LIVE=true", () => {
    expect(paymentLinksCreationAllowed()).toBe(true);
    process.env.RAZORPAY_KEY_ID = "rzp_live_b2b";
    expect(paymentLinksCreationAllowed()).toBe(false);
    process.env.PAYMENT_LINKS_LIVE = "true";
    expect(paymentLinksCreationAllowed()).toBe(true);
  });
});
