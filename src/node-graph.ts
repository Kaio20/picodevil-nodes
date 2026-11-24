export type ValueType = "visual" | "number" | "text" | "boolean";
export type Literal = string | number | boolean;
export const MIN_GRAPH_ZOOM = 0.12;

export interface Socket {
  id: string;
  label: string;
  type: ValueType;
  default?: Literal;
  optional?: boolean;
}

interface NodeDefinition {
  label: string;
  category: string;
  inputs: readonly Socket[];
  output?: ValueType;
  reference?: readonly string[];
  modes?: readonly NodeMode[];
}

export interface NodeMode {
  id: string;
  label: string;
  reference?: readonly string[];
  aliases?: readonly string[];
  inputs?: readonly Socket[];
}

const imageInput: Socket = { id: "image", label: "Image", type: "visual" };
const number = (id: string, label: string, value: number): Socket => ({ id, label, type: "number", default: value });
const boolean = (id: string, label: string, value: boolean): Socket => ({ id, label, type: "boolean", default: value });
const text = (id: string, label: string, value: string): Socket => ({ id, label, type: "text", default: value });
const axis = (id: string, label: string): Socket => ({ id, label, type: "number", optional: true });
const axes = (x: number, y: number) => [number("x", "X", x), number("y", "Y", y)];
const effect = (label: string, reference: string, input?: Socket): NodeDefinition => ({
  label, reference: [reference], category: "Image", inputs: input ? [imageInput, input] : [imageInput], output: "visual",
});
const signalInput = number("signal", "Signal", 0);
const gridSize = [number("rows", "Rows", 2), number("columns", "Columns", 2)];

export const fontAxes = [
  { tag: "wght", label: "Weight", value: 400 },
  { tag: "wdth", label: "Width", value: 100 },
  { tag: "italic", label: "Italic On/Off", value: true },
  { tag: "ital", label: "Italic Blend", value: 1 },
  { tag: "slnt", label: "Slant", value: -10 },
  { tag: "opsz", label: "Optical Size", value: 20 },
  { tag: "BNCE", label: "Bounce", value: 0 },
  { tag: "CASL", label: "Casual", value: 0 },
  { tag: "CRSV", label: "Cursive", value: 0.5 },
  { tag: "ELGR", label: "Element Grid", value: 1 },
  { tag: "ELSH", label: "Element Shape", value: 2 },
  { tag: "INFM", label: "Informality", value: 0 },
  { tag: "MONO", label: "Monospace", value: 1 },
  { tag: "SPAC", label: "Spacing", value: 0 },
];

export function fontAxisFor(tag: Literal) {
  return fontAxes.find(axis => axis.tag.toLowerCase() === String(tag).toLowerCase());
}

