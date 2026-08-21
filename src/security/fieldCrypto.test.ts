// Unit coverage for the crypto core. Pure functions, no database, no
// environment — every key here is a literal buffer, so nothing in this file
// depends on how the master key is provisioned.
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  encryptField,
  decryptField,
  isEncryptedEnvelope,
  generateDataKey,
  FieldDecryptionError,
  FieldEncryptionError,
  PII_ENVELOPE_PREFIX,
  KEY_BYTES,
} from "./fieldCrypto.js";

const KEY = crypto.createHash("sha256").update("fieldCrypto.test key A").digest();
const OTHER_KEY = crypto.createHash("sha256").update("fieldCrypto.test key B").digest();

describe("encryptField / decryptField", () => {
  it("round-trips a value exactly", () => {
    const envelope = encryptField("M1234567", KEY);
    expect(decryptField(envelope, KEY)).toBe("M1234567");
  });

  it("round-trips unicode and empty-ish strings without mangling bytes", () => {
    for (const value of ["Ünïcødé ✈ 東京", " leading and trailing ", "0"]) {
      expect(decryptField(encryptField(value, KEY), KEY)).toBe(value);
    }
  });

  it("is RANDOMIZED — the same plaintext twice gives different ciphertext, and both decrypt", () => {
    const a = encryptField("M1234567", KEY);
    const b = encryptField("M1234567", KEY);
    expect(a).not.toBe(b);
    expect(decryptField(a, KEY)).toBe("M1234567");
    expect(decryptField(b, KEY)).toBe("M1234567");
  });

  it("emits a self-describing, versioned envelope", () => {
    const parts = encryptField("x", KEY).split(".");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe(PII_ENVELOPE_PREFIX);
    expect(parts[1]).toBe("1");
    expect(Buffer.from(parts[2], "base64url")).toHaveLength(12); // iv
    expect(Buffer.from(parts[3], "base64url")).toHaveLength(16); // auth tag
  });

  it("FAILS CLOSED on the wrong key — throws, never returns plaintext-looking output", () => {
    const envelope = encryptField("M1234567", KEY);
    expect(() => decryptField(envelope, OTHER_KEY)).toThrow(FieldDecryptionError);
  });

  it("rejects a TAMPERED ciphertext — one flipped byte and the GCM auth tag refuses it", () => {
    const envelope = encryptField("M1234567", KEY);
    const parts = envelope.split(".");
    const ct = Buffer.from(parts[4], "base64url");
    ct[0] ^= 0x01;
    parts[4] = ct.toString("base64url");
    expect(() => decryptField(parts.join("."), KEY)).toThrow(FieldDecryptionError);
  });

  it("rejects a tampered auth tag and a tampered IV", () => {
    const parts = encryptField("M1234567", KEY).split(".");

    const tag = Buffer.from(parts[3], "base64url");
    tag[0] ^= 0x01;
    expect(() => decryptField([...parts.slice(0, 3), tag.toString("base64url"), parts[4]].join("."), KEY)).toThrow(
      FieldDecryptionError,
    );

    const iv = Buffer.from(parts[2], "base64url");
    iv[0] ^= 0x01;
    expect(() =>
      decryptField([parts[0], parts[1], iv.toString("base64url"), parts[3], parts[4]].join("."), KEY),
    ).toThrow(FieldDecryptionError);
  });

  it("refuses an envelope version it does not understand rather than guessing", () => {
    const parts = encryptField("x", KEY).split(".");
    parts[1] = "2";
    expect(() => decryptField(parts.join("."), KEY)).toThrow(/Unsupported envelope version/);
  });

  it("refuses malformed framing", () => {
    expect(() => decryptField("penc.1.aaa.bbb", KEY)).toThrow(/expected 5 segments/);
    expect(() => decryptField("not-an-envelope", KEY)).toThrow(/not an encrypted envelope/i);
  });

  it("binds a ciphertext to its aad — the same key with a different aad does not decrypt", () => {
    const envelope = encryptField("M1234567", KEY, "passports.$.number");
    expect(decryptField(envelope, KEY, "passports.$.number")).toBe("M1234567");
    expect(() => decryptField(envelope, KEY, "contact.mobile")).toThrow(FieldDecryptionError);
    expect(() => decryptField(envelope, KEY)).toThrow(FieldDecryptionError);
  });

  it("rejects a key that is not 32 bytes, on both sides", () => {
    expect(() => encryptField("x", Buffer.alloc(16))).toThrow(FieldEncryptionError);
    expect(() => decryptField(encryptField("x", KEY), Buffer.alloc(16))).toThrow(FieldEncryptionError);
  });
});

describe("isEncryptedEnvelope", () => {
  it("recognises our envelopes and nothing else — this is what makes dual-read possible", () => {
    expect(isEncryptedEnvelope(encryptField("x", KEY))).toBe(true);
    for (const legacy of ["M1234567", "", "penc", "pencil", "1990-01-01", null, undefined, 42, new Date()]) {
      expect(isEncryptedEnvelope(legacy)).toBe(false);
    }
  });
});

describe("generateDataKey", () => {
  it("returns a fresh 32-byte key each call", () => {
    const a = generateDataKey();
    const b = generateDataKey();
    expect(a).toHaveLength(KEY_BYTES);
    expect(a.equals(b)).toBe(false);
  });
});
