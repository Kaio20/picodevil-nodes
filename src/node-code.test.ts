import { describe, expect, it } from "vitest";
import { examples } from "./examples";
import { createExampleGraph } from "./node-examples";
import { exportNodeCode } from "./node-code";
import { makeNode, type Graph } from "./node-graph";
import { compileLiveGraph, readLiveGraph } from "./node-runtime";
import { collectScreens, initRegistry, resetRegistry } from "./pattern-registry";
import { runTranspiled } from "./eval-sandbox";
import { transpile } from "./transpiler";

function runExport(code: string) {
  initRegistry();
  resetRegistry();
  runTranspiled(transpile(code).code, { setCpm: () => {}, nodeGraphValues: readLiveGraph });
  return collectScreens();
}

describe("PicoDevil node export", () => {
  it("writes connected position signals and literal coordinates as PicoDevil controls", () => {
    const color = makeNode("color", 12, 18, { color: { hex: "#ff0000", alpha: 1 } });
    const wave = makeNode("waveform", 0, 0);
    const range = makeNode("range", 0, 0, { min: 0.2, max: 0.8 });
    const position = makeNode("position", 300, 400, { y: 0.75 });
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [color, wave, range, position, output],
      edges: [
        { from: wave.id, to: range.id, input: "signal" },
        { from: color.id, to: position.id, input: "image" },
        { from: range.id, to: position.id, input: "x" },
        { from: position.id, to: output.id, input: "image" },
      ],
      variables: [],
    };
    const code = exportNodeCode(graph, []);
    expect(code).toContain("$: color('#ff0000')\n  .x(sine.range(0.2, 0.8))\n  .y(0.75)");
    expect(code).not.toContain("nodeGraph");
    const [screen] = runExport(code);
    const [reference] = compileLiveGraph(graph).screens;
    for (const cycle of [0, 0.25, 0.5, 0.75]) {
      const result = screen.queryArc(cycle, cycle)[0].value;
      expect({ colorAlpha: 1, ...result }).toEqual(reference.queryArc(cycle, cycle)[0].value);
    }
  });

  it("exports the values and connections of sequenced Color inputs", () => {
    const source = makeNode("color", 0, 0, { color: { hex: "#0000ff", alpha: 0.5 } });
    const pattern = makeNode("color", 0, 0, {
      mode: "pattern", inputCount: 2, "color-1": { hex: "#ff0000", alpha: 1 },
    });
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [source, pattern, output], variables: [],
      edges: [
        { from: source.id, to: pattern.id, input: "color-2" },
        { from: pattern.id, to: output.id, input: "image" },
      ],
    };
    const [screen] = runExport(exportNodeCode(graph, []));
    expect(screen.queryArc(0.25, 0.25)[0].value).toMatchObject({ color: "#ff0000", colorAlpha: 1 });
    expect(screen.queryArc(0.75, 0.75)[0].value).toMatchObject({ color: "#0000ff", colorAlpha: 0.5 });
  });

  it("preserves literal text through the PicoDevil transpiler", () => {
    const content = "It's a \"draft\".\nC:\\media";
    const text = makeNode("text", 0, 0, { content });
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [text, output], edges: [{ from: text.id, to: output.id, input: "image" }], variables: [],
    };
    const [screen] = runExport(exportNodeCode(graph, []));
    expect(screen.queryArc(0, 0)[0].value.text).toBe(content);
  });

  it("keeps native position controls after a per-pixel opacity mask", () => {
    const color = makeNode("color", 0, 0);
    const ramp = makeNode("colorRamp", 0, 0);
    const opacity = makeNode("alpha", 0, 0);
    const position = makeNode("position", 0, 0, { x: 0.25, y: 0.75 });
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [color, ramp, opacity, position, output],
      edges: [
        { from: color.id, to: opacity.id, input: "image" },
        { from: ramp.id, output: "mask", to: opacity.id, input: "value" },
        { from: opacity.id, to: position.id, input: "image" },
        { from: position.id, to: output.id, input: "image" },
      ],
      variables: [],
    };
    const code = exportNodeCode(graph, []);
    expect(code).toContain("nodeGraphValues(");
    expect(code).not.toContain(position.id);
    expect(code).toContain(`$: readNode('${opacity.id}')\n  .x(0.25)\n  .y(0.75)`);
    const screens = runExport(code);
    const reference = compileLiveGraph(graph).screens;
    expect(screens).toHaveLength(reference.length);
    expect(screens.at(-1)?.queryArc(0, 0)[0].value).toEqual(reference.at(-1)?.queryArc(0, 0)[0].value);
  });

  it("exports space_tv in classic order and ignores unused branches when naming patterns", () => {
    const graph = createExampleGraph("space_tv");
    const shuffled = graph.nodes.find(node => node.kind === "index")!;
    const unused = makeNode("brightness", 0, 0);
    graph.nodes.push(unused);
    graph.edges.push({ from: shuffled.id, to: unused.id, input: "image" });
    const code = exportNodeCode(graph, []);
    expect(code).toMatch(/\$: s\("#222"\)[\s\S]*Hscan: s\("scanlines"\)[\s\S]*\$: s\("issexercise1,/);
    expect(code).toContain(`.stack(s("scan").blend('multiply').alpha(0.4))\n  .rows(3)\n  .cols(4)\n  .gridMod()\n  .scale(0.9)`);
    expect(code).not.toContain("const pattern");
  });

  it("keeps explicit output order and explains when an opaque layer covers the scene", () => {
    const graph = createExampleGraph("space_tv");
    const background = graph.nodes.find(node => node.kind === "output")!;
    graph.nodes = [...graph.nodes.filter(node => node !== background), background];
    const code = exportNodeCode(graph, []);
    expect(code).toContain(`// Layer 2 covers the earlier outputs. For a background, put this layer first.\n$: s("#222")`);
    const lastScreen = runExport(code).at(-1)!;
    expect(lastScreen.queryArc(0, 0)[0].value).toEqual({ _type: "color", color: "#222" });
  });

  it("exports the connected layers in order with an isolated Output in between", () => {
    const graph = createExampleGraph("space_tv");
    const code = exportNodeCode(graph, []);
    const firstOutput = graph.nodes.findIndex(node => node.kind === "output");
    graph.nodes.splice(firstOutput + 1, 0, makeNode("output", 0, 0));
    expect(exportNodeCode(graph, [])).toBe(code);
  });

  it.each(examples.map(example => example.name))("exports the %s example as native code", name => {
    const graph = createExampleGraph(name);
    const code = exportNodeCode(graph, []);
    expect(code).not.toContain("nodeGraph");
    const screens = runExport(code);
    expect(screens).toHaveLength(compileLiveGraph(graph).screens.length);
  });
});
