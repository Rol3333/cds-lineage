import { describe, expect, it } from "vitest";
import { classifyDefinitionKinds, extractSources } from "../src/parser/extract-sources.js";

const single = `define view entity A as select from B { key B.x }`;

describe("extractSources", () => {
  it("extracts a single primary source", () => {
    const result = extractSources(single);
    expect(result.objectName).toBe("A");
    expect(result.parseErrors).toHaveLength(0);
    expect(result.sources).toEqual([{ name: "B", role: "primary", alias: undefined }]);
  });

  it("extracts primary and join sources with join types", () => {
    const src = `define view entity A as select from B
      left outer join C on B.x = C.x
      inner join D on B.y = D.y { key B.col }`;
    const result = extractSources(src);
    expect(result.parseErrors).toHaveLength(0);
    expect(result.sources.map((s) => [s.name, s.role, s.joinType])).toEqual([
      ["B", "primary", undefined],
      ["C", "join", "leftOuter"],
      ["D", "join", "inner"],
    ]);
  });

  it("extracts sources from a parenthesized join group", () => {
    const src = `define view entity A as select from B
      left outer join (C inner join D on C.x = D.x) on B.x = C.x { key B.col }`;
    const result = extractSources(src);
    const names = result.sources.map((s) => s.name);
    expect(names).toContain("B");
    expect(names).toContain("C");
    expect(names).toContain("D");
  });

  it("still extracts FROM/JOIN sources when the projection uses unsupported named arguments", () => {
    const src = `define view entity A as select from B
      left outer join T1 on B.x = T1.x
      { key B.x, currency_conversion(amount => B.amt, target_currency => 'EUR') as AmtEur }`;
    const result = extractSources(src);
    // The named-argument syntax (`=>`) is not parsed, but the FROM/JOIN is intact.
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.definitionKinds).toContain("viewEntity");
    expect(result.sources.map((s) => [s.name, s.role])).toEqual([
      ["B", "primary"],
      ["T1", "join"],
    ]);
  });

  it("classifies viewEntity as cds and expandable", () => {
    expect(classifyDefinitionKinds(["viewEntity"])).toEqual({ kind: "cds", expandable: true });
  });

  it("classifies table as table and non-expandable", () => {
    expect(classifyDefinitionKinds(["table"])).toEqual({ kind: "table", expandable: false });
  });

  it("classifies other CDS kinds as cds and non-expandable", () => {
    expect(classifyDefinitionKinds(["structure"])).toEqual({ kind: "cds", expandable: false });
  });

  it("reports parse errors with no usable definition for invalid input", () => {
    const result = extractSources("this is not valid cds {{");
    expect(result.definitionKinds).toHaveLength(0);
    expect(result.parseErrors.length).toBeGreaterThan(0);
  });
});
