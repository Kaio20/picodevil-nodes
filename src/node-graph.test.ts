import { describe, expect, it } from "vitest";
import { inputsFor, keepCompatibleEdges, makeNode, referenceNode, starterGraph, withEdge, type Graph } from "./node-graph";
import { compileLiveGraph } from "./node-runtime";
import { initRegistry, snapshotRegistry } from "./pattern-registry";
import { loadNodes } from "./node-session";

describe("NodesDevil graph", () => {
  it("replaces the cable at an occupied input and rejects incompatible ports and cycles", () => {
    const color = makeNode("color", 0, 0);
    const signal = makeNode("waveform", 0, 0);
    const first = makeNode("hue", 0, 0);
    const last = makeNode("scale", 0, 0);
    const graph: Graph = {
      nodes: [color, signal, first, last], variables: [],
      edges: [{ from: color.id, to: first.id, input: "image" }, { from: first.id, to: last.id, input: "image" }],
    };
    expect(withEdge(graph, { from: signal.id, to: first.id, input: "image" })).toBeUndefined();
    expect(withEdge(graph, { from: last.id, to: first.id, input: "image" })).toBeUndefined();
    const next = withEdge(graph, { from: color.id, to: last.id, input: "image" });
    expect(next?.edges.filter(edge => edge.to === last.id)).toEqual([{ from: color.id, to: last.id, input: "image" }]);
    expect(graph.edges[1].from).toBe(first.id);
  });

  it("detects feedback through Get and Set", () => {
    const get = makeNode("get", 0, 0, { variable: "amount" });
    const set = makeNode("set", 0, 0, { variable: "amount" });
    const graph: Graph = { nodes: [get, set], edges: [], variables: [{ id: "amount", name: "Amount", type: "number" }] };
    expect(withEdge(graph, { from: get.id, to: set.id, input: "value" })).toBeUndefined();
  });

  it("builds a typed variable directly into a pattern and leaves the running registry in place", () => {
    initRegistry();
    const graph = starterGraph();
    const set = makeNode("set", 0, 0, { variable: "amount", value: 0.3 });
    const get = makeNode("get", 0, 0, { variable: "amount" });
    const opacity = makeNode("alpha", 0, 0);
    const [card, output] = graph.nodes;
    graph.nodes.push(set, get, opacity);
    graph.variables.push({ id: "amount", name: "Amount", type: "number" });
    graph.edges = [
      { from: card.id, to: opacity.id, input: "image" },
      { from: get.id, to: opacity.id, input: "value" },
      { from: opacity.id, to: output.id, input: "image" },
    ];
    const previous = snapshotRegistry();
    const compiled = compileLiveGraph(graph);
    expect(compiled.screens[0].queryArc(0, 0)[0].value.alpha).toBeCloseTo(0.3);
    expect(snapshotRegistry()).toEqual(previous);
    expect(() => compileLiveGraph({ ...graph, edges: [] })).toThrow(/connection/);
    expect(snapshotRegistry()).toEqual(previous);
  });

  it("uses independently wired scale axes and falls back to uniform scale for empty axes", () => {
    initRegistry();
    const graph = starterGraph();
    const [card, output] = graph.nodes;
    const scale = makeNode("scale", 0, 0, { value: 3, y: 2 });
    const horizontal = makeNode("numberPattern", 0, 0, { pattern: "0.5" });
    graph.nodes.push(scale, horizontal);
    graph.edges = [
      { from: card.id, to: scale.id, input: "image" },
      { from: horizontal.id, to: scale.id, input: "x" },
      { from: scale.id, to: output.id, input: "image" },
    ];
    const value = compileLiveGraph(graph).screens[0].queryArc(0, 0)[0].value;
    expect(value).toMatchObject({ scaleX: 0.5, scaleY: 2 });
    const uniform = compileLiveGraph({ ...graph, edges: graph.edges.filter(edge => edge.input !== "x") }).screens[0].queryArc(0, 0)[0].value;
    expect(uniform).toMatchObject({ scaleX: 3, scaleY: 2 });
  });

  it("switches a connected signal between Fast and Slow using the same factor input", () => {
    initRegistry();
    const graph = starterGraph();
    const [card, output] = graph.nodes;
    const values = makeNode("numberPattern", 0, 0, { pattern: "1 2" });
    const rate = makeNode("signalRate", 0, 0, { mode: "slow", value: 2 });
    const scale = makeNode("scale", 0, 0);
    graph.nodes.push(values, rate, scale);
    graph.edges = [
      { from: card.id, to: scale.id, input: "image" },
      { from: values.id, to: rate.id, input: "signal" },
      { from: rate.id, to: scale.id, input: "value" },
      { from: scale.id, to: output.id, input: "image" },
    ];
    const sampleScale = (item: Graph) => compileLiveGraph(item).screens[0].queryArc(0.375, 0.375)[0].value.scaleX;
    expect(sampleScale(graph)).toBe(1);
    expect(sampleScale({ ...graph, nodes: graph.nodes.map(node => node === rate ? { ...node, data: { ...node.data, mode: "fast" } } : node) })).toBe(2);
    expect(referenceNode("slow", [])).toEqual({ kind: "signalRate", data: { mode: "slow" } });
  });

  it("retains a Stack cable while its socket is hidden in another mode", () => {
    const source = makeNode("testCard", 0, 0);
    const stack = makeNode("stack", 0, 0, { mode: "repeat" });
    const graph: Graph = { nodes: [source, stack], edges: [{ from: source.id, to: stack.id, input: "second" }], variables: [] };
    expect(inputsFor(graph, stack).map(input => input.id)).toEqual(["image", "value"]);
    expect(keepCompatibleEdges(graph).edges).toEqual(graph.edges);
    expect(inputsFor(graph, { ...stack, data: { mode: "overlay" } }).map(input => input.id)).toEqual(["image", "second"]);
  });

  it("uses a Boolean for Italic On/Off and keeps the continuous Italic axis available", () => {
    initRegistry();
    const source = makeNode("screen", 0, 0, { pattern: "text:Hello" });
    const italic = makeNode("fontAxis", 0, 0, { tag: "italic", value: 0.25 });
    const setter = makeNode("set", 0, 0, { variable: "toggle", value: false });
    const output = makeNode("output", 0, 0);
    let graph: Graph = {
      nodes: [source, italic, setter, output], variables: [{ id: "toggle", name: "Italic", type: "boolean" }],
      edges: [{ from: source.id, to: italic.id, input: "image" }, { from: italic.id, to: output.id, input: "image" }],
    };
    const sample = (item: Graph) => compileLiveGraph(item).screens[0].queryArc(0, 0)[0].value._fontVariation_ital;
    expect(inputsFor(graph, italic).find(socket => socket.id === "enabled")?.type).toBe("boolean");
    expect(sample(graph)).toBe(1);
    graph = withEdge(graph, { from: setter.id, to: italic.id, input: "enabled" })!;
    expect(sample(graph)).toBe(0);
    const blend = { ...italic, data: { ...italic.data, tag: "ital" } };
    const blendedGraph = keepCompatibleEdges({ ...graph, nodes: graph.nodes.map(node => node === italic ? blend : node) });
    expect(blendedGraph.edges).toEqual(graph.edges);
    expect(sample(blendedGraph)).toBe(0.25);
  });

  it("restores old nodes and remaps the Font Size input without changing node IDs", () => {
    const key = "nodesdevil-session-v1";
    const previous = localStorage.getItem(key);
    const nodes = [
      { id: "signal", kind: "sine", x: 10, y: 20, data: {} },
      { id: "rate", kind: "slowSignal", x: 30, y: 40, data: { value: 3 } },
      { id: "size", kind: "fontSize", x: 50, y: 60, data: { value: 90 } },
    ];
    const draft = { nodes, variables: [], edges: [{ from: "signal", to: "rate", input: "signal" }, { from: "rate", to: "size", input: "value" }] };
    try {
      localStorage.setItem(key, JSON.stringify({ draft, live: draft, view: { x: 3, y: 4, zoom: 1, previews: ["rate"] }, media: [] }));
      const restored = loadNodes();
      expect(restored?.draft.nodes).toMatchObject([
        { id: "signal", kind: "waveform", x: 10, y: 20, data: { mode: "sine" } },
        { id: "rate", kind: "signalRate", data: { mode: "slow", value: 3 } },
        { id: "size", kind: "textStyle", data: { size: 90 } },
      ]);
      expect(restored?.draft.edges).toEqual([{ from: "signal", to: "rate", input: "signal" }, { from: "rate", to: "size", input: "size" }]);
      expect(restored?.live).toEqual(restored?.draft);
      expect(restored?.view.previews).toEqual(["rate"]);
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });
});
