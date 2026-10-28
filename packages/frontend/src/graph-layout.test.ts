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

  it("gives parallel edges distinct handles so joins do not overlap", () => {
    const parallel: DependencyGraph = {
      rootId: "A",
      maxDepth: 3,
      nodes: [
        { id: "A", name: "A", kind: "cds", depth: 0, status: "loaded", expandable: true, dependencies: ["B"] },
        { id: "B", name: "B", kind: "table", depth: 1, status: "loaded", expandable: false, dependencies: [] },
      ],
      edges: [
        { id: "A->B", from: "A", to: "B", sourceRole: "join", joinType: "leftOuter" },
        { id: "A->B#2", from: "A", to: "B", sourceRole: "join", joinType: "inner" },
      ],
      warnings: [],
    };
    const { nodes, edges } = buildFlow(parallel);
    expect(edges[0]?.sourceHandle).not.toBe(edges[1]?.sourceHandle);
    expect(edges[0]?.targetHandle).not.toBe(edges[1]?.targetHandle);
    const sourcePorts = (nodes.find((node) => node.id === "A")?.data as { sourcePorts: unknown[] }).sourcePorts;
    expect(sourcePorts).toHaveLength(2);
  });

  it("hides association edges and association-only nodes when disabled", () => {
    const withAssociation: DependencyGraph = {
      rootId: "A",
      maxDepth: 3,
      nodes: [
        { id: "A", name: "A", kind: "cds", depth: 0, status: "loaded", expandable: true, dependencies: ["B", "C"] },
        { id: "B", name: "B", kind: "table", depth: 1, status: "loaded", expandable: false, dependencies: [] },
        { id: "C", name: "C", kind: "table", depth: 1, status: "loaded", expandable: false, dependencies: [] },
      ],
      edges: [
        { id: "A->B", from: "A", to: "B", sourceRole: "primary" },
        { id: "A->C", from: "A", to: "C", sourceRole: "association" },
      ],
      warnings: [],
    };
    const filtered = buildFlow(withAssociation, { showAssociations: false });
    expect(filtered.nodes.map((node) => node.id).sort()).toEqual(["A", "B"]);
    expect(filtered.edges.map((edge) => edge.id)).toEqual(["A->B"]);
    expect(buildFlow(withAssociation, { showAssociations: true }).edges).toHaveLength(2);
  });

  it("wraps a wide rank into rows instead of one long horizontal line", () => {
    const leaves = Array.from({ length: 40 }, (_, index) => `L${index}`);
    const wide: DependencyGraph = {
      rootId: "A",
      maxDepth: 2,
      nodes: [
        { id: "A", name: "A", kind: "cds", depth: 0, status: "loaded", expandable: true, dependencies: leaves },
        ...leaves.map((id) => ({
          id,
          name: id,
          kind: "table" as const,
          depth: 1,
          status: "loaded" as const,
          expandable: false,
          dependencies: [],
        })),
      ],
      edges: leaves.map((id) => ({ id: `A->${id}`, from: "A", to: id, sourceRole: "primary" as const })),
      warnings: [],
    };

    const { nodes } = buildFlow(wide);
    const leafNodes = nodes.filter((node) => node.id !== "A");
    const xs = new Set(leafNodes.map((node) => Math.round(node.position.x)));
    const ys = new Set(leafNodes.map((node) => Math.round(node.position.y)));
    const width = Math.max(...leafNodes.map((node) => node.position.x)) - Math.min(...leafNodes.map((node) => node.position.x));

    expect(xs.size).toBeLessThan(leafNodes.length);
    expect(ys.size).toBeGreaterThan(1);
    expect(width).toBeLessThan(4000);
  });

  it("labels relationships for hover and marks unused edges", () => {
    const relationshipGraph: DependencyGraph = {
      rootId: "A",
      maxDepth: 3,
      nodes: [
        { id: "A", name: "A", kind: "cds", depth: 0, status: "loaded", expandable: true, dependencies: ["B"] },
        { id: "B", name: "B", kind: "table", depth: 1, status: "loaded", expandable: false, dependencies: [] },
      ],
      edges: [
        {
          id: "A->B",
          from: "A",
          to: "B",
          sourceRole: "join",
          joinType: "leftOuter",
          relationship: {
            kind: "join",
            joinType: "leftOuter",
            alias: "_B",
            usedInProjection: false,
          },
        },
      ],
      warnings: [],
    };
    const { edges } = buildFlow(relationshipGraph);
    expect(edges[0]?.data).toMatchObject({ label: "Left outer join · _B · unused", unused: true });
    expect(edges[0]?.style).toMatchObject({ strokeDasharray: "3 4" });
  });
});
