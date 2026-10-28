import { describe, expect, it } from "vitest";
import { classifyDefinitionKinds, extractSources } from "../src/parser/extract-sources.js";

const single = `define view entity A as select from B { key B.x }`;

describe("extractSources", () => {
  it("extracts a single primary source", () => {
    const result = extractSources(single);
    expect(result.objectName).toBe("A");
    expect(result.parseErrors).toHaveLength(0);
    expect(result.sources).toMatchObject([{ name: "B", role: "primary", alias: undefined }]);
    expect(result.sources[0]?.relationship).toMatchObject({
      kind: "primary",
      right: { name: "B" },
      usedInProjection: true,
    });
  });

  it("extracts primary and join sources with join types", () => {
    const src = `define view entity A as select from B
      left outer join C on B.x = C.x
      inner join D on B.y = D.y { key B.col, C.x }`;
    const result = extractSources(src);
    expect(result.parseErrors).toHaveLength(0);
    expect(result.sources.map((s) => [s.name, s.role, s.joinType])).toEqual([
      ["B", "primary", undefined],
      ["C", "join", "leftOuter"],
      ["D", "join", "inner"],
    ]);
    expect(result.sources[1]?.relationship).toMatchObject({
      kind: "join",
      joinType: "leftOuter",
      condition: "B.x = C.x",
      left: [{ name: "B" }],
      right: { name: "C" },
      usedInProjection: true,
      predicates: [{ text: "B.x = C.x", left: "B.x", operator: "=", right: "C.x" }],
    });
    expect(result.sources[2]?.relationship?.usedInProjection).toBe(false);
  });

  it("extracts projection columns and field columns", () => {
    const view = `define view entity A as select from B { key B.x, B.y as Y }`;
    const viewResult = extractSources(view);
    expect(viewResult.columns).toEqual([
      expect.objectContaining({ name: "x", expression: "B.x", isKey: true, kind: "projection" }),
      expect.objectContaining({ name: "Y", expression: "B.y", isKey: false, kind: "projection" }),
    ]);

    const tableResult = extractSources(`define table T { key mandt : mandt; value : abap.char(10); }`);
    expect(tableResult.columns).toEqual([
      expect.objectContaining({ name: "mandt", type: "mandt", isKey: true, kind: "field" }),
      expect.objectContaining({ name: "value", type: "char(10)", isKey: false, kind: "field" }),
    ]);

    // Foreign-key clauses can be exposed as pseudo-fields by the parser; they
    // must not appear as DDIC columns.
    const foreignKeyTable = extractSources(
      `define table T { key mandt : mandt not null with foreign key [0..*,1] t000; value : abap.char(10); }`,
    );
    expect(foreignKeyTable.columns.map((column) => column.name)).toEqual(["mandt", "value"]);
  });

  it("extracts declared associations and marks projection usage", () => {
    const src = `define view entity A as select from B
      association [0..1] to C as _C on B.x = _C.x
      association [0..*] to D as _D on B.x = _D.x
      { key B.x, _C.y as Y }`;
    const result = extractSources(src);
    expect(result.parseErrors).toHaveLength(0);
    expect(result.associations).toEqual([
      expect.objectContaining({
        name: "_C",
        target: "C",
        associationKind: "association",
        cardinality: "[0..1]",
        condition: "B.x = _C.x",
        usedInProjection: true,
      }),
      expect.objectContaining({
        name: "_D",
        target: "D",
        cardinality: "[0..*]",
        usedInProjection: false,
      }),
    ]);
    expect(result.sources.filter((source) => source.role === "association")).toHaveLength(2);
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
