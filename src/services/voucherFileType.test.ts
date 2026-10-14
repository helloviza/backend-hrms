// F-14: a voucher upload is judged by its bytes, not its name or MIME header.
import { describe, it, expect } from "vitest";
import { rejectedFileMessage, sniffVoucherFile } from "./voucherFileType.js";

const bytes = (...xs: number[]) => Buffer.from(xs);

describe("sniffVoucherFile", () => {
  it.each([
    ["PDF", Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj"), "application/pdf"],
    ["PDF with a few junk bytes before the header", Buffer.concat([Buffer.from("\r\n\r\n"), Buffer.from("%PDF-1.4")]), "application/pdf"],
    ["JPEG", bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46), "image/jpeg"],
    ["PNG", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13), "image/png"],
    ["WEBP", Buffer.concat([Buffer.from("RIFF"), bytes(0x24, 0, 0, 0), Buffer.from("WEBPVP8 ")]), "image/webp"],
  ])("accepts %s", (_n, buf, mime) => {
    expect(sniffVoucherFile(buf)).toBe(mime);
  });

  it.each([
    ["an empty file", Buffer.alloc(0)],
    ["plain text named .pdf", Buffer.from("Booking confirmed for Mr A, PNR 8RLUYX")],
    ["HTML", Buffer.from("<!doctype html><html><body>voucher</body></html>")],
    ["a Word document (zip)", bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00)],
    ["GIF", Buffer.from("GIF89a\x01\x00\x01\x00")],
    ["HEIC", Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from("ftypheic")])],
    ["a RIFF that isn't WEBP (WAV)", Buffer.concat([Buffer.from("RIFF"), bytes(0x24, 0, 0, 0), Buffer.from("WAVEfmt ")])],
    ["a PNG signature cut short", bytes(0x89, 0x50, 0x4e, 0x47)],
    ["'%PDF-' only after the first 1 KB", Buffer.concat([Buffer.alloc(2048, 0x20), Buffer.from("%PDF-1.4")])],
  ])("rejects %s", (_n, buf) => {
    expect(sniffVoucherFile(buf)).toBeNull();
  });

  it("an image whose metadata mentions %PDF- is still the image", () => {
    const jpeg = Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xe1), Buffer.from("Exif ... %PDF- ...")]);
    expect(sniffVoucherFile(jpeg)).toBe("image/jpeg");
  });
});

describe("rejectedFileMessage", () => {
  it("names the file and the four accepted formats", () => {
    expect(rejectedFileMessage("booking.docx")).toBe(
      "booking.docx isn't a PDF, JPEG, PNG or WEBP file. Upload the supplier voucher as a PDF or as a JPEG, PNG or WEBP image.",
    );
  });
});
