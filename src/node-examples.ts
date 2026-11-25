import type { ExampleName } from "./examples";
import { makeNode, type Graph, type GraphNode, type Literal, type NodeKind } from "./node-graph";

export function createExampleGraph(name: ExampleName): Graph {
  const graph: Graph = { nodes: [], edges: [], variables: [] };
  const add = (
    kind: NodeKind, column: number, row: number,
    data: Record<string, Literal> = {}, inputs: Record<string, GraphNode> = {},
  ): GraphNode => {
    const node = makeNode(kind, 56 + column * 224, 64 + row * 184, data);
    graph.nodes.push(node);
    for (const [input, source] of Object.entries(inputs)) graph.edges.push({ from: source.id, to: node.id, input });
    return node;
  };
  const image = (kind: NodeKind, column: number, row: number, source: GraphNode, data: Record<string, Literal> = {}) =>
    add(kind, column, row, data, { image: source });
  const media = (column: number, row: number, pattern: string) => add("screen", column, row, { pattern });
  const number = (column: number, row: number, pattern: string) => add("numberPattern", column, row, { pattern });
  const signal = (kind: NodeKind, column: number, row: number, source: GraphNode, value?: number) =>
    add(kind, column, row, value === undefined ? {} : { value }, { signal: source });
  const waveform = (mode: string, column: number, row: number) => add("waveform", column, row, { mode });
  const rate = (mode: "fast" | "slow", column: number, row: number, source: GraphNode, value: number) =>
    add("signalRate", column, row, { mode, value }, { signal: source });
  const output = (column: number, row: number, source: GraphNode) => image("output", column, row, source);

  switch (name) {
    case "rgb": {
      const rgb = media(0, 0, "<rgb1 rgb2 rgb3>");
      const opacity = image("alpha", 1, 0, rgb, { value: 1 });
      const fit = image("fit", 2, 0, opacity, { mode: "tilecenter" });
      const horizontal = signal("segment", 2, 1, add("rand", 1, 1), 1);
      const vertical = rate("slow", 2, 2, waveform("sine", 1, 2), 5);
      const scroll = add("scroll", 3, 0, {}, { image: fit, x: horizontal, y: vertical });
      const turns = rate("slow", 3, 3, waveform("saw", 2, 3), 10);
      const rotate = add("rotate", 4, 0, {}, { image: scroll, value: turns });
      const size = signal("lerp", 4, 1, number(3, 1, "<1.5 2.5>/4"));
      output(6, 0, add("scale", 5, 0, {}, { image: rotate, value: size }));
      const feedback = image("scale", 4, 2, media(3, 2, "prev"), { value: 0.95 });
      output(7, 2, image("alpha", 6, 2, image("barrel", 5, 2, feedback, { value: 0.01 }), { value: 0.9 }));
      break;
    }
    case "space_tv": {
      output(1, 0, media(0, 0, "#222"));
      const scanFit = image("fit", 1, 2, media(0, 2, "scanlines"), { mode: "tile" });
      const scan = image("renderLayer", 3, 2, image("scale", 2, 2, scanFit, { value: 10 }));
      const scanBlend = image("blend", 4, 2, scan, { mode: "multiply" });
      const overlay = image("alpha", 5, 2, scanBlend, { value: 0.4 });
      const clips = media(0, 1, "issexercise1, issexercise2, issexercise3, issdock, issmodule, tvsnow, testcard");
      const sync = image("sync", 1, 1, clips);
      const seed = signal("segment", 2, 0, add("rand", 1, 0.5), 1);
      const shuffled = add("index", 2, 1, { mode: "shuffle" }, { image: sync, seed });
      const stack = add("stack", 6, 1, {}, { image: shuffled, second: overlay });
      const grid = image("grid", 7, 1, stack, { rows: 3, columns: 4 });
      const scale = image("scale", 8, 1, grid, { value: 0.9 });
      const barrel = image("barrel", 9, 1, scale, { value: 0.7 });
      output(11, 1, image("chance", 10, 1, barrel, { mode: "crop", x: -1, y: -1 }));
      break;
    }
    case "canalslices": {
      const slices = image("sync", 1, 0, media(0, 0, "canalboat"), { mode: "stack", value: 5 });
      const shuffled = image("index", 2, 0, slices, { mode: "shuffle" });
      output(4, 0, image("grid", 3, 0, shuffled, { rows: 1, columns: 5 }));
      break;
    }
    case "ducks": {
      add("tempo", 0, 0, { value: 7.5 });
      const source = media(0, 1, "ducks");
      const speed = add("speed", 2, 1, {}, { image: source, value: number(1, 2, "<1 .5*2 -1 -.5*2>") });
      const slices = image("chop", 3, 1, speed, { value: 8 });
      output(5, 1, image("reverse", 4, 1, slices));
      break;
    }
    case "picodevil": {
      const background = add("text", 0, 0, { content: " picodevil " });
      const smallText = image("textStyle", 2, 0, background, { family: "BIZ UDPMincho", size: 48 });
      const turns = rate("slow", 2, 1, waveform("saw", 1, 1), 100);
      const tiled = image("fit", 3, 0, smallText, { mode: "tile" });
      const rotation = add("rotate", 4, 0, {}, { image: tiled, value: turns });
      output(6, 0, image("scale", 5, 0, rotation, { value: 2 }));
      const feedback = image("alpha", 4, 1, media(3, 1, "prev"), { value: 0.9975 });
      const pixels = image("pixelate", 5, 1, feedback, { value: 8 });
      const hue = rate("fast", 5, 2, number(4, 2, "-.01 .01"), 10);
      output(7, 1, add("hue", 6, 1, {}, { image: pixels, value: hue }));
      const text = image("textStyle", 1, 3, add("text", 0, 3, { content: "picodevil" }), {
        family: "Shantell Sans", size: 500, color: { hex: "#ff0000", alpha: 1 },
      });
      const wave = waveform("sine", 0, 4);
      const range = (column: number, row: number, source: GraphNode, min: number, max: number) =>
        add("range", column, row, { min, max }, { signal: source });
      const informality = signal("lerp", 1, 2, number(0, 2, "0 100 50"));
      const bounce = rate("fast", 2, 4, range(1, 4, wave, -100, 100), 2);
      const weight = rate("fast", 3, 5, range(2, 5, wave, 300, 800), 1.5);
      const italics = rate("slow", 4, 4, range(3, 4, wave, 0, 1), 10);
      const handwriting = add("fontHandwriting", 3, 3, {}, { image: text, INFM: informality, BNCE: bounce });
      const shape = add("fontShape", 4, 3, {}, { image: handwriting, wght: weight });
      const ital = add("fontItalic", 5, 3, { mode: "blend" }, { image: shape, ital: italics });
      const x = rate("slow", 6, 4, range(5, 4, wave, 0.4, 0.6), 5);
      const cosine = waveform("cosine", 4, 5);
      const y = rate("slow", 6, 5, range(5, 5, cosine, 0.4, 0.6), 2);
      output(8, 3, add("position", 7, 3, {}, { image: ital, x, y }));
      break;
    }
    case "colour grids (flashing)": {
      output(1, 0, media(0, 0, "prev"));
      const colors = media(0, 1, "<#f00 #0f0 #00f prev>,<white black ~>");
      // The original samples grid size before shifting and stacking events.
      const count = number(0, 2, "<1 3 4 11 32>");
      const dimensions = add("grid", 1, 1, { mode: "dimensions" }, { image: colors, rows: count, columns: count });
      const firstStack = add("stack", 2, 1, { mode: "repeat" }, { image: dimensions, value: number(1, 2, "4 2 8 1") });
      const sampleRate = signal("segment", 2, 3, add("choose", 1, 3, { choices: "0.25, 0.5, 1" }), 1);
      const delay1 = add("segment", 3, 2, {}, {
        signal: add("choose", 2, 2, { choices: `0, ${1 / 3}, 0.5, ${2 / 3}` }), value: sampleRate,
      });
      const delay2 = add("segment", 4, 3, {}, {
        signal: add("choose", 3, 3, { choices: "0, 0, 0, 0, 1, -1, 2, 3" }), value: sampleRate,
      });
      const late1 = add("late", 4, 1, {}, { image: firstStack, value: delay1 });
      const late2 = add("late", 5, 1, {}, { image: late1, value: delay2 });
      const secondStack = add("stack", 6, 1, { mode: "repeat" }, { image: late2, value: number(5, 2, "2 4 3") });
      const fast = image("chance", 7, 1, secondStack, { mode: "fast", value: 2 });
      const thirdStack = add("stack", 8, 1, { mode: "repeat" }, { image: fast, value: number(7, 2, "<1 4>") });
      const reverse = image("chance", 9, 1, thirdStack, { mode: "reverse" });
      const index = image("index", 10, 1, reverse);
      output(12, 1, image("grid", 11, 1, index));
      break;
    }
  }
  return graph;
}
