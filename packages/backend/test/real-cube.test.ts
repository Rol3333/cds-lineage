import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractSources } from "../src/parser/extract-sources.js";

/**
 * Regression test against a real SAP DDL source (`ZC_PurReqItemCube`).
 *
 * This source uses `currency_conversion(amount => …, target_currency => …)` —
 * the named-argument syntax that `@abapify/acds` does not yet parse. The
 * projection list therefore reports parse errors, but the FROM/JOIN structure
 * must still be extracted from the partial AST (documented parser gap).
 */
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ZC_PurReqItemCube.asddls");
const source = readFileSync(fixture, "utf8");

describe("real CDS source (ZC_PurReqItemCube)", () => {
  it("documents the named-argument parser gap", () => {
    const result = extractSources(source);
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0]?.message).toContain("=>");
  });

  it("still extracts the primary and join sources", () => {
    const result = extractSources(source);
    expect(result.objectName).toBe("ZC_PurReqItemCube");
    expect(result.definitionKinds).toContain("viewEntity");
    expect(result.sources[0]).toMatchObject({ name: "I_Purchaserequisitionitem", role: "primary" });
    const joinNames = result.sources.filter((s) => s.role === "join").map((s) => s.name);
    expect(joinNames).toEqual([
      "ZI_MMPurOrdInvAmtQty",
      "ZP_MM_PuReq_AprDat",
      "ZP_MM_PurReq_ClsDat",
      "ZP_MM_PurReq_RegD",
      "ZP_MM_PR_DOC_TF",
      "ZI_MM_UserOrgUnitDedup",
    ]);
  });
});