export const catalog = {
  media: { label: "Media", category: "Sources", inputs: [], output: "visual" },
  testCard: { label: "Test Card", category: "Sources", inputs: [], output: "visual" },
  screen: { label: "Media Pattern", reference: ["s"], category: "Sources", inputs: [text("pattern", "Pattern", "testcard")], output: "visual" },
  color: { label: "Color", reference: ["color"], category: "Sources", inputs: [text("pattern", "Color pattern", "#ff695b")], output: "visual" },
  waveform: {
    label: "Waveform", category: "Signals", inputs: [], output: "number",
    modes: [
      { id: "sine", label: "Sine", reference: ["sine", "sin"] },
      { id: "cosine", label: "Cosine", reference: ["cosine", "cos"] },
      { id: "saw", label: "Saw", reference: ["saw"] },
      { id: "tri", label: "Triangle", reference: ["tri"] },
    ],
  },
  rand: { label: "Random", reference: ["rand"], category: "Signals", inputs: [], output: "number" },
  fft: { label: "Audio FFT", reference: ["fft"], category: "Signals", inputs: [], output: "number" },
  numberPattern: { label: "Number Pattern", reference: ["mini"], category: "Signals", inputs: [text("pattern", "Pattern", "0 1")], output: "number" },
  range: { label: "Range", reference: ["range"], category: "Signals", inputs: [signalInput, number("min", "Min", 0), number("max", "Max", 1)], output: "number" },
  choose: { label: "Choose Number", reference: ["choose"], category: "Signals", inputs: [text("choices", "Choices", "0, 1")], output: "number" },
  segment: { label: "Segment", reference: ["segment"], category: "Signals", inputs: [signalInput, number("value", "Rate", 1)], output: "number" },
  signalRate: {
    label: "Signal Rate", category: "Signals", inputs: [signalInput, number("value", "Factor", 2)], output: "number",
    modes: [
      { id: "fast", label: "Fast", reference: ["fast"], aliases: ["Fast Signal"] },
      { id: "slow", label: "Slow", reference: ["slow"], aliases: ["Slow Signal"] },
    ],
  },
  lerp: { label: "Interpolate", reference: ["lerp"], category: "Signals", inputs: [signalInput], output: "number" },
  tempo: { label: "Tempo", reference: ["setCpm"], category: "Playback", inputs: [number("value", "CPM", 30)] },
  speed: { ...effect("Speed", "speed", number("value", "Speed", 1)), category: "Playback" },
  sync: {
    label: "Sync", category: "Playback", inputs: [imageInput], output: "visual",
    modes: [
      { id: "single", label: "Single", reference: ["sync"] },
      { id: "stack", label: "Stack", reference: ["syncStack"], aliases: ["Sync Stack"], inputs: [number("value", "Copies", 4)] },
    ],
  },
  reverse: { ...effect("Reverse", "rev"), category: "Playback" },
  chop: { ...effect("Chop", "chop", number("value", "Slices", 4)), category: "Playback" },
  late: { ...effect("Late", "late", number("value", "Cycles", 0.5)), category: "Playback" },
  chance: {
    label: "Chance Transform", category: "Playback", inputs: [imageInput], output: "visual",
    modes: [
      { id: "fast", label: "Rarely Fast", reference: ["rarely"], inputs: [number("value", "Rate", 2)] },
      { id: "reverse", label: "Reverse Some Cycles", reference: ["someCycles"] },
      { id: "crop", label: "Sometimes Crop", reference: ["sometimes"], inputs: [axis("x", "X"), axis("y", "Y")] },
    ],
  },
  stack: {
    label: "Stack", category: "Layout", inputs: [imageInput], output: "visual",
    modes: [
      { id: "overlay", label: "Overlay", reference: ["stack"], inputs: [{ ...imageInput, id: "second", label: "Overlay" }] },
      { id: "repeat", label: "Repeat", reference: ["stackN"], inputs: [number("value", "Copies", 4)] },
    ],
  },
  index: {
    label: "Index", category: "Layout", inputs: [imageInput], output: "visual",
    modes: [
      { id: "ordered", label: "Ordered", reference: ["index"] },
      { id: "shuffle", label: "Shuffle", reference: ["shuffleIndex"], aliases: ["Shuffle Index"], inputs: [axis("seed", "Seed")] },
    ],
  },
  grid: {
    label: "Grid", category: "Layout", inputs: [imageInput], output: "visual",
    modes: [
      { id: "arrange", label: "Arrange", reference: ["gridMod"], inputs: [axis("rows", "Rows"), axis("columns", "Columns")] },
      { id: "dimensions", label: "Set Dimensions", reference: ["rowscols", "rows", "cols"], aliases: ["Grid Dimensions"], inputs: gridSize },
    ],
  },
  position: { label: "Position", reference: ["x", "y"], category: "Layout", inputs: [imageInput, ...axes(0.5, 0.5)], output: "visual" },
  size: { label: "Size", reference: ["width", "height"], category: "Layout", inputs: [imageInput, ...axes(1, 1)], output: "visual" },
  scroll: { label: "Scroll", reference: ["scroll", "scrollx", "scrolly"], category: "Layout", inputs: [imageInput, ...axes(0, 0)], output: "visual" },
  scale: { label: "Scale", reference: ["scale", "scaleX", "scaleY"], category: "Layout", inputs: [imageInput, number("value", "Uniform", 1), axis("x", "X"), axis("y", "Y")], output: "visual" },
  rotate: { label: "Rotate", reference: ["rotate", "rotateX", "rotateY", "rotateZ"], category: "Layout", inputs: [imageInput, axis("x", "X"), axis("y", "Y"), number("value", "Z", 0)], output: "visual" },
  fit: effect("Image Fit", "objectfit", text("mode", "Mode", "cover")),
  blend: effect("Blend", "blend", text("mode", "Mode", "source-over")),
  renderLayer: { label: "Render Layer", category: "Layout", inputs: [imageInput], output: "visual" },
  alpha: effect("Opacity", "alpha", number("value", "Opacity", 0.8)),
  hue: effect("Hue Rotate", "huerot", number("value", "Turns", 0.3)),
  grey: effect("Grayscale", "grey", number("value", "Amount", 1)),
  brightness: effect("Brightness", "brightness", number("value", "Amount", 0.2)),
  contrast: effect("Contrast", "contrast", number("value", "Amount", 1.25)),
  pixelate: effect("Pixelate", "pixelate", number("value", "Size", 8)),
  blur: effect("Blur", "blur", number("value", "Radius", 4)),
  barrel: effect("Barrel", "barrel", number("value", "Amount", 0.2)),
  modulate: { label: "Modulate", reference: ["modulate"], category: "Image", inputs: [imageInput, { ...imageInput, id: "texture", label: "Modulator" }, number("value", "Amount", 0.1)], output: "visual" },
  matte: { label: "Matte", reference: ["matte"], category: "Image", inputs: [imageInput, { ...imageInput, id: "texture", label: "Matte" }, number("value", "Amount", 1)], output: "visual" },
  textStyle: {
    label: "Text Style", category: "Text", output: "visual", reference: ["font", "fontPicker", "fontSize", "fontColor"],
    inputs: [imageInput, { id: "family", label: "Font", type: "text", optional: true }, axis("size", "Size"),
      { id: "color", label: "Color", type: "text", optional: true }],
  },
  fontAxis: {
    label: "Font Variation", reference: ["fontAxis"], category: "Text", output: "visual",
    inputs: [{ ...imageInput, label: "Text" }, text("tag", "Axis", "wght"), number("value", "Amount", 400), boolean("enabled", "Italic", true)],
  },
  get: { label: "Get Variable", category: "Variables", inputs: [] },
  set: { label: "Set Variable", category: "Variables", inputs: [] },
  output: { label: "Output", category: "Output", inputs: [imageInput] },
} satisfies Record<string, NodeDefinition>;

