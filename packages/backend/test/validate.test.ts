import { describe, expect, it } from "vitest";
import { validateCdsName } from "../src/adt/validate.js";

describe("validateCdsName", () => {
  it("accepts a plain CDS name", () => {
    expect(validateCdsName("ZC_PurReqItemQRY001").ok).toBe(true);
  });

  it("accepts a namespaced name", () => {
    expect(validateCdsName("/ABC/MY_VIEW").ok).toBe(true);
  });

  it("trims whitespace", () => {
    expect(validateCdsName("  ZC_VIEW  ").ok).toBe(true);
  });

  it("rejects empty input", () => {
    const result = validateCdsName("   ");
    expect(result.ok).toBe(false);
    expect(result.error?.errorCode).toBe("invalid-name");
  });

  it("rejects shell metacharacters", () => {
    for (const bad of ["A;rm", "A&B", "A|B", "A$(B)", "A`id`", "A>file", "A B", "A\"B", "A'B"]) {
      expect(validateCdsName(bad).ok).toBe(false);
    }
  });

  it("rejects non-identifier input", () => {
    expect(validateCdsName("1ABC").ok).toBe(false);
    expect(validateCdsName("A!B").ok).toBe(false);
  });
});
