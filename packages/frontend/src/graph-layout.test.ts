import { describe, expect, it } from "vitest";
import type { DependencyGraph } from "@cds-visualiser/shared";
import { buildFlow } from "./graph-layout";

const graph: DependencyGraph = {
  rootId: "A",
  maxDepth: 3,
  nodes: [
    { id: "A", name: "A", kind: "cds", depth: 0, status: "loaded", expandable: true, dependencies: ["B"] },
    { id: "B", name: "B", kind: "cds", depth: 1, status: "loaded", expandable: true, dependencies: [] },
  ],
  edges: [{ id: "A->B", from: "A", to: "B" }],
  warnings: [],
};

describe("buildFlow", () => {
  it("maps the dependent above its dependency (top-to-bottom)", () => {
    const { nodes, edges } = buildFlow(graph);
    const a = nodes.find((n) => n.id === "A")!;
    const b = nodes.find((n) => n.id === "B")!;
    expect(a.position.y).toBeLessThan(b.position.y);
    expect(edges[0]).toMatchObject({ source: "A", target: "B" });
  });

  it("preserves node and edge identities", () => {
    const { nodes, edges } = buildFlow(graph);
    expect(nodes.map((n) => n.id).sort()).toEqual(["A", "B"]);
    expect(edges.map((e) => e.id)).toEqual(["A->B"]);
  });
});
