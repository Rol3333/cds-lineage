import { describe, expect, it } from "vitest";
import { decodeSource } from "../src/adt/decode.js";

describe("decodeSource", () => {
  it("decodes UTF-16 LE with BOM", () => {
    const text = "@AbapCatalog.sqlViewName: 'X'\ndefine view A as select from B { key B.x }";
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(decodeSource(buffer)).toBe(text);
  });

  it("decodes UTF-8 with BOM", () => {
    const text = "define view A as select from B { key B.x }";
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    expect(decodeSource(buffer)).toBe(text);
  });

  it("decodes UTF-8 without BOM", () => {
    const text = "define view A as select from B { key B.x }";
    expect(decodeSource(Buffer.from(text, "utf8"))).toBe(text);
  });

  it("decodes UTF-16 LE without BOM via null-byte heuristic", () => {
    const text = "define view A as select from B { key B.x }";
    expect(decodeSource(Buffer.from(text, "utf16le"))).toBe(text);
  });

  it("decodes UTF-16 BE with BOM", () => {
    const text = "ABAP";
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), swapToBe(Buffer.from(text, "utf16le"))]);
    expect(decodeSource(be)).toBe(text);
  });

  it("handles empty input", () => {
    expect(decodeSource(Buffer.alloc(0))).toBe("");
  });
});

function swapToBe(le: Buffer): Buffer {
  const out = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    out[i] = le[i + 1]!;
    out[i + 1] = le[i]!;
  }
  return out;
}
