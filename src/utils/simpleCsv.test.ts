import { describe, it, expect } from "vitest";
import { parseCsv, parseCsvWithHeader } from "./simpleCsv.js";

describe("parseCsv", () => {
  it("parses a simple comma-separated file", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles a quoted field containing a comma", () => {
    expect(parseCsv('a,"b,c",d\n')).toEqual([["a", "b,c", "d"]]);
  });

  it("handles a doubled-quote escape inside a quoted field", () => {
    expect(parseCsv('a,"say ""hi""",c\n')).toEqual([["a", 'say "hi"', "c"]]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles a file with no trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("parseCsvWithHeader", () => {
  it("keys each row by the lowercased, trimmed header", () => {
    const rows = parseCsvWithHeader("Destination, Purpose ,IndicativeVisaCostInr\nJapan,Tourist,7500\n");
    expect(rows).toEqual([{ destination: "Japan", purpose: "Tourist", indicativevisacostinr: "7500" }]);
  });

  it("skips a fully-blank row", () => {
    const rows = parseCsvWithHeader("destination,purpose\nJapan,Tourist\n,\n,\n");
    expect(rows).toHaveLength(1);
  });

  it("returns an empty array when the file has only a header", () => {
    expect(parseCsvWithHeader("destination,purpose\n")).toEqual([]);
  });
});
