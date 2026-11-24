import { describe, expect, it } from "vitest";
import { inputsFor, insertNodeOnEdge, keepCompatibleEdges, makeNode, referenceNode, starterGraph, withEdge, type Graph } from "./node-graph";
import { compileLiveGraph } from "./node-runtime";
import { initRegistry, snapshotRegistry } from "./pattern-registry";
import { loadNodes, saveNodes } from "./node-session";
import { defaultGradient, gradientSampler, rgbHex, type Gradient } from "./gradient";
import { FrameRenderer } from "./renderer";
import { createMetrics } from "./frame-metrics";
import { createVideoPoolManager } from "./video-pool-manager";
import { readPixel, withRenderer } from "./webgl-test-helpers";

describe("NodesDevil graph", () => {
  it("samples Color and Alpha independently while a Gradient variable renders the full ramp", () => {
    initRegistry();
    const gradient: Gradient = { ...defaultGradient, stops: [
      { position: 0, color: "#ff0000", alpha: 0.25 },
      { position: 1, color: "#0000ff", alpha: 0.75 },
    ] };
    const setter = makeNode("set", 0, 0, { variable: "palette", value: gradient });
    const getter = makeNode("get", 0, 0, { variable: "palette" });
    const factor = makeNode("numberPattern", 0, 0, { pattern: "0 0.5 1" });
    const ramp = makeNode("colorRamp", 0, 0);
    const image = makeNode("gradientImage", 0, 0);
    const alpha = makeNode("alpha", 0, 0, { value: 0 });
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [setter, getter, factor, ramp, image, alpha, output],
      variables: [{ id: "palette", name: "Palette", type: "gradient" }],
      edges: [
        { from: getter.id, to: ramp.id, input: "gradient" },
        { from: factor.id, to: ramp.id, input: "factor" },
        { from: ramp.id, output: "gradient", to: image.id, input: "gradient" },
        { from: image.id, to: alpha.id, input: "image" },
        { from: ramp.id, output: "alpha", to: alpha.id, input: "value" },
        { from: alpha.id, to: output.id, input: "image" },
      ],
    };
    expect(keepCompatibleEdges(graph).edges).toEqual(graph.edges);
    expect(withEdge(graph, { from: ramp.id, output: "alpha", to: output.id, input: "image" })).toBeUndefined();
    expect(withEdge(graph, { from: getter.id, to: output.id, input: "image" })).toBeUndefined();
    expect(withEdge(graph, { from: ramp.id, output: "gradient", to: setter.id, input: "value" })).toBeUndefined();
    const compiled = compileLiveGraph(graph);
    expect(compiled.screens[0].queryArc(0.5, 0.5)[0].value).toMatchObject({ _type: "gradient", gradient, alpha: 0.5 });
    const solid = withEdge(graph, { from: ramp.id, to: output.id, input: "image" })!;
    const solidCompiled = compileLiveGraph(solid);
    expect(solidCompiled.screens[0].queryArc(0.1, 0.1)[0].value).toMatchObject({ color: "#ff0000", colorAlpha: 0.25 });
    expect(solidCompiled.screens[0].queryArc(0.9, 0.9)[0].value).toMatchObject({ color: "#0000ff", colorAlpha: 0.75 });
    withRenderer((renderer, canvas) => {
      const pool = createVideoPoolManager({ resolveMediaUrl: name => name });
      const frames = new FrameRenderer(renderer, pool, createMetrics());
      frames.render(compiled.screens, compiled.namedScreens, 0.5, 1, 0.5);
      const left = readPixel(canvas, 5, 50);
      const right = readPixel(canvas, 95, 50);
      expect(left[0]).toBeGreaterThan(left[2]);
      expect(right[2]).toBeGreaterThan(right[0]);
      expect(left[3]).toBeLessThan(right[3]);
      frames.render(solidCompiled.screens, solidCompiled.namedScreens, 0.5, 1, 0.5);
      const center = readPixel(canvas, 50, 50);
      expect(center[0]).toBe(center[2]);
      expect(center[3]).toBeCloseTo(128, -1);
    });

    const key = "nodesdevil-session-v1";
    const previous = localStorage.getItem(key);
    try {
      saveNodes({ draft: graph, live: solid, view: { x: 0, y: 0, zoom: 1, previews: [] }, media: [] });
      const restored = loadNodes();
      expect(restored?.draft).toEqual(graph);
      expect(restored?.live).toEqual(solid);
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });

  it("supports stepped, eased and hue-based color interpolation", () => {
    const stops = [
      { position: 0, color: "#ff0000", alpha: 0 },
      { position: 0.5, color: "#00ff00", alpha: 0.5 },
      { position: 1, color: "#0000ff", alpha: 1 },
    ];
    const stepped = gradientSampler({ ...defaultGradient, stops, interpolation: "Constant" });
    expect(rgbHex(stepped(0.499))).toBe("#ff0000");
    expect(rgbHex(stepped(0.5))).toBe("#00ff00");
    expect(stepped(2)[3]).toBe(1);
    expect(gradientSampler({ ...defaultGradient, stops, interpolation: "Ease" })(0.125)[3]).toBeCloseTo(0.078125);
    for (const space of ["HSV", "HSL"] as const) {
      expect(rgbHex(gradientSampler({ ...defaultGradient, stops, space })(0.25))).toBe("#ffff00");
      expect(rgbHex(gradientSampler({ ...defaultGradient, stops, space, hue: "Far" })(0.25))).toBe("#0000ff");
    }
  });

  it("converts white or black to transparency and blends gray over a background", () => {
    initRegistry();
    const background = makeNode("color", 0, 0, { pattern: "red" });
    const tones = makeNode("color", 0, 0, { pattern: "white #808080 black" });
    const key = makeNode("lumaToAlpha", 0, 0);
    const stack = makeNode("stack", 0, 0);
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [background, tones, key, stack, output], variables: [],
      edges: [
        { from: background.id, to: stack.id, input: "image" },
        { from: tones.id, to: key.id, input: "image" },
        { from: key.id, to: stack.id, input: "second" },
        { from: stack.id, to: output.id, input: "image" },
      ],
    };
    withRenderer((renderer, canvas) => {
      const pool = createVideoPoolManager({ resolveMediaUrl: name => name });
      const frames = new FrameRenderer(renderer, pool, createMetrics());
      const sample = (compiled: ReturnType<typeof compileLiveGraph>, cycle: number) => {
        frames.render(compiled.screens, compiled.namedScreens, cycle, 1, 0);
        return readPixel(canvas, 50, 50);
      };

      const whiteKey = compileLiveGraph(graph);
      expect(sample(whiteKey, 0.1)).toEqual([255, 0, 0, 255]);
      expect(sample(whiteKey, 0.5)).toEqual([128, 0, 0, 255]);
      expect(sample(whiteKey, 0.9)).toEqual([0, 0, 0, 255]);

      key.data.mode = "black";
      const blackKey = compileLiveGraph(graph);
      expect(sample(blackKey, 0.1)).toEqual([255, 255, 255, 255]);
      expect(sample(blackKey, 0.5)).toEqual([255, 128, 128, 255]);
      expect(sample(blackKey, 0.9)).toEqual([255, 0, 0, 255]);
    });
  });

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

  it("inserts into one branch of a cable without changing the other connections", () => {
    const graph = starterGraph();
    const [source, output] = graph.nodes;
    const brightness = makeNode("brightness", 0, 0);
    const otherOutput = makeNode("output", 0, 0);
    const [target] = graph.edges;
    const other = { from: source.id, to: otherOutput.id, input: "image" };
    graph.nodes.push(brightness, otherOutput);
    graph.edges.push(other);
    const result = insertNodeOnEdge(graph, brightness, target);
    expect(result?.spliced).toBe(true);
    expect(result?.graph.edges).toEqual([
      other,
      { from: source.id, to: brightness.id, input: "image" },
      { from: brightness.id, to: output.id, input: "image" },
    ]);
    expect(graph.edges).toEqual([target, other]);
    expect(insertNodeOnEdge(graph, source, target)).toBeUndefined();
  });

  it("uses a compatible secondary input and leaves the cable intact when the outputs differ", () => {
    const graph = starterGraph();
    const [source] = graph.nodes;
    const signal = makeNode("waveform", 0, 0);
    const scale = makeNode("scale", 0, 0);
    const brightness = makeNode("brightness", 0, 0);
    const target = { from: signal.id, to: scale.id, input: "value" };
    const image = { from: source.id, to: brightness.id, input: "image" };
    graph.nodes.push(signal, scale, brightness);
    graph.edges.push(target, image);
    const result = insertNodeOnEdge(graph, brightness, target);
    expect(result?.spliced).toBe(false);
    expect(result?.graph.edges).toEqual([...graph.edges, { from: signal.id, to: brightness.id, input: "value" }]);
    expect(insertNodeOnEdge(result!.graph, brightness, target)).toBeUndefined();
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
    const source = makeNode("text", 0, 0, { content: "Hello" });
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

  it("styles text layers and accepts them in visual effects while keeping images out of font nodes", () => {
    initRegistry();
    const { nodes: [card, output] } = starterGraph();
    const source = makeNode("text", 0, 0);
    const style = makeNode("textStyle", 0, 0, { size: 48 });
    const scale = makeNode("scale", 0, 0, { value: 2 });
    const content = makeNode("set", 0, 0, { variable: "message", value: "Hello world" });
    const graph: Graph = {
      nodes: [card, output, source, style, scale, content], edges: [],
      variables: [{ id: "message", name: "Message", type: "text" }],
    };
    expect(withEdge(graph, { from: card.id, to: style.id, input: "image" })).toBeUndefined();
    expect(withEdge(graph, { from: content.id, to: style.id, input: "image" })).toBeUndefined();
    expect(withEdge(graph, { from: source.id, to: output.id, input: "image" })).toBeDefined();
    const wired = [
      { from: content.id, to: source.id, input: "content" },
      { from: source.id, to: style.id, input: "image" },
      { from: style.id, to: scale.id, input: "image" },
      { from: scale.id, to: output.id, input: "image" },
    ].reduce((next, edge) => withEdge(next, edge)!, graph);
    expect(compileLiveGraph(wired).screens[0].queryArc(0, 0)[0].value)
      .toMatchObject({ _type: "text", text: "Hello world", fontSize: 48, scaleX: 2 });
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
      const expected = {
        nodes: [
          { id: "signal", kind: "waveform", x: 10, y: 20, data: { mode: "sine" } },
          { id: "rate", kind: "signalRate", x: 30, y: 40, data: { mode: "slow", value: 3 } },
          { id: "size", kind: "textStyle", x: 50, y: 60, data: { size: 90 } },
          { kind: "output", x: 280, y: 60, data: {} },
        ],
        edges: [{ from: "signal", to: "rate", input: "signal" }, { from: "rate", to: "size", input: "size" }],
        variables: [],
      };
      expect(restored?.draft).toMatchObject(expected);
      expect(restored?.live).toMatchObject(expected);
      expect(restored?.view.previews).toEqual(["rate"]);
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });
});
