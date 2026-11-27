import { describe, expect, it } from "vitest";
import { cableInput, inputType, inputsFor, insertNodeOnEdge, isAutomaticConversion, isVariableSetter, keepCompatibleEdges, makeNode, outputsFor, outputType, pruneRoutingNodes, referenceNode, starterGraph, valueTypes, withConvertedEdge, withEdge, type Graph } from "./node-graph";
import { compileLiveGraph } from "./node-runtime";
import { initRegistry, snapshotRegistry } from "./pattern-registry";
import { loadNodes, saveNodes } from "./node-session";
import { defaultGradient, gradientSampler, type Gradient } from "./gradient";
import { rgbHex } from "./color-value";
import { FrameRenderer } from "./renderer";
import { createMetrics } from "./frame-metrics";
import { createVideoPoolManager } from "./video-pool-manager";
import { readPixel, withRenderer } from "./webgl-test-helpers";
import { NodeMotions, NodeTransport } from "./node-transport";
import { CpsController } from "./cps-controller";
import { nodeVideoPattern } from "./node-video";
import { initRegistry as initMediaRegistry } from "./media-registry";

describe("NodesDevil graph", () => {
  it("keeps Time's rate independent of frame intervals and follows live tempo changes", () => {
    initRegistry();
    const time = makeNode("time", 0, 0);
    const color = makeNode("color", 0, 0);
    const rotate = makeNode("rotate", 0, 0);
    const output = makeNode("output", 0, 0);
    const graph: Graph = { nodes: [time, color, rotate, output], edges: [
      { from: time.id, output: "rate", to: rotate.id, input: "value" },
      { from: color.id, to: rotate.id, input: "image" },
      { from: rotate.id, to: output.id, input: "image" },
    ], variables: [], tempo: 60 };
    const transport = new NodeTransport();
    const { screens } = compileLiveGraph(keepCompatibleEdges(graph), transport);
    const clock = new CpsController(1, 1000);
    const sample = (ms: number) => {
      const { cycle, cps } = clock.tick(ms);
      transport.advance(cycle, cps, ms);
      return { cycle, rate: screens[0].queryArc(cycle, cycle)[0].value.rotateZ };
    };
    expect(sample(1020)).toEqual({ cycle: 0.02, rate: 1 });
    expect(sample(2500)).toEqual({ cycle: 1.5, rate: 1 });
    clock.setCpm(120, 2500);
    expect(sample(2500)).toEqual({ cycle: 1.5, rate: 2 });
    expect(sample(3000)).toEqual({ cycle: 2.5, rate: 2 });
    clock.setCpm(0, 3000);
    expect(sample(5000)).toEqual({ cycle: 2.5, rate: 0 });
  });

  it("keeps two Time branches independent through live factor edits and wraps a full turn", () => {
    initRegistry();
    const time = makeNode("time", 0, 0);
    const multiply = makeNode("expression", 0, 0, { mode: "multiply", b: 2 });
    const texture = makeNode("color", 0, 0);
    const direct = makeNode("rotate", 0, 0);
    const branch = makeNode("rotate", 0, 0);
    const outputA = makeNode("output", 0, 0);
    const outputB = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [time, multiply, texture, direct, branch, outputA, outputB], variables: [], tempo: 30,
      edges: [
        { from: time.id, to: multiply.id, input: "a" },
        { from: time.id, to: direct.id, input: "value" },
        { from: multiply.id, to: branch.id, input: "value" },
        { from: texture.id, to: direct.id, input: "image" },
        { from: texture.id, to: branch.id, input: "image" },
        { from: direct.id, to: outputA.id, input: "image" },
        { from: branch.id, to: outputB.id, input: "image" },
      ],
    };
    const { screens, motions, tempo } = compileLiveGraph(graph, new NodeTransport(), new NodeMotions());
    const angle = (index: number, cycle: number) => screens[index].queryArc(cycle, cycle)[0].value.rotateZ;
    expect(tempo).toBe(30);
    expect(angle(0, 0.25)).toBeCloseTo(0.25);
    expect(angle(1, 0.25)).toBeCloseTo(0.5);
    expect(motions.setFactor(multiply.id, "b", 0.25, 4)).toBe(true);
    expect(angle(1, 0.25)).toBeCloseTo(0.5);
    expect(angle(1, 0.3)).toBeCloseTo(0.7);
    expect(angle(0, 0.3)).toBeCloseTo(0.3);
    expect(angle(0, 361 / 360)).toBeCloseTo(1 / 360);
  });

  it("uses full video durations across a tempo change and supports both cycle modes", () => {
    const first = { id: "test-long", name: "long", url: "/long.mp4", type: "video" as const, duration: 3, thumbnail: "/empty.png" };
    const second = { id: "test-short", name: "short", url: "/short.mp4", type: "video" as const, duration: 1, thumbnail: "/empty.png" };
    const unavailable = { ...second, id: "unavailable", name: "unavailable", unavailable: true };
    initMediaRegistry([first, unavailable, second]);
    try {
      const transport = new NodeTransport();
      transport.reset(0);
      const full = nodeVideoPattern("video", [first.id, unavailable.id, second.id], "clipEnd", transport);
      const at = (cycle: number) => full.queryArc(cycle, cycle)[0].value;
      expect(at(0)).toMatchObject({ src: "long", _playlistElapsed: 0 });
      transport.advance(0.5, 1, 1000);
      expect(at(0.5)).toMatchObject({ src: "long", _playlistElapsed: 1 });
      transport.advance(2.5, 1, 3000);
      expect(at(2.5)).toMatchObject({ src: "short", _playlistElapsed: 0 });
      transport.advance(3.5, 1, 4000);
      expect(at(3.5)).toMatchObject({ src: "long", _playlistElapsed: 0 });
      const within = nodeVideoPattern("within", [first.id, second.id], "listPerCycle", transport);
      const between = nodeVideoPattern("between", [first.id, second.id], "clipPerCycle", transport);
      expect(within.queryArc(0.75, 0.75)[0].value.src).toBe("short");
      expect(between.queryArc(0.75, 0.75)[0].value.src).toBe("long");
      expect(between.queryArc(1.25, 1.25)[0].value.src).toBe("short");
    } finally { initMediaRegistry([]); }
  });

  it("restores matching live and draft patches even after moving a node", () => {
    const time = makeNode("time", 0, 0);
    const graph: Graph = { nodes: [time, makeNode("output", 220, 0)], edges: [], variables: [], tempo: 45 };
    const draft = { ...graph, nodes: [{ ...time, x: 80 }, graph.nodes[1]] };
    const key = "nodesdevil-session-v1";
    const previous = localStorage.getItem(key);
    try {
      const session = { draft, live: graph, view: { x: 0, y: 0, zoom: 1, previews: [] }, media: [] };
      saveNodes(session);
      const restored = loadNodes()!;
      expect(restored.live).toBe(restored.draft);
      saveNodes({ ...session, draft: { ...draft, tempo: 60 } });
      expect(loadNodes()?.live?.tempo).toBe(45);
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });

  it("passes image inputs in row order to Index", () => {
    initRegistry();
    const colors = ["#ff0000", "#00ff00", "#0000ff"].map(hex => makeNode("color", 0, 0, { color: { hex, alpha: 1 } }));
    const index = makeNode("index", 0, 0, { inputCount: 3 });
    const output = makeNode("output", 0, 0);
    const graph: Graph = { nodes: [...colors, index, output], variables: [], edges: [
      { from: colors[2].id, to: index.id, input: "image-3" },
      { from: colors[0].id, to: index.id, input: "image" },
      { from: colors[1].id, to: index.id, input: "image-2" },
      { from: index.id, to: output.id, input: "image" },
    ] };
    const values = compileLiveGraph(keepCompatibleEdges(graph)).screens[0].queryArc(0.5, 0.5).map(({ value }: any) => [value.i, value.color]);
    expect(values).toEqual([[0, "#ff0000"], [1, "#00ff00"], [2, "#0000ff"]]);
  });

  it("adds a number to the rendered image while keeping transparency", () => {
    initRegistry();
    const color = makeNode("color", 0, 0, { color: { hex: "#4c4c4c", alpha: 0.5 } });
    const size = makeNode("size", 0, 0, { x: 0.5 });
    const add = makeNode("expression", 0, 0, { mode: "add", b: 0.2 });
    const output = makeNode("output", 0, 0);
    const graph: Graph = { nodes: [color, size, add, output], edges: [], variables: [] };
    expect(outputType(graph, add)).toBeUndefined();
    const first = withEdge(graph, { from: add.id, to: output.id, input: "image" })!;
    const second = withEdge(first, { from: color.id, to: size.id, input: "image" })!;
    const result = withEdge(second, { from: size.id, to: add.id, input: "a" })!;
    expect(keepCompatibleEdges(result).edges).toEqual(result.edges);
    withRenderer((renderer, canvas) => {
      const frames = new FrameRenderer(renderer, createVideoPoolManager({ resolveMediaUrl: name => name }), createMetrics());
      const { screens, namedScreens } = compileLiveGraph(result);
      frames.render(screens, namedScreens, 0.25, 1, 0.25);
      const [r, g, b, a] = readPixel(canvas, 50, 50);
      expect(Math.abs(r - 64)).toBeLessThanOrEqual(2);
      expect([g, b]).toEqual([r, r]);
      expect(Math.abs(a - 128)).toBeLessThanOrEqual(2);
      expect(readPixel(canvas, 10, 50)[3]).toBe(0);
    });
  });

  it("adds colors with clamping and composites images before downstream effects", () => {
    initRegistry();
    const first = makeNode("color", 0, 0, { color: { hex: "#cc4020", alpha: 0.4 } });
    const second = makeNode("color", 0, 0, { color: { hex: "#991080", alpha: 0.7 } });
    const add = makeNode("expression", 0, 0);
    const output = makeNode("output", 0, 0);
    const result: Graph = { nodes: [first, second, add, output], variables: [], edges: [
      { from: first.id, to: add.id, input: "a" },
      { from: second.id, to: add.id, input: "b" },
      { from: add.id, to: output.id, input: "image" },
    ] };
    expect(outputType(result, add)).toBe("color");
    expect(compileLiveGraph(result).screens[0].queryArc(0.25, 0.25)[0].value)
      .toMatchObject({ color: "#ff50a0", colorAlpha: 1 });

    const red = makeNode("color", 0, 0, { color: { hex: "#990000", alpha: 1 } });
    const blue = makeNode("color", 0, 0, { color: { hex: "#000099", alpha: 1 } });
    const left = makeNode("size", 0, 0);
    const right = makeNode("size", 0, 0);
    const combined: Graph = { nodes: [red, blue, left, right, add, output], variables: [], edges: [
      { from: red.id, to: left.id, input: "image" },
      { from: blue.id, to: right.id, input: "image" },
      { from: left.id, to: add.id, input: "a" },
      { from: right.id, to: add.id, input: "b" },
      { from: add.id, to: output.id, input: "image" },
    ] };
    withRenderer((renderer, canvas) => {
      const frames = new FrameRenderer(renderer, createVideoPoolManager({ resolveMediaUrl: name => name }), createMetrics());
      const { screens, namedScreens } = compileLiveGraph(combined);
      frames.render(screens, namedScreens, 0.25, 1, 0.25);
      expect(readPixel(canvas, 50, 50)).toEqual([153, 0, 153, 255]);
    });
  });

  it("uses ramp luminance as per-pixel Float values through math and variables to drive Opacity", () => {
    initRegistry();
    const ramp = makeNode("colorRamp", 0, 0);
    const math = makeNode("expression", 0, 0, { mode: "multiply" });
    const amount = makeNode("numberPattern", 0, 0, { pattern: "0.5 0.25" });
    const set = makeNode("variable", 0, 0, { variable: "mask" });
    const get = makeNode("variable", 0, 0, { variable: "mask" });
    const color = makeNode("color", 0, 0, { color: { hex: "#ff0000", alpha: 1 } });
    const opacity = makeNode("alpha", 0, 0);
    const tempo = makeNode("tempo", 0, 0);
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [ramp, math, amount, set, get, color, opacity, tempo, output],
      variables: [{ id: "mask", name: "Mask", type: "number" }],
      edges: [
        { from: amount.id, to: math.id, input: "b" },
        { from: math.id, to: set.id, input: "value" },
        { from: color.id, to: opacity.id, input: "image" },
        { from: get.id, to: opacity.id, input: "value" },
        { from: opacity.id, to: output.id, input: "image" },
      ],
    };
    const connected = withConvertedEdge(graph, { from: ramp.id, to: math.id, input: "a" });
    expect(connected).toBeDefined();
    expect(keepCompatibleEdges(connected!)).toEqual(connected);
    expect(withConvertedEdge(connected!, { from: get.id, to: tempo.id, input: "value" })).toBeUndefined();
    withRenderer((renderer, canvas) => {
      const pool = createVideoPoolManager({ resolveMediaUrl: name => name });
      const frames = new FrameRenderer(renderer, pool, createMetrics());
      const { screens, namedScreens } = compileLiveGraph(connected!);
      frames.render(screens, namedScreens, 0.25, 1, 0.25);
      expect(Math.abs(readPixel(canvas, 10, 50)[3] - 13)).toBeLessThanOrEqual(2);
      expect(Math.abs(readPixel(canvas, 90, 50)[3] - 115)).toBeLessThanOrEqual(2);
      frames.render(screens, namedScreens, 0.75, 1, 0.75);
      expect(Math.abs(readPixel(canvas, 90, 50)[3] - 58)).toBeLessThanOrEqual(2);
    });
  });

  it("uses per-pixel Factor values for the ramp's Image and Alpha outputs", () => {
    initRegistry();
    const factor = makeNode("colorRamp", 0, 0);
    const ramp = makeNode("colorRamp", 0, 0, {
      "stop-start": { hex: "#ff0000", alpha: 0.25 }, "stop-end": { hex: "#0000ff", alpha: 1 },
    });
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [factor, ramp, output], variables: [], edges: [{ from: ramp.id, to: output.id, input: "image" }],
    };
    const colored = withConvertedEdge(graph, { from: factor.id, to: ramp.id, input: "factor" })!;
    const grayscale = withConvertedEdge(colored, { from: ramp.id, output: "alpha", to: output.id, input: "image" })!;
    withRenderer((renderer, canvas) => {
      const frames = new FrameRenderer(renderer, createVideoPoolManager({ resolveMediaUrl: name => name }), createMetrics());
      const render = (graph: Graph) => {
        const { screens, namedScreens } = compileLiveGraph(graph);
        frames.render(screens, namedScreens, 0.5, 1, 0.5);
      };
      render(colored);
      const [leftR, , leftB, leftA] = readPixel(canvas, 10, 50);
      const [rightR, , rightB, rightA] = readPixel(canvas, 90, 50);
      expect(leftR).toBeGreaterThan(leftB);
      expect(rightB).toBeGreaterThan(rightR);
      expect(rightA).toBeGreaterThan(leftA);
      render(grayscale);
      const [r, g, b, a] = readPixel(canvas, 10, 50);
      expect([g, b, a]).toEqual([r, r, 255]);
      expect(Math.abs(r - leftA)).toBeLessThanOrEqual(2);
    });
  });

  it("reads the ramp's stop alpha as a mask alongside a Matte", () => {
    initRegistry();
    const ramp = makeNode("colorRamp", 0, 0, {
      "stop-start": { hex: "#000000", alpha: 0 }, "stop-end": { hex: "#000000", alpha: 1 },
    });
    const image = makeNode("color", 0, 0, { color: { hex: "#ff0000", alpha: 1 } });
    const mask = makeNode("color", 0, 0, { color: { hex: "#ffffff", alpha: 0.5 } });
    const matte = makeNode("matte", 0, 0);
    const opacity = makeNode("alpha", 0, 0);
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [ramp, image, mask, matte, opacity, output], variables: [], edges: [
        { from: image.id, to: matte.id, input: "image" },
        { from: mask.id, to: matte.id, input: "texture" },
        { from: matte.id, to: opacity.id, input: "image" },
        { from: ramp.id, output: "mask", to: opacity.id, input: "value" },
        { from: opacity.id, to: output.id, input: "image" },
      ],
    };
    withRenderer((renderer, canvas) => {
      const frames = new FrameRenderer(renderer, createVideoPoolManager({ resolveMediaUrl: name => name }), createMetrics());
      const { screens, namedScreens } = compileLiveGraph(graph);
      frames.render(screens, namedScreens, 0.5, 1, 0.5);
      expect(Math.abs(readPixel(canvas, 10, 50)[3] - 13)).toBeLessThanOrEqual(2);
      expect(Math.abs(readPixel(canvas, 90, 50)[3] - 115)).toBeLessThanOrEqual(2);
    });
  });

  it("converts a String to an image and parses a wired number from a String", () => {
    initRegistry();
    const title = makeNode("constant", 0, 0, { mode: "text", value: "Hello world" });
    const number = makeNode("constant", 0, 0, { mode: "text", value: " 64.5 " });
    const tempo = makeNode("tempo", 0, 0);
    const output = makeNode("output", 0, 0);
    let graph: Graph = { nodes: [title, number, tempo, output], variables: [], edges: [] };
    graph = withConvertedEdge(graph, { from: title.id, to: output.id, input: "image" })!;
    graph = withConvertedEdge(graph, { from: number.id, to: tempo.id, input: "value" })!;
    const compiled = compileLiveGraph(graph);
    expect(compiled.screens[0].queryArc(0, 0)[0].value).toMatchObject({ _type: "text", text: "Hello world" });
    expect(compiled.tempo).toBe(64.5);
  });

  it("keeps automatic conversions while either end is connected", () => {
    initRegistry();
    const graph = starterGraph();
    const signal = makeNode("numberPattern", 0, 0, { pattern: "0 -2.5" });
    const set = makeNode("variable", 0, 0, { variable: "flag" });
    const tempo = makeNode("tempo", 0, 0, { value: 48 });
    const text = makeNode("text", 0, 0);
    graph.nodes.push(signal, set, tempo, text);
    graph.variables.push({ id: "flag", name: "Flag", type: "boolean" });
    const first = { from: signal.id, to: set.id, input: "value" };
    let connected = withConvertedEdge(graph, first, () => ({ x: 240, y: 120 }))!;
    expect(withConvertedEdge(connected, first)).toBe(connected);
    connected = withConvertedEdge(connected, { from: set.id, to: tempo.id, input: "value" })!;
    connected = withConvertedEdge(connected, { from: signal.id, to: text.id, input: "content" })!;
    const converters = connected.nodes.filter(isAutomaticConversion);
    expect(converters.map(node => node.data.mode)).toEqual(["floatToBoolean", "booleanToFloat", "floatToString"]);
    expect(converters[0]).toMatchObject({ x: 240, y: 120 });
    expect(keepCompatibleEdges(connected)).toEqual(connected);
    expect(withConvertedEdge(connected, { from: text.id, to: tempo.id, input: "value" })).toBeUndefined();
    const compiled = compileLiveGraph(connected);
    if (typeof compiled.tempo === "number") throw new Error("Expected a Float signal");
    expect([0.25, 0.75].map(cycle => compiled.tempo.queryArc(cycle, cycle)[0].value)).toEqual([0, 1]);
    const cut = pruneRoutingNodes({ ...connected, edges: connected.edges.filter(edge => edge.to !== converters[1].id) });
    expect(cut.nodes).toContain(converters[1]);
    expect(inputType(cut, converters[1], "boolean")).toBeUndefined();
    expect(keepCompatibleEdges(cut)).toEqual(cut);
    expect(compileLiveGraph(cut).tempo).toBe(48);
    const detached = pruneRoutingNodes({ ...cut, edges: cut.edges.filter(edge => edge.from !== converters[1].id) });
    expect(detached.nodes).not.toContain(converters[1]);
  });

  it("reassigns a conversion output after its last outgoing cable is disconnected", () => {
    const graph = starterGraph();
    const number = makeNode("constant", 0, 0);
    const text = makeNode("text", 0, 0);
    const first = makeNode("variable", 0, 0, { variable: "first" });
    const second = makeNode("variable", 0, 0, { variable: "second" });
    graph.nodes.push(number, text, first, second);
    graph.variables.push({ id: "first", name: "First", type: "boolean" }, { id: "second", name: "Second", type: "boolean" });
    const connected = withConvertedEdge(graph, { from: number.id, to: first.id, input: "value" })!;
    const converter = connected.nodes.find(isAutomaticConversion)!;
    const branched = withEdge(connected, { from: converter.id, to: second.id, input: "value" })!;
    const cut = (current: Graph, target: string) => pruneRoutingNodes({
      ...current, edges: current.edges.filter(edge => edge.from !== converter.id || edge.to !== target),
    });
    const single = cut(branched, first.id);
    expect(outputType(single, converter)).toBe("boolean");
    expect(withEdge(single, { from: converter.id, to: text.id, input: "content" })).toBeUndefined();
    const loose = cut(single, second.id);
    expect(loose.nodes).toContain(converter);
    expect(inputsFor(loose, converter)[0].type).toBe("number");
    expect(outputType(loose, converter)).toBeUndefined();
    expect(keepCompatibleEdges(loose)).toEqual(loose);
    const reassigned = withEdge(loose, { from: converter.id, to: text.id, input: "content" })!;
    const updated = reassigned.nodes.find(node => node.id === converter.id)!;
    expect(updated.data.mode).toBe("floatToString");
    expect(outputType(reassigned, updated)).toBe("text");
    expect(reassigned.nodes).toHaveLength(loose.nodes.length);
    expect(keepCompatibleEdges(reassigned)).toEqual(reassigned);
  });

  it("infers the input of a new conversion and retains a selected mode for its matching target", () => {
    const graph = starterGraph();
    const pending = makeNode("convert", 0, 0);
    const alpha = makeNode("convert", 0, 0, { mode: "imageAlphaToFloat" });
    const source = makeNode("constant", 0, 0, { mode: "text" });
    const opacity = makeNode("alpha", 0, 0);
    graph.nodes.push(pending, alpha, source, opacity);
    expect(inputType(graph, pending, "float")).toBeUndefined();
    expect(outputType(graph, pending)).toBeUndefined();
    expect(outputType(graph, alpha)).toBeUndefined();
    const wired = withEdge(graph, { from: source.id, to: pending.id, input: "float" })!;
    const updated = wired.nodes.find(node => node.id === pending.id)!;
    expect(inputsFor(wired, updated)[0].type).toBe("text");
    expect(wired.edges.at(-1)?.input).toBe("text");
    expect(outputType(wired, updated)).toBeUndefined();
    const chosen = withEdge(wired, { from: alpha.id, to: opacity.id, input: "value" })!;
    expect(chosen.nodes.find(node => node.id === alpha.id)?.data.mode).toBe("imageAlphaToFloat");
  });

  it("binds or reassigns a neutral input while keeping the wired output", () => {
    initRegistry();
    const graph = starterGraph();
    const [image] = graph.nodes;
    const pending = makeNode("convert", 0, 0);
    const source = makeNode("constant", 0, 0, { mode: "text", value: "64" });
    const boolean = makeNode("constant", 0, 0, { mode: "boolean", value: true });
    const tempo = makeNode("tempo", 0, 0, { value: 48 });
    graph.nodes.push(pending, source, boolean, tempo);
    const outgoing = { from: pending.id, to: tempo.id, input: "value" };
    const outputFirst = withEdge(graph, outgoing)!;
    const provisional = outputFirst.nodes.find(node => node.id === pending.id)!;
    const input = inputsFor(outputFirst, provisional)[0].id;
    expect(inputType(outputFirst, provisional, input)).toBeUndefined();
    expect(outputType(outputFirst, provisional)).toBe("number");
    expect(compileLiveGraph(outputFirst).tempo).toBe(48);
    expect(withConvertedEdge(outputFirst, { from: image.id, to: pending.id, input })).toBeUndefined();
    const wired = withConvertedEdge(outputFirst, { from: source.id, to: pending.id, input })!;
    const updated = wired.nodes.find(node => node.id === pending.id)!;
    expect(inputType(wired, updated, "text")).toBe("text");
    expect(outputType(wired, updated)).toBe("number");
    expect(wired.nodes).toHaveLength(graph.nodes.length);
    expect(keepCompatibleEdges(wired)).toEqual(wired);
    expect(compileLiveGraph(wired).tempo).toBe(64);
    const detached = { ...wired, edges: wired.edges.filter(edge => edge.to !== pending.id) };
    const reassigned = withEdge(detached, { from: boolean.id, to: pending.id, input: "text" })!;
    const converted = reassigned.nodes.find(node => node.id === pending.id)!;
    expect(inputType(reassigned, converted, "boolean")).toBe("boolean");
    expect(reassigned.edges).toContain(outgoing);
  });

  it("routes a named output through junctions and uses the input fallback when the source is loose", () => {
    initRegistry();
    const graph = starterGraph();
    const ramp = makeNode("colorRamp", 0, 0, { "stop-start": { hex: "#ffffff", alpha: 0.5 }, factor: 0 });
    const first = makeNode("junction", 0, 0, { type: "number" });
    const second = makeNode("junction", 0, 0, { type: "number" });
    const tempo = makeNode("tempo", 0, 0, { value: 45 });
    graph.nodes.push(ramp, first, second, tempo);
    const source = { from: ramp.id, output: "alpha", to: first.id, input: cableInput };
    graph.edges.push(source, { from: first.id, to: second.id, input: cableInput }, { from: second.id, to: tempo.id, input: "value" });
    expect(keepCompatibleEdges(graph).edges).toEqual(graph.edges);
    expect(withEdge(graph, { from: second.id, to: first.id, input: cableInput })).toBeUndefined();
    const signal = compileLiveGraph(graph).tempo;
    expect(typeof signal === "number" ? signal : signal.queryArc(0, 1)[0].value).toBe(0.5);

    const loose = makeNode("cableEnd", 0, 0, { type: "number", side: "source" });
    const disconnected = { ...graph, nodes: [...graph.nodes, loose], edges: graph.edges.map(edge => edge === source
      ? { from: loose.id, to: first.id, input: cableInput } : edge) };
    expect(keepCompatibleEdges(disconnected).edges).toEqual(disconnected.edges);
    expect(compileLiveGraph(disconnected).tempo).toBe(45);
  });

  it("validates variable setters when a junction receives a signal", () => {
    const graph = starterGraph();
    const variable = { id: "amount", name: "Amount", type: "number" } as const;
    const first = makeNode("variable", 0, 0, { variable: variable.id });
    const second = makeNode("variable", 0, 0, { variable: variable.id });
    const junction = makeNode("junction", 0, 0, { type: variable.type });
    const number = makeNode("constant", 0, 0, { mode: "number" });
    graph.nodes.push(first, second, junction, number);
    graph.variables.push(variable);
    graph.edges.push({ from: junction.id, to: first.id, input: "value" }, { from: number.id, to: second.id, input: "value" });
    expect(isVariableSetter(graph, first)).toBe(false);
    expect(isVariableSetter(graph, second)).toBe(true);
    expect(keepCompatibleEdges(graph).edges).toEqual(graph.edges);
    expect(withEdge(graph, { from: number.id, to: junction.id, input: cableInput })).toBeUndefined();
  });

  it.each([
    ["blend", "blend", "screen", "add"],
    ["fit", "objectfit", "contain", "tilecenter"],
  ] as const)("uses stored and connected String modes for %s", (kind, property, stored, wired) => {
    initRegistry();
    const image = makeNode("testCard", 0, 0);
    const effect = makeNode(kind, 0, 0, { mode: stored });
    const string = makeNode("constant", 0, 0, { mode: "text", value: wired });
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [image, effect, string, output],
      edges: [{ from: image.id, to: effect.id, input: "image" }, { from: effect.id, to: output.id, input: "image" }],
      variables: [],
    };
    const sample = (graph: Graph) => compileLiveGraph(graph).screens[0].queryArc(0.5, 0.5)[0].value[property];
    expect(sample(graph)).toBe(stored);
    const connected = withEdge(graph, { from: string.id, to: effect.id, input: "mode" });
    expect(connected).toBeDefined();
    expect(sample(connected!)).toBe(wired);
  });

  it("blends the overlay into one image without affecting other output layers", () => {
    initRegistry();
    const background = makeNode("color", 0, 0, { color: { hex: "#0000ff", alpha: 1 } });
    const backgroundOutput = makeNode("output", 0, 0);
    const base = makeNode("color", 0, 0, { color: { hex: "#ff0000", alpha: 1 } });
    const overlay = makeNode("color", 0, 0, { color: { hex: "#ffffff", alpha: 1 } });
    const size = makeNode("size", 0, 0, { x: 0.5 });
    const blend = makeNode("blend", 0, 0);
    const mode = makeNode("constant", 0, 0, { mode: "text", value: "destination-out" });
    const opacity = makeNode("alpha", 0, 0, { value: 0.5 });
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [background, backgroundOutput, base, overlay, size, blend, mode, opacity, output],
      edges: [
        { from: background.id, to: backgroundOutput.id, input: "image" },
        { from: base.id, to: blend.id, input: "image" },
        { from: overlay.id, to: size.id, input: "image" },
        { from: blend.id, to: opacity.id, input: "image" },
        { from: opacity.id, to: output.id, input: "image" },
      ],
      variables: [],
    };
    const layered = withEdge(graph, { from: size.id, to: blend.id, input: "second" });
    expect(layered).toBeDefined();
    const masked = withEdge(layered!, { from: mode.id, to: blend.id, input: "mode" });
    expect(masked).toBeDefined();
    withRenderer((renderer, canvas) => {
      const pool = createVideoPoolManager({ resolveMediaUrl: name => name });
      const frames = new FrameRenderer(renderer, pool, createMetrics());
      const render = (graph: Graph) => {
        const { screens, namedScreens } = compileLiveGraph(graph);
        frames.render(screens, namedScreens, 0.5, 1, 0.5);
      };
      render(layered!);
      const [overlayR, overlayG, overlayB, overlayA] = readPixel(canvas, 50, 50);
      expect([overlayB, overlayA]).toEqual([255, 255]);
      expect(overlayR).toBe(overlayG);
      expect([127, 128]).toContain(overlayR);
      render(masked!);
      expect(readPixel(canvas, 50, 50)).toEqual([0, 0, 255, 255]);
      const [r, g, b, a] = readPixel(canvas, 10, 50);
      expect([g, a]).toEqual([0, 255]);
      expect([127, 128]).toContain(r);
      expect([127, 128]).toContain(b);
    });
  });

  it("routes RGBA values through Color variables into text and image inputs", () => {
    initRegistry();
    const color = makeNode("color", 0, 0, { color: { hex: "#cc4422", alpha: 0.4 } });
    const setter = makeNode("variable", 0, 0, { variable: "ink" });
    const getter = makeNode("variable", 0, 0, { variable: "ink" });
    const text = makeNode("text", 0, 0);
    const style = makeNode("textStyle", 0, 0);
    const textOutput = makeNode("output", 0, 0);
    const colorOutput = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [color, setter, getter, text, style, textOutput, colorOutput],
      variables: [{ id: "ink", name: "Ink", type: "color" }],
      edges: [
        { from: color.id, to: setter.id, input: "value" },
        { from: getter.id, to: style.id, input: "color" },
        { from: getter.id, to: colorOutput.id, input: "image" },
        { from: text.id, to: style.id, input: "image" },
        { from: style.id, to: textOutput.id, input: "image" },
      ],
    };
    expect(keepCompatibleEdges(graph).edges).toEqual(graph.edges);
    const compiled = compileLiveGraph(graph);
    expect(compiled.screens[0].queryArc(0.5, 0.5)[0].value).toMatchObject({ fontColor: "rgba(204, 68, 34, 0.4)" });
    expect(compiled.screens[1].queryArc(0.5, 0.5)[0].value).toMatchObject({ color: "#cc4422", colorAlpha: 0.4 });
    const previous = localStorage.getItem("nodesdevil-session-v1");
    try {
      const session = { draft: graph, live: graph, view: { x: 0, y: 0, zoom: 1, previews: [] }, media: [] };
      saveNodes(session);
      expect(loadNodes()).toEqual(session);
    } finally {
      if (previous === null) localStorage.removeItem("nodesdevil-session-v1");
      else localStorage.setItem("nodesdevil-session-v1", previous);
    }
  });

  it("restores a legacy String variable with an inline value and a cable to Text Style", () => {
    initRegistry();
    const set = makeNode("variable", 0, 0, { variable: "ink" });
    const get = makeNode("variable", 0, 0, { variable: "ink" });
    const text = makeNode("text", 0, 0);
    const style = makeNode("textStyle", 0, 0);
    const output = makeNode("output", 0, 0);
    const legacyCable = { from: get.id, to: style.id, input: "color" };
    const graph: Graph = {
      nodes: [set, get, text, style, output],
      variables: [{ id: "ink", name: "Ink", type: "text" }],
      edges: [{ from: text.id, to: style.id, input: "image" }, { from: style.id, to: output.id, input: "image" }, legacyCable],
    };
    expect(withEdge(graph, legacyCable)).toBeUndefined();
    const key = "nodesdevil-session-v1";
    const previous = localStorage.getItem(key);
    try {
      const draft = {
        ...graph, nodes: [{ ...set, kind: "set", data: { ...set.data, value: "red" } }, { ...get, kind: "get" }, text, style, output],
      };
      localStorage.setItem(key, JSON.stringify({ draft, view: { x: 0, y: 0, zoom: 1, previews: [] }, media: [] }));
      const restored = loadNodes()!.draft;
      expect(restored.nodes.slice(0, 2)).toEqual([set, get]);
      const source = restored.edges.find(edge => edge.to === set.id && edge.input === "value")?.from;
      expect(restored.nodes.find(node => node.id === source)).toMatchObject({ kind: "constant", data: { mode: "text", value: "red" } });
      expect(restored.edges).toContainEqual({ ...legacyCable, legacyColorInput: true });
      expect(compileLiveGraph(restored).screens[0].queryArc(0.5, 0.5)[0].value).toMatchObject({ fontColor: "red" });
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });

  it("renders RGB stops as an image and samples their alpha at Factor", () => {
    initRegistry();
    const gradient: Gradient = { ...defaultGradient, stops: [
      { position: 0, color: "#ff0000", alpha: 0.25 },
      { position: 1, color: "#0000ff", alpha: 0.75 },
    ] };
    const color = makeNode("color", 0, 0, { color: { hex: "#0000ff", alpha: 0.75 } });
    const factor = makeNode("numberPattern", 0, 0, { pattern: "0 0.5 1" });
    const ramp = makeNode("colorRamp", 0, 0, { "stop-start": { hex: "#ff0000", alpha: 0.25 } });
    const alpha = makeNode("alpha", 0, 0);
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [color, factor, ramp, alpha, output],
      variables: [],
      edges: [
        { from: color.id, to: ramp.id, input: "stop-end" },
        { from: factor.id, to: ramp.id, input: "factor" },
        { from: ramp.id, to: alpha.id, input: "image" },
        { from: ramp.id, output: "alpha", to: alpha.id, input: "value" },
        { from: alpha.id, to: output.id, input: "image" },
      ],
    };
    expect(keepCompatibleEdges(graph).edges).toEqual(graph.edges);
    expect(inputsFor(graph, ramp).map(({ id, type }) => [id, type])).toEqual([
      ["stop-start", "color"], ["stop-end", "color"], ["factor", "number"], ["image", "visual"],
    ]);
    expect(outputsFor(graph, ramp).map(({ label, type }) => [label, type])).toEqual([["Image", "visual"], ["Alpha", "number"], ["Mask", "number"]]);
    expect(valueTypes).not.toContain("gradient");
    expect(withEdge(graph, { from: ramp.id, output: "alpha", to: output.id, input: "image" })).toBeUndefined();
    expect(withEdge(graph, { from: factor.id, to: ramp.id, input: "stop-end" })).toBeUndefined();
    const compiled = compileLiveGraph(graph);
    expect(compiled.screens[0].queryArc(0.5, 0.5)[0].value).toMatchObject({ _type: "gradient", gradient, alpha: 0.5 });
    expect(compiled.screens[0].queryArc(0.1, 0.1)[0].value.alpha).toBe(0.25);
    expect(compiled.screens[0].queryArc(0.9, 0.9)[0].value.alpha).toBe(0.75);
    withRenderer((renderer, canvas) => {
      const pool = createVideoPoolManager({ resolveMediaUrl: name => name });
      const frames = new FrameRenderer(renderer, pool, createMetrics());
      frames.render(compiled.screens, compiled.namedScreens, 0.5, 1, 0.5);
      const left = readPixel(canvas, 5, 50);
      const right = readPixel(canvas, 95, 50);
      expect(left[0]).toBeGreaterThan(left[2]);
      expect(right[2]).toBeGreaterThan(right[0]);
      expect(left[3]).toBeLessThan(right[3]);
    });

    color.data = { pattern: "red blue" };
    const animated = compileLiveGraph(graph).screens[0];
    expect(animated.queryArc(0.1, 0.1)[0].value.gradient.stops[1].color).toBe("#ff0000");
    expect(animated.queryArc(0.9, 0.9)[0].value.gradient.stops[1].color).toBe("#0000ff");
    expect(animated.queryArc(0.5, 0.5)[0].value.alpha).toBe(0.625);
  });

  it("maps the brightness of an image to the ramp and multiplies both alpha channels", () => {
    initRegistry();
    const source = makeNode("colorRamp", 0, 0, {
      "stop-start": { hex: "#000000", alpha: 0.5 },
      "stop-end": { hex: "#ffffff", alpha: 0.5 },
    });
    const ramp = makeNode("colorRamp", 0, 0, {
      "stop-start": { hex: "#ff0000", alpha: 0.25 },
      "stop-end": { hex: "#0000ff", alpha: 0.75 },
      factor: 0,
    });
    const output = makeNode("output", 0, 0);
    const graph: Graph = { nodes: [source, ramp, output], variables: [], edges: [
      { from: source.id, to: ramp.id, input: "image" },
      { from: ramp.id, to: output.id, input: "image" },
    ] };
    expect(keepCompatibleEdges(graph).edges).toEqual(graph.edges);
    const compiled = compileLiveGraph(graph);
    withRenderer((renderer, canvas) => {
      const pool = createVideoPoolManager({ resolveMediaUrl: name => name });
      const frames = new FrameRenderer(renderer, pool, createMetrics());
      frames.render(compiled.screens, compiled.namedScreens, 0.5, 1, 0.5);
      const [darkR, darkG, darkB, darkA] = readPixel(canvas, 5, 50);
      const [lightR, lightG, lightB, lightA] = readPixel(canvas, 95, 50);
      expect(darkR).toBeGreaterThan(5 * darkB);
      expect(lightB).toBeGreaterThan(5 * lightR);
      expect(darkG + lightG).toBe(0);
      expect(darkA).toBeGreaterThan(30);
      expect(darkA).toBeLessThan(40);
      expect(lightA).toBeGreaterThan(85);
      expect(lightA).toBeLessThan(100);
    });
  });

  it("restores saved Gradient inputs and variables as RGB ramps and images", () => {
    initRegistry();
    const gradient = { space: "HSV", hue: "Far", interpolation: "Constant", stops: [
      { position: 0, color: "#ff0000", alpha: 0.25 },
      { position: 1, color: "#0000ff", alpha: 0.75 },
    ] };
    const graph = {
      nodes: [
        { id: "set", kind: "set", x: 340, y: 0, data: { variable: "palette", value: gradient } },
        { id: "get", kind: "get", x: 340, y: 200, data: { variable: "palette" } },
        { id: "image", kind: "gradientImage", x: 600, y: 0, data: {} },
        { id: "out", kind: "output", x: 900, y: 0, data: {} },
      ],
      variables: [{ id: "palette", name: "Palette", type: "gradient" }],
      edges: [{ from: "get", to: "image", input: "gradient" }, { from: "image", to: "out", input: "image" }],
    };
    const key = "nodesdevil-session-v1";
    const previous = localStorage.getItem(key);
    try {
      localStorage.setItem(key, JSON.stringify({ draft: graph, live: graph, view: { x: 0, y: 0, zoom: 1, previews: ["image"] }, media: [] }));
      const restored = loadNodes()!;
      expect(restored.view.previews).toEqual(["image"]);
      expect(restored.draft.variables[0].type).toBe("visual");
      expect(restored.draft.nodes.find(node => node.id === "image")).toMatchObject({
        kind: "colorRamp", data: { interpolation: "Linear", "stop-0": { hex: "#ff0000", alpha: 0.25 } },
      });
      expect(compileLiveGraph(restored.live!).screens[0].queryArc(0, 0)[0].value).toMatchObject({
        _type: "gradient", gradient: { interpolation: "Linear", stops: gradient.stops },
      });
      expect(restored.draft.edges.find(edge => edge.to === "set")?.from).toBeDefined();
      saveNodes(restored);
      expect(loadNodes()).toEqual(restored);
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });

  it("supports constant steps and linear RGB interpolation", () => {
    const stops = [
      { position: 0, color: "#ff0000", alpha: 0 },
      { position: 0.5, color: "#00ff00", alpha: 0.5 },
      { position: 1, color: "#0000ff", alpha: 1 },
    ];
    const stepped = gradientSampler({ ...defaultGradient, stops, interpolation: "Constant" });
    expect(rgbHex(stepped(0.499))).toBe("#ff0000");
    expect(rgbHex(stepped(0.5))).toBe("#00ff00");
    expect(stepped(2)[3]).toBe(1);
    expect(gradientSampler({ ...defaultGradient, stops })(0.125)[3]).toBe(0.125);
    expect(rgbHex(gradientSampler({ ...defaultGradient, stops })(0.25))).toBe("#808000");
  });

  it("converts white or black to transparency and blends gray over a background", () => {
    initRegistry();
    const background = makeNode("color", 0, 0, { pattern: "red" });
    const tones = makeNode("color", 0, 0, { pattern: "white #808080 black" });
    const key = makeNode("alpha", 0, 0, { mode: "white" });
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

  it("restores standalone Luma to Alpha nodes as Opacity modes with the same cables", () => {
    const graph = starterGraph();
    const [source, output] = graph.nodes;
    const legacy = { id: "luma", kind: "lumaToAlpha", x: 200, y: 96, data: { mode: "black" } };
    const edges = [{ from: source.id, to: legacy.id, input: "image" }, { from: legacy.id, to: output.id, input: "image" }];
    const draft = { ...graph, nodes: [source, legacy, output], edges };
    const live = { ...draft, nodes: [source, { ...legacy, data: {} }, output] };
    const key = "nodesdevil-session-v1";
    const previous = localStorage.getItem(key);
    try {
      localStorage.setItem(key, JSON.stringify({ draft, live, view: { x: 0, y: 0, zoom: 1, previews: [legacy.id] }, media: [] }));
      const restored = loadNodes()!;
      expect(restored.draft.nodes[1]).toEqual({ ...legacy, kind: "alpha" });
      expect(restored.live?.nodes[1]).toEqual({ ...legacy, kind: "alpha", data: { mode: "white" } });
      expect(restored.draft.edges).toEqual(edges);
      expect(restored.live?.edges).toEqual(edges);
      expect(restored.view.previews).toEqual([legacy.id]);
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
    expect(referenceNode("lumaToAlpha", [])).toEqual({ kind: "alpha", data: { mode: "white" } });
    expect(referenceNode("alpha", [])).toEqual({ kind: "alpha" });
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

  it("detects feedback and allows only one wired setter per variable", () => {
    const get = makeNode("variable", 0, 0, { variable: "amount" });
    const set = makeNode("variable", 0, 0, { variable: "amount" });
    const signal = makeNode("waveform", 0, 0);
    const range = makeNode("range", 0, 0);
    const graph: Graph = {
      nodes: [get, set, signal, range], edges: [{ from: get.id, to: range.id, input: "signal" }],
      variables: [{ id: "amount", name: "Amount", type: "number" }],
    };
    expect(withEdge(graph, { from: get.id, to: set.id, input: "value" })).toBeUndefined();
    expect(withEdge(graph, { from: range.id, to: set.id, input: "value" })).toBeUndefined();
    const wired = withEdge(graph, { from: signal.id, to: set.id, input: "value" })!;
    expect(isVariableSetter(graph, set)).toBe(false);
    expect(isVariableSetter(wired, set)).toBe(true);
    expect(withEdge(wired, { from: signal.id, to: get.id, input: "value" })).toBeUndefined();
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
    const amount = makeNode("constant", 0, 0, { value: 0.3 });
    const set = makeNode("variable", 0, 0, { variable: "amount" });
    const get = makeNode("variable", 0, 0, { variable: "amount" });
    const opacity = makeNode("alpha", 0, 0);
    const [card, output] = graph.nodes;
    graph.nodes.push(amount, set, get, opacity);
    graph.variables.push({ id: "amount", name: "Amount", type: "number" });
    graph.edges = [
      { from: card.id, to: opacity.id, input: "image" },
      { from: get.id, to: opacity.id, input: "value" },
      { from: opacity.id, to: output.id, input: "image" },
      { from: amount.id, to: set.id, input: "value" },
    ];
    const previous = snapshotRegistry();
    const compiled = compileLiveGraph(graph);
    expect(compiled.screens[0].queryArc(0, 0)[0].value.alpha).toBeCloseTo(0.3);
    expect(() => compileLiveGraph({ ...graph, edges: graph.edges.filter(edge => edge.to !== set.id) }))
      .toThrow(/Connect an input to a Variable node/);
    expect(snapshotRegistry()).toEqual(previous);
    expect(() => compileLiveGraph({ ...graph, edges: [] })).toThrow(/connection/);
    expect(snapshotRegistry()).toEqual(previous);
  });

  it.each([
    ["add", 7, 2, 9], ["subtract", 7, 2, 5], ["multiply", 7, 2, 14], ["divide", 7, 2, 3.5],
    ["remainder", 7, 2, 1], ["min", 7, 2, 2], ["max", 7, 2, 7], ["divide", 7, 0, 0], ["remainder", 7, 0, 0],
  ] as const)("evaluates the %s expression with %s and %s as a fixed Float", (mode, a, b, result) => {
    initRegistry();
    const graph = starterGraph();
    const expression = makeNode("expression", 0, 0, { mode, a, b });
    const tempo = makeNode("tempo", 0, 0);
    graph.nodes.push(expression, tempo);
    expect(compileLiveGraph(withEdge(graph, { from: expression.id, to: tempo.id, input: "value" })!).tempo).toBe(result);
  });

  it("combines Float signals and converts them through Boolean and String variables", () => {
    initRegistry();
    const left = makeNode("numberPattern", 0, 0, { pattern: "-2 0 3 -4" });
    const right = makeNode("numberPattern", 0, 0, { pattern: "2 3" });
    const multiply = makeNode("expression", 0, 0, { mode: "multiply" });
    const toBoolean = makeNode("convert", 0, 0, { mode: "floatToBoolean" });
    const boolSet = makeNode("variable", 0, 0, { variable: "enabled" });
    const boolGet = makeNode("variable", 0, 0, { variable: "enabled" });
    const toFloat = makeNode("convert", 0, 0, { mode: "booleanToFloat" });
    const binaryText = makeNode("convert", 0, 0, { mode: "floatToString" });
    const productText = makeNode("convert", 0, 0, { mode: "floatToString" });
    const textSet = makeNode("variable", 0, 0, { variable: "label" });
    const textGet = makeNode("variable", 0, 0, { variable: "label" });
    const binaryLayer = makeNode("text", 0, 0);
    const productLayer = makeNode("text", 0, 0);
    const binaryOutput = makeNode("output", 0, 0);
    const productOutput = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [left, right, multiply, toBoolean, boolSet, boolGet, toFloat, binaryText, productText, textSet, textGet,
        binaryLayer, productLayer, binaryOutput, productOutput],
      variables: [{ id: "enabled", name: "Enabled", type: "boolean" }, { id: "label", name: "Label", type: "text" }],
      edges: [
        { from: left.id, to: multiply.id, input: "a" },
        { from: right.id, to: multiply.id, input: "b" },
        { from: multiply.id, to: toBoolean.id, input: "float" },
        { from: toBoolean.id, to: boolSet.id, input: "value" },
        { from: boolGet.id, to: toFloat.id, input: "boolean" },
        { from: toFloat.id, to: binaryText.id, input: "float" },
        { from: binaryText.id, to: textSet.id, input: "value" },
        { from: textGet.id, to: binaryLayer.id, input: "content" },
        { from: binaryLayer.id, to: binaryOutput.id, input: "image" },
        { from: multiply.id, to: productText.id, input: "float" },
        { from: productText.id, to: productLayer.id, input: "content" },
        { from: productLayer.id, to: productOutput.id, input: "image" },
      ],
    };
    expect(keepCompatibleEdges(graph).edges).toEqual(graph.edges);
    expect(withEdge(graph, { from: toBoolean.id, to: binaryLayer.id, input: "content" })).toBeUndefined();
    expect(withEdge(graph, { from: multiply.id, to: boolSet.id, input: "value" })).toBeUndefined();
    const { screens } = compileLiveGraph(graph);
    const sample = (index: number) => [0.125, 0.375, 0.625, 0.875]
      .map(cycle => screens[index].queryArc(cycle, cycle)[0].value.text);
    expect(sample(0)).toEqual(["1", "0", "1", "1"]);
    expect(sample(1)).toEqual(["-4", "0", "9", "-12"]);
  });

  it.each([["numberPattern", "pattern"], ["choose", "choices"]] as const)("feeds converted String signals to %s", (kind, input) => {
    initRegistry();
    const graph = starterGraph();
    const signal = makeNode("numberPattern", 0, 0, { pattern: "-2.5 3" });
    const toString = makeNode("convert", 0, 0, { mode: "floatToString" });
    const numbers = makeNode(kind, 0, 0);
    const tempo = makeNode("tempo", 0, 0);
    graph.nodes.push(signal, toString, numbers, tempo);
    graph.edges.push(
      { from: signal.id, to: toString.id, input: "float" },
      { from: toString.id, to: numbers.id, input },
      { from: numbers.id, to: tempo.id, input: "value" },
    );
    const compiled = compileLiveGraph(graph);
    expect(typeof compiled.tempo).not.toBe("number");
    if (typeof compiled.tempo === "number") return;
    expect(compiled.tempo.queryArc(0.25, 0.25)[0].value).toBe(-2.5);
    expect(compiled.tempo.queryArc(0.75, 0.75)[0].value).toBe(3);
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
    expect(referenceNode("slow", [])).toBeUndefined();
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
    const italic = makeNode("fontItalic", 0, 0, { ital: 0.25 });
    const toggle = makeNode("constant", 0, 0, { mode: "boolean", value: false });
    const setter = makeNode("variable", 0, 0, { variable: "toggle" });
    const output = makeNode("output", 0, 0);
    let graph: Graph = {
      nodes: [source, italic, toggle, setter, output], variables: [{ id: "toggle", name: "Italic", type: "boolean" }],
      edges: [
        { from: source.id, to: italic.id, input: "image" }, { from: italic.id, to: output.id, input: "image" },
        { from: toggle.id, to: setter.id, input: "value" },
      ],
    };
    const sample = (item: Graph) => compileLiveGraph(item).screens[0].queryArc(0, 0)[0].value._fontVariation_ital;
    expect(inputsFor(graph, italic).find(socket => socket.id === "enabled")?.type).toBe("boolean");
    expect(sample(graph)).toBe(1);
    graph = withEdge(graph, { from: setter.id, to: italic.id, input: "enabled" })!;
    expect(sample(graph)).toBe(0);
    const blend = { ...italic, data: { ...italic.data, mode: "blend" } };
    const blendedGraph = keepCompatibleEdges({ ...graph, nodes: graph.nodes.map(node => node === italic ? blend : node) });
    expect(blendedGraph.edges).toEqual(graph.edges);
    expect(sample(blendedGraph)).toBe(0.25);
  });

  it("applies grouped font variations to the same text and preserves unset axes", () => {
    initRegistry();
    const source = makeNode("text", 0, 0, { content: "Hello" });
    const spacing = makeNode("fontCustomAxis", 0, 0, { tag: "SPAC", value: 35 });
    const bounce = makeNode("numberPattern", 0, 0, { pattern: "<0 60>" });
    const handwriting = makeNode("fontHandwriting", 0, 0, { INFM: 45 });
    const shape = makeNode("fontShape", 0, 0, { wght: 700, wdth: 90, opsz: 24 });
    const height = makeNode("numberPattern", 0, 0, { pattern: "<1.25 0.8>" });
    const output = makeNode("output", 0, 0);
    const graph: Graph = {
      nodes: [source, spacing, bounce, handwriting, shape, height, output], variables: [], edges: [
        { from: source.id, to: spacing.id, input: "image" },
        { from: spacing.id, to: handwriting.id, input: "image" },
        { from: bounce.id, to: handwriting.id, input: "BNCE" },
        { from: handwriting.id, to: shape.id, input: "image" },
        { from: height.id, to: shape.id, input: "scaleY" },
        { from: shape.id, to: output.id, input: "image" },
      ],
    };
    const [pattern] = compileLiveGraph(graph).screens;
    expect(pattern.queryArc(0, 0)[0].value).toMatchObject({
      text: "Hello", _fontVariation_bnce: 0, _fontVariation_infm: 45, _fontVariation_spac: 35,
      _fontVariation_wght: 700, _fontVariation_wdth: 90, _fontVariation_opsz: 24, scaleY: 1.25,
    });
    expect(pattern.queryArc(1, 1)[0].value).toMatchObject({ _fontVariation_bnce: 60, _fontVariation_wght: 700, scaleY: 0.8 });
    expect(referenceNode("fontAxis", [])).toEqual({ kind: "fontCustomAxis" });
  });

  it("bounds normalized font blends for literals and signals with the original signal timing", () => {
    initRegistry();
    const source = makeNode("text", 0, 0);
    const letterforms = makeNode("fontLetterforms", 0, 0, { CASL: 2 });
    const signal = makeNode("numberPattern", 0, 0, { pattern: "-0.4 0.35 1.5" });
    const random = makeNode("rand", 0, 0);
    const output = makeNode("output", 0, 0);
    const graph: Graph = { nodes: [source, letterforms, signal, random, output], variables: [], edges: [
      { from: source.id, to: letterforms.id, input: "image" },
      { from: signal.id, to: letterforms.id, input: "CRSV" },
      { from: random.id, to: letterforms.id, input: "MONO" },
      { from: letterforms.id, to: output.id, input: "image" },
    ] };
    const [pattern] = compileLiveGraph(graph).screens;
    const values = [0.1, 0.5, 0.9].map(time => pattern.queryArc(time, time)[0].value);
    expect(values.map(value => value._fontVariation_crsv)).toEqual([0, 0.35, 1]);
    expect(values.map(value => value._fontVariation_casl)).toEqual([1, 1, 1]);
    expect(typeof values[0]._fontVariation_mono).toBe("number");
    expect(new Set(values.map(value => value._fontVariation_mono)).size).toBe(1);
  });

  it("restores old font presets and custom axes with their cables and values", () => {
    const key = "nodesdevil-session-v1";
    const previous = localStorage.getItem(key);
    const source = makeNode("text", 0, 0);
    const width = makeNode("fontAxis", 120, 20, { tag: "WDTH", value: 115 });
    const custom = makeNode("fontAxis", 240, 20, { tag: "TEST", value: 5 });
    const signal = makeNode("numberPattern", 120, 100, { pattern: "85" });
    const weight = { id: "weight", kind: "fontWeight", x: 360, y: 20, data: {} };
    const monospace = { id: "mono", kind: "fontMonospace", x: 480, y: 20, data: { MONO: 0.5 } };
    const output = makeNode("output", 600, 20);
    const draft = { nodes: [source, width, custom, signal, weight, monospace, output], variables: [], edges: [
      { from: source.id, to: width.id, input: "image" },
      { from: signal.id, to: width.id, input: "value" },
      { from: width.id, to: custom.id, input: "image" },
      { from: custom.id, to: weight.id, input: "image" },
      { from: signal.id, to: weight.id, input: "wght" },
      { from: weight.id, to: monospace.id, input: "image" },
      { from: monospace.id, to: output.id, input: "image" },
    ] };
    try {
      localStorage.setItem(key, JSON.stringify({ draft, live: draft, view: { x: 0, y: 0, zoom: 1, previews: [width.id] }, media: [] }));
      const restored = loadNodes()!;
      expect(restored.draft.nodes[1]).toEqual({ ...width, kind: "fontShape", data: { wdth: 115 } });
      expect(restored.draft.nodes[2]).toEqual({ ...custom, kind: "fontCustomAxis" });
      expect(restored.draft.nodes[4]).toEqual({ ...weight, kind: "fontShape", data: { wght: 400 } });
      expect(restored.draft.nodes[5]).toEqual({ ...monospace, kind: "fontLetterforms" });
      expect(restored.draft.edges).toEqual(draft.edges.map(edge => edge.to === width.id && edge.input === "value"
        ? { ...edge, input: "wdth" } : edge));
      expect(restored.live).toEqual(restored.draft);
      expect(restored.view.previews).toEqual([width.id]);
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });

  it("styles text layers and accepts them in visual effects while keeping images out of font nodes", () => {
    initRegistry();
    const { nodes: [card, output] } = starterGraph();
    const source = makeNode("text", 0, 0);
    const style = makeNode("textStyle", 0, 0, { size: 48 });
    const scale = makeNode("scale", 0, 0, { value: 2 });
    const message = makeNode("constant", 0, 0, { mode: "text", value: "Hello world" });
    const content = makeNode("variable", 0, 0, { variable: "message" });
    const graph: Graph = {
      nodes: [card, output, source, style, scale, message, content],
      edges: [{ from: message.id, to: content.id, input: "value" }],
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