export type NodeKind = keyof typeof catalog;
export const nodeKinds = Object.keys(catalog) as NodeKind[];
export const valueTypes: ValueType[] = ["number", "text", "boolean", "visual"];
export const fftBands = ["vol", "bass", "mid", "treble"] as const;
export type Band = typeof fftBands[number];

export interface GraphNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  data: Record<string, Literal>;
}

export interface GraphEdge { from: string; to: string; input: string }
export interface Variable { id: string; name: string; type: ValueType }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; variables: Variable[] }
export type NodeDrop = { kind: NodeKind; data?: Record<string, Literal> };

export function makeNode(kind: NodeKind, x: number, y: number, data: Record<string, Literal> = {}): GraphNode {
  return { id: crypto.randomUUID(), kind, x, y, data };
}

export function starterGraph(): Graph {
  const card = makeNode("testCard", 64, 96);
  const output = makeNode("output", 330, 96);
  return { nodes: [card, output], edges: [{ from: card.id, to: output.id, input: "image" }], variables: [] };
}

export function definition(kind: NodeKind): NodeDefinition {
  return catalog[kind];
}

export function modeFor(node: GraphNode): NodeMode | undefined {
  const modes = definition(node.kind).modes;
  return modes?.find(mode => mode.id === node.data.mode) ?? modes?.[0];
}

