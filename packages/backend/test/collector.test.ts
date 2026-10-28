import { describe, expect, it } from "vitest";
import type { DependencyGraph } from "@cds-visualiser/shared";
import { createFixtureProvider } from "../src/adt/fixture-service.js";
import { validateCdsName } from "../src/adt/validate.js";
import { analyze, type CollectorOptions } from "../src/collector/collector.js";

function run(
  root: string,
  sources: Record<string, string>,
  objectTypes: Record<string, string> = {},
  options: Partial<CollectorOptions> = {},
) {
  const provider = createFixtureProvider(sources, objectTypes);
  return analyze(root, {
    provider,
    options: { maxDepth: 3, maxObjects: 100, concurrency: 4, ...options },
    validate: validateCdsName,
  });
}

function node(graph: DependencyGraph, id: string) {
  return graph.nodes.find((n) => n.id === id);
}

const A = `define view entity A as select from B { key B.x }`;
const Ajoins = `define view entity A as select from B
  left outer join C on B.x = C.x
  inner join D on B.y = D.y { key B.col }`;
const B = `define view entity B as select from C { key C.x }`;
const C = `define view entity C as select from D { key D.x }`;
const D = `define view entity D as select from E { key E.x }`;

describe("dependency collector", () => {
  it("simple CDS with one source", async () => {
    const { graph } = await run("A", { A });
    expect(node(graph, "A")?.depth).toBe(0);
    expect(node(graph, "B")?.depth).toBe(1);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: "A", to: "B" });
  });

  it("multiple joins become multiple edges with join types", async () => {
    const { graph } = await run("A", { A: Ajoins });
    expect(node(graph, "B")).toBeDefined();
    expect(node(graph, "C")).toBeDefined();
    expect(node(graph, "D")).toBeDefined();
    const joinEdges = graph.edges.filter((e) => e.sourceRole === "join");
    expect(joinEdges).toHaveLength(2);
    expect(joinEdges.map((e) => e.joinType).sort()).toEqual(["inner", "leftOuter"]);
    expect(joinEdges.every((edge) => edge.relationship?.usedInProjection === false)).toBe(true);
    expect(node(graph, "C")?.usedInProjection).toBe(false);
  });

  it("extracts view columns and rich join relationship details", async () => {
    const src = `define view entity A as select from B
      left outer join C as _C on B.x = _C.x and B.y = _C.y
      { key B.x, _C.z as Z }`;
    const { graph } = await run("A", { A: src, B, C });
    const root = node(graph, "A");
    expect(root?.columns).toEqual([
      expect.objectContaining({ name: "x", expression: "B.x", isKey: true }),
      expect.objectContaining({ name: "Z", expression: "_C.z", isKey: false }),
    ]);

    const edge = graph.edges.find((candidate) => candidate.to === "C");
    expect(edge?.relationship).toMatchObject({
      kind: "join",
      joinType: "leftOuter",
      alias: "_C",
      condition: "B.x = _C.x and B.y = _C.y",
      left: [{ name: "B" }],
      right: { alias: "_C", name: "C" },
      usedInProjection: true,
    });
    expect(edge?.relationship?.predicates).toEqual([
      expect.objectContaining({ left: "B.x", operator: "=", right: "_C.x" }),
      expect.objectContaining({ left: "B.y", operator: "=", right: "_C.y" }),
    ]);
  });

  it("traverses declared associations and marks unused ones", async () => {
    const src = `define view entity A as select from B
      association [0..1] to C as _C on B.x = _C.x
      association [0..*] to D as _D on B.x = _D.x
      { key B.x, _C.y as Y }`;
    const { graph } = await run("A", { A: src }, { B: "TABL", C: "TABL", D: "TABL" });
    const root = node(graph, "A");
    expect(root?.associations).toHaveLength(2);
    expect(root?.associations?.map((association) => association.name)).toEqual(["_C", "_D"]);

    const associationEdges = graph.edges.filter((edge) => edge.sourceRole === "association");
    expect(associationEdges).toHaveLength(2);
    expect(associationEdges.find((edge) => edge.to === "C")?.relationship).toMatchObject({
      kind: "association",
      cardinality: "[0..1]",
      usedInProjection: true,
    });
    expect(associationEdges.find((edge) => edge.to === "D")?.relationship).toMatchObject({
      kind: "association",
      cardinality: "[0..*]",
      usedInProjection: false,
    });
    expect(node(graph, "C")?.usedInProjection).toBe(true);
    expect(node(graph, "D")?.usedInProjection).toBe(false);
  });

  it("captures DDIC table fields on the leaf node", async () => {
    const src = `define view entity A as select from B left outer join T1 on B.x = T1.mandt { key B.x }`;
    const { graph } = await run(
      "A",
      { A: src, B, T1: `define table T1 { key mandt : mandt; value : abap.char(10); }` },
      { T1: "TABL" },
    );
    expect(node(graph, "T1")?.columns).toEqual([
      expect.objectContaining({ name: "mandt", type: "mandt", isKey: true, kind: "field" }),
      expect.objectContaining({ name: "value", type: "char(10)", isKey: false, kind: "field" }),
    ]);
  });

  it("CDS whose source is another CDS", async () => {
    const { graph } = await run("A", { A, B });
    expect(node(graph, "C")?.depth).toBe(2);
    expect(graph.edges.map((e) => [e.from, e.to])).toContainEqual(["A", "B"]);
    expect(graph.edges.map((e) => [e.from, e.to])).toContainEqual(["B", "C"]);
  });

  it("classifies a DDIC table source as a table leaf", async () => {
    const mixed = `define view entity A as select from B left outer join T1 on B.x = T1.x { key B.x }`;
    const { graph } = await run("A", { A: mixed, B }, { T1: "TABL" });
    const t1 = node(graph, "T1");
    expect(t1?.kind).toBe("table");
    expect(t1?.status).toBe("loaded");
    expect(t1?.expandable).toBe(false);
  });

  it("traverses exactly to depth 3 and marks deeper dependencies not-expanded", async () => {
    const { graph } = await run("A", { A, B, C, D });
    // A(0) -> B(1) -> C(2) -> D(3); D's dep E is beyond depth 3.
    expect(node(graph, "D")?.depth).toBe(3);
    const e = node(graph, "E");
    expect(e).toBeDefined();
    expect(e?.status).toBe("not-expanded");
    expect(e?.errorCode).toBe("max-depth");
  });

  it("does not expand beyond a configured depth", async () => {
    const { graph } = await run("A", { A, B }, {}, { maxDepth: 1 });
    // B is at depth 1 (max) and is read; C would be at depth 2 and is not expanded.
    expect(node(graph, "B")?.depth).toBe(1);
    expect(node(graph, "B")?.status).toBe("loaded");
    expect(node(graph, "C")?.status).toBe("not-expanded");
  });

  it("deduplicates a shared dependency into one node", async () => {
    const sources = {
      A: `define view entity A as select from B left outer join C on B.x = C.x { key B.x }`,
      B: `define view entity B as select from D { key D.x }`,
      C: `define view entity C as select from D { key D.x }`,
    };
    const { graph } = await run("A", sources);
    const ds = graph.nodes.filter((n) => n.id === "D");
    expect(ds).toHaveLength(1);
    const incoming = graph.edges.filter((e) => e.to === "D");
    expect(incoming.map((e) => e.from).sort()).toEqual(["B", "C"]);
  });

  it("terminates on a cycle and records a warning", async () => {
    const sources = {
      A: `define view entity A as select from B { key B.x }`,
      B: `define view entity B as select from A { key A.x }`,
    };
    const { graph } = await run("A", sources);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["A", "B"]);
    expect(graph.edges.map((e) => [e.from, e.to])).toContainEqual(["B", "A"]);
    expect(graph.warnings.some((w) => w.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("keeps partial results when one branch fails", async () => {
    const sources = {
      A: `define view entity A as select from B left outer join X on B.x = X.x { key B.x }`,
      B: `define view entity B as select from C { key C.x }`,
    };
    const { graph } = await run("A", sources);
    expect(node(graph, "B")?.status).toBe("loaded");
    const x = node(graph, "X");
    expect(x?.status).toBe("read-error");
    expect(x?.errorCode).toBe("object-not-found");
  });

  it("marks a parse failure on the relevant node", async () => {
    const sources = {
      A: `define view entity A as select from B { key B.x }`,
      B: `this is not valid cds {{{`,
    };
    const { graph } = await run("A", sources);
    expect(node(graph, "A")?.status).toBe("loaded");
    expect(node(graph, "B")?.status).toBe("parse-error");
    expect(node(graph, "B")?.errorCode).toBe("parse-failure");
  });

  it("keeps dependencies when the projection has parse errors, and warns", async () => {
    const sources = {
      A: `define view entity A as select from B { key B.x, currency_conversion(amount => B.amt, target_currency => 'EUR') as X }`,
      B: `define view entity B as select from C { key C.x }`,
    };
    const { graph } = await run("A", sources);
    expect(node(graph, "A")?.status).toBe("loaded");
    expect(node(graph, "A")?.dependencies).toContain("B");
    expect(node(graph, "B")?.status).toBe("loaded");
    expect(graph.warnings.some((w) => w.includes("partial AST"))).toBe(true);
    expect(graph.diagnostics?.some((diagnostic) => diagnostic.category === "parse" && diagnostic.objectId === "A")).toBe(
      true,
    );
    expect(node(graph, "A")?.parseErrors?.length).toBeGreaterThan(0);
  });

  it("enforces the maximum object count", async () => {
    const sources = {
      A: `define view entity A as select from B left outer join C on B.x = C.x { key B.x }`,
      B: `define view entity B as select from D { key D.x }`,
    };
    const result = await run("A", sources, {}, { maxObjects: 2 });
    expect(result.truncated).toBe(true);
    expect(result.limitReached).toBe("max-objects");
  });

  it("rejects an invalid root name with a single error node", async () => {
    const { graph } = await run("A;rm", {});
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.errorCode).toBe("invalid-name");
    expect(graph.edges).toHaveLength(0);
  });

  it("never treats a failed read as a dependency-free node", async () => {
    const { graph } = await run("A", { A: `define view entity A as select from MISSING { key MISSING.x }` });
    const missing = node(graph, "MISSING");
    expect(missing?.status).toBe("read-error");
    expect(missing?.dependencies).toHaveLength(0);
  });

  it("classifies a DDIC structure (TABL/DS) as a loaded leaf", async () => {
    const mixed = `define view entity A as select from B left outer join BAPIRET2 on B.x = BAPIRET2.x { key B.x }`;
    const { graph } = await run("A", { A: mixed, B }, { BAPIRET2: "TABL/DS" });
    const structure = node(graph, "BAPIRET2");
    expect(structure?.kind).toBe("structure");
    expect(structure?.status).toBe("loaded");
    expect(structure?.objectType).toBe("TABL");
    expect(structure?.objectSubtype).toBe("DS");
    expect(structure?.expandable).toBe(false);
  });

  it("captures a DDIC view (VIEW/DV) as a metadata-only leaf", async () => {
    const mixed = `define view entity A as select from B left outer join V_T001 on B.x = V_T001.x { key B.x }`;
    const { graph } = await run("A", { A: mixed, B }, { V_T001: "VIEW/DV" });
    const view = node(graph, "V_T001");
    expect(view?.kind).toBe("view");
    expect(view?.status).toBe("loaded");
    expect(view?.objectType).toBe("VIEW");
    expect(view?.expandable).toBe(false);
    expect(graph.warnings.some((w) => w.includes("metadata only"))).toBe(true);
  });

  it("preserves an unsupported dependency as an explicit unknown node", async () => {
    const mixed = `define view entity A as select from B left outer join ZDCL on B.x = ZDCL.x { key B.x }`;
    const { graph } = await run("A", { A: mixed, B }, { ZDCL: "DCLS/DL" });
    const unsupported = node(graph, "ZDCL");
    expect(unsupported).toBeDefined();
    expect(unsupported?.kind).toBe("unknown");
    expect(unsupported?.status).toBe("read-error");
    expect(unsupported?.errorCode).toBe("unsupported-type");
    expect(graph.edges.map((e) => [e.from, e.to])).toContainEqual(["A", "ZDCL"]);
  });

  it("allows a DDIC table root", async () => {
    const { graph } = await run(
      "CDPOS",
      { CDPOS: "define table cdpos { mandt : mandt; }" },
      { CDPOS: "TABL/DT" },
    );
    expect(graph.rootId).toBe("CDPOS");
    expect(graph.nodes).toHaveLength(1);
    expect(node(graph, "CDPOS")?.kind).toBe("table");
    expect(node(graph, "CDPOS")?.status).toBe("loaded");
    expect(node(graph, "CDPOS")?.resolution).toBe("resolved");
  });

  it("allows a DDIC structure root", async () => {
    const { graph } = await run(
      "BAPIRET2",
      { BAPIRET2: "define structure bapiret2 { type : bapi_mtype; }" },
      { BAPIRET2: "TABL/DS" },
    );
    expect(node(graph, "BAPIRET2")?.kind).toBe("structure");
    expect(node(graph, "BAPIRET2")?.status).toBe("loaded");
  });

  it("allows a DDIC view root", async () => {
    const { graph } = await run("V_T001", {}, { V_T001: "VIEW/DV" });
    expect(node(graph, "V_T001")?.kind).toBe("view");
    expect(node(graph, "V_T001")?.status).toBe("loaded");
  });

  it("hard-caps traversal depth at 4 even when a caller asks for more", async () => {
    const sources = {
      A: "define view entity A as select from B { key B.x }",
      B: "define view entity B as select from C { key C.x }",
      C: "define view entity C as select from D { key D.x }",
      D: "define view entity D as select from E { key E.x }",
      E: "define view entity E as select from F { key F.x }",
      F: "define view entity F as select from G { key G.x }",
    };
    const { graph } = await run("A", sources, {}, { maxDepth: 10 });
    expect(graph.maxDepth).toBe(4);
    expect(node(graph, "E")?.depth).toBe(4);
    expect(node(graph, "E")?.status).toBe("loaded");
    const f = node(graph, "F");
    expect(f?.depth).toBe(5);
    expect(f?.status).toBe("not-expanded");
    expect(f?.errorCode).toBe("max-depth");
  });

  it("sanitizes non-finite limits instead of expanding without bound", async () => {
    const { graph } = await run(
      "A",
      { A: "define view entity A as select from B { key B.x }", B },
      {},
      { maxDepth: Number.NaN, maxObjects: Number.NaN, concurrency: Number.NaN },
    );
    expect(graph.maxDepth).toBe(4);
    expect(node(graph, "B")?.status).toBe("loaded");
  });

  it("records resolution and cache metadata on nodes", async () => {
    const { graph } = await run("A", { A });
    expect(node(graph, "A")?.resolution).toBe("resolved");
    expect(node(graph, "A")?.cacheHit).toBe(false);
    expect(node(graph, "A")?.objectType).toBe("DDLS");
    expect(node(graph, "A")?.objectSubtype).toBe("DF");
  });
});
