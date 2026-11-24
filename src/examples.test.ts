import { describe, it, expect, afterEach, vi } from "vitest";
import { setupExamples, examples, autostartExamples, pickAutostartCode } from "./examples";
import { createExampleGraph } from "./node-examples";
import { keepCompatibleEdges } from "./node-graph";
import { compileLiveGraph } from "./node-runtime";
import { initRegistry, restoreRegistry, snapshotRegistry } from "./pattern-registry";

describe("autostart example selection", () => {
  it("includes only examples opted in with autostart:true, never the flashing colour grids", () => {
    const eligible = autostartExamples();
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible.every(e => e.autostart === true)).toBe(true);
    expect(eligible.some(e => e.name === "colour grids (flashing)")).toBe(false);
  });

  it("picks code only from the eligible subset", () => {
    const eligible = autostartExamples();
    // Deterministic selector → last eligible example's code.
    const code = pickAutostartCode(() => eligible.length - 1);
    expect(code).toBe(eligible[eligible.length - 1].code);
    expect(eligible.some(e => e.code === code)).toBe(true);
  });
});

describe("examples list", () => {
  it("passes each clicked example to the graph loader", () => {
    const container = document.createElement("div");
    const onSelect = vi.fn();
    setupExamples(container, onSelect);
    container.querySelectorAll("button").forEach(button => button.click());
    expect(onSelect.mock.calls).toEqual(examples.map(example => [example]));
  });
});

describe("example graphs", () => {
  const previous = snapshotRegistry();
  afterEach(() => restoreRegistry(previous));

  for (const [example, layers] of examples.map((item, index) => [item, [2, 3, 1, 1, 3, 2][index]] as const)) {
    it(`builds and queries ${example.name}`, () => {
      initRegistry();
      const graph = createExampleGraph(example.name);
      expect(keepCompatibleEdges(graph).edges).toEqual(graph.edges);
      const result = compileLiveGraph(graph);
      restoreRegistry(result.registry);
      expect(result.screens).toHaveLength(layers);
      expect(result.screens.every(screen => [0, 0.125, 1.375, 3.25].some(cycle => screen.queryArc(cycle, cycle).length))).toBe(true);
    });
  }

  it("connects different signals to the two axes of Scroll and Position", () => {
    for (const [example, kind] of [["rgb", "scroll"], ["picodevil", "position"]] as const) {
      const graph = createExampleGraph(example);
      const node = graph.nodes.find(item => item.kind === kind)!;
      const { x, y } = Object.fromEntries(graph.edges.filter(edge => edge.to === node.id).map(edge => [edge.input, edge.from]));
      expect(x).toBeTruthy();
      expect(y).toBeTruthy();
      expect(x).not.toBe(y);
    }
  });
});
