// apps/backend/src/services/approvalSearch/hotelContent.test.ts
//
// Hotel images reach the browser over https only (review M1): an http URL is
// sent as the same URL over https, on any host. No http URL is ever sent.
import { describe, it, expect } from "vitest";
import { httpsImages, toHotelContent } from "./hotelContent.js";

describe("httpsImages", () => {
  it("keeps https URLs as they are, in order", () => {
    expect(httpsImages(["https://img.tbo.test/a.jpg", "https://cdn.other.test/b.jpg"])).toEqual([
      "https://img.tbo.test/a.jpg",
      "https://cdn.other.test/b.jpg",
    ]);
  });

  it("upgrades http to https by swapping the scheme, keeping host, port, path and query", () => {
    expect(httpsImages(["http://img.tbo.test/a.jpg?w=300", "HTTP://IMG.TBO.TEST/c.jpg", "http://img.tbo.test:8080/d.jpg"])).toEqual([
      "https://img.tbo.test/a.jpg?w=300",
      "https://IMG.TBO.TEST/c.jpg",
      "https://img.tbo.test:8080/d.jpg",
    ]);
  });

  it("upgrades http on any host, including hosts with no https image", () => {
    expect(httpsImages(["http://old.tbo.test/a.jpg", "https://img.tbo.test/b.jpg"])).toEqual([
      "https://old.tbo.test/a.jpg",
      "https://img.tbo.test/b.jpg",
    ]);
    expect(httpsImages(["http://old.tbo.test/a.jpg"])).toEqual(["https://old.tbo.test/a.jpg"]);
  });

  it("drops relative, data:, javascript: and malformed URLs; no duplicates after upgrading", () => {
    expect(
      httpsImages(["/a.jpg", "data:image/png;base64,AAAA", "javascript:alert(1)", "ftp://h.test/y.jpg", "https://", "http://", "https://h.test/x.jpg", "http://h.test/x.jpg"]),
    ).toEqual(["https://h.test/x.jpg"]);
  });
});

describe("toHotelContent", () => {
  it("never sends an http image URL", () => {
    const c = toHotelContent({
      Images: ["http://a.test/1.jpg", "https://b.test/2.jpg", "http://b.test/3.jpg", "/4.jpg"],
    });
    expect(c.images).toEqual(["https://a.test/1.jpg", "https://b.test/2.jpg", "https://b.test/3.jpg"]);
    expect(c.images.every((u) => u.startsWith("https://"))).toBe(true);
  });
});