export function variableFor(graph: Graph, node: GraphNode): Variable | undefined {
  return graph.variables.find(variable => variable.id === node.data.variable);
}

export function outputType(graph: Graph, node: GraphNode): ValueType | undefined {
  return node.kind === "set" || node.kind === "get" ? variableFor(graph, node)?.type : definition(node.kind).output;
}

export function inputsFor(graph: Graph, node: GraphNode, includeInactive = false): readonly Socket[] {
  if (node.kind !== "set") {
    const def = definition(node.kind);
    if (node.kind === "fontAxis" && !includeInactive) {
      const choice = fontAxisFor(node.data.tag ?? "wght");
      const wiredTag = graph.edges.some(edge => edge.to === node.id && edge.input === "tag");
      const toggle = choice?.tag === "italic" && !wiredTag;
      return def.inputs.filter(socket => socket.id !== (toggle ? "value" : "enabled")).map(socket =>
        socket.id === "value" && choice?.tag === "slnt" && !wiredTag ? { ...socket, label: "Angle (°)" } : socket);
    }
    if (!def.modes) return def.inputs;
    const modeInputs = includeInactive ? def.modes.flatMap(mode => mode.inputs ?? []) : modeFor(node)?.inputs ?? [];
    return [...def.inputs, ...modeInputs];
  }
  const type = variableFor(graph, node)?.type;
  if (type === "number") return [number("value", "Value", 0)];
  if (type === "text") return [text("value", "Value", "")];
  if (type === "boolean") return [boolean("value", "Value", false)];
  return type === "visual" ? [{ ...imageInput, id: "value" }] : [];
}

export function previewType(graph: Graph, node: GraphNode): ValueType | undefined {
  return node.kind === "output" ? "visual" : node.kind === "tempo" ? "number" : outputType(graph, node);
}

export function referenceNode(name: string, aliases: string[]): NodeDrop | undefined {
  const names = [name, ...aliases].map(item => item.toLowerCase());
  const matches = (references?: readonly string[]) => references?.some(item => names.includes(item.toLowerCase()));
  for (const kind of nodeKinds) {
    const def = definition(kind);
    const mode = def.modes?.find(item => matches(item.reference));
    if (mode) return { kind, data: { mode: mode.id } };
    if (matches(def.reference)) return { kind };
  }
}

export function withEdge(graph: Graph, edge: GraphEdge): Graph | undefined {
  const from = graph.nodes.find(node => node.id === edge.from);
  const to = graph.nodes.find(node => node.id === edge.to);
  if (!from || !to) return;
  // Mode-specific cables stay on the graph while their sockets are hidden.
  const input = inputsFor(graph, to, true).find(socket => socket.id === edge.input);
  if (!input || outputType(graph, from) !== input.type) return;
  const edges = graph.edges.filter(existing => existing.to !== edge.to || existing.input !== edge.input);
  edges.push(edge);
  const pending = [from.id];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === to.id) return;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = graph.nodes.find(item => item.id === id);
    if (node?.kind === "get") {
      const setter = graph.nodes.find(item => item.kind === "set" && item.data.variable === node.data.variable);
      if (setter) pending.push(setter.id);
    }
    for (const connection of edges) if (connection.to === id) pending.push(connection.from);
  }
  return { ...graph, edges };
}

export function keepCompatibleEdges(graph: Graph): Graph {
  let result: Graph = { ...graph, edges: [] };
  for (const edge of graph.edges) result = withEdge(result, edge) ?? result;
  return result;
}
