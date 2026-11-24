import { defaultGradient, type Gradient } from "./gradient";

export type ValueType = "visual" | "textLayer" | "number" | "text" | "boolean" | "gradient";
export type Literal = string | number | boolean | Gradient;
export const MIN_GRAPH_ZOOM = 0.12;

export interface Socket {
  id: string;
  label: string;
  type: ValueType;
  acceptsTextLayer?: boolean;
  default?: Literal;
  optional?: boolean;
  dragStep?: number;
}

interface NodeDefinition {
  label: string;
  category: string;
  inputs: readonly Socket[];
  output?: ValueType;
  outputLabel?: string;
  extraOutputs?: readonly OutputSocket[];
  reference?: readonly string[];
  help?: string;
  modes?: readonly NodeMode[];
}

interface OutputSocket {
  id?: string;
  label?: string;
  type: ValueType;
}

export interface NodeMode {
  id: string;
  label: string;
  reference?: readonly string[];
  help?: string;
  aliases?: readonly string[];
  inputs?: readonly Socket[];
}

const imageInput: Socket = { id: "image", label: "Image", type: "visual", acceptsTextLayer: true };
const textLayerInput: Socket = { id: "image", label: "Text", type: "textLayer" };
const number = (id: string, label: string, value: number, dragStep?: number): Socket => ({ id, label, type: "number", default: value, dragStep });
const boolean = (id: string, label: string, value: boolean): Socket => ({ id, label, type: "boolean", default: value });
const text = (id: string, label: string, value: string): Socket => ({ id, label, type: "text", default: value });
const gradientInput = (id: string): Socket => ({ id, label: "Gradient", type: "gradient", default: defaultGradient });
const axis = (id: string, label: string, dragStep?: number): Socket => ({ id, label, type: "number", optional: true, dragStep });
const axes = (x: number, y: number) => [number("x", "X", x), number("y", "Y", y)];
const effect = (label: string, reference: string, input?: Socket): NodeDefinition => ({
  label, reference: [reference], category: "Image", inputs: input ? [imageInput, input] : [imageInput], output: "visual",
});
const signalInput = number("signal", "Signal", 0);
const gridSize = [number("rows", "Rows", 2, 1), number("columns", "Columns", 2, 1)];

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
  media: { label: "Media", help: "Use a single image, video, or stream from the media library.", category: "Sources", inputs: [], output: "visual" },
  texture: { label: "Texture", help: "Choose a still image from My textures or one of the bundled Kenney packs.", category: "Sources", inputs: [], output: "visual" },
  testCard: { label: "Test Card", help: "Generate the built-in test image to check the output and preview effects.", category: "Sources", inputs: [], output: "visual" },
  screen: { label: "Media Pattern", reference: ["screen", "s"], category: "Sources", inputs: [text("pattern", "Pattern", "testcard")], output: "visual" },
  color: { label: "Color", reference: ["color"], category: "Sources", inputs: [text("pattern", "Color pattern", "#ff695b")], output: "visual" },
  colorRamp: {
    label: "Color Ramp", category: "Sources", inputs: [gradientInput("gradient"), number("factor", "Factor", 0.5)],
    output: "visual", outputLabel: "Color",
    extraOutputs: [{ id: "alpha", label: "Alpha", type: "number" }, { id: "gradient", label: "Gradient", type: "gradient" }],
    help: "Sample a gradient at Factor from 0 to 1. Color is an image with the sampled opacity, Alpha is a float, and Gradient shares the full ramp.",
  },
  gradientImage: {
    label: "Gradient Image", category: "Sources", inputs: [gradientInput("gradient")], output: "visual",
    help: "Render the full gradient from left to right as an image. Edit it here or connect a Gradient cable.",
  },
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
  numberPattern: { label: "Number Pattern", help: "Sequence numbers with mini-notation. For example, `0 1` plays both values in one cycle, and `<0 1>` alternates them across cycles.", category: "Signals", inputs: [text("pattern", "Pattern", "0 1")], output: "number" },
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
  tempo: { label: "Tempo", reference: ["setCpm"], category: "Playback", inputs: [number("value", "CPM", 30, 1)] },
  speed: { ...effect("Speed", "speed", number("value", "Speed", 1)), category: "Playback" },
  sync: {
    label: "Sync", category: "Playback", inputs: [imageInput], output: "visual",
    modes: [
      { id: "single", label: "Single", reference: ["sync"] },
      { id: "stack", label: "Stack", reference: ["syncStack"], aliases: ["Sync Stack"], inputs: [number("value", "Copies", 4, 1)] },
    ],
  },
  reverse: { ...effect("Reverse", "rev"), category: "Playback" },
  chop: { ...effect("Chop", "chop", number("value", "Slices", 4, 1)), category: "Playback" },
  late: { ...effect("Late", "late", number("value", "Cycles", 0.5)), category: "Playback" },
  chance: {
    label: "Chance Transform", category: "Playback", inputs: [imageInput], output: "visual",
    modes: [
      { id: "fast", label: "Rarely Fast", reference: ["rarely"], help: "Speed up roughly 25% of events by the Rate factor.", inputs: [number("value", "Rate", 2)] },
      { id: "reverse", label: "Reverse Some Cycles", reference: ["someCycles"], help: "Reverse the order of events in roughly half of all cycles." },
      { id: "crop", label: "Sometimes Crop", reference: ["sometimes"], help: "Apply the configured horizontal or vertical crop to roughly half of the events.", inputs: [axis("x", "X"), axis("y", "Y")] },
    ],
  },
  stack: {
    label: "Stack", category: "Layout", inputs: [imageInput], output: "visual",
    modes: [
      { id: "overlay", label: "Overlay", reference: ["stack"], inputs: [{ ...imageInput, id: "second", label: "Overlay" }] },
      { id: "repeat", label: "Repeat", reference: ["stackN"], inputs: [number("value", "Copies", 4, 1)] },
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
      { id: "arrange", label: "Arrange", reference: ["gridMod"], inputs: [axis("rows", "Rows", 1), axis("columns", "Columns", 1)] },
      { id: "dimensions", label: "Set Dimensions", reference: ["rows", "cols", "rowscols"], help: "Set the row and column counts for a downstream grid.", aliases: ["Grid Dimensions"], inputs: gridSize },
    ],
  },
  position: { label: "Position", reference: ["x", "y"], help: "Place the image on the canvas. X sets horizontal position, Y sets vertical position, and 0.5 centers either axis.", category: "Layout", inputs: [imageInput, ...axes(0.5, 0.5)], output: "visual" },
  size: { label: "Size", reference: ["width", "height"], help: "Set the image width and height as fractions of the canvas. A value of 1 fills that dimension.", category: "Layout", inputs: [imageInput, ...axes(1, 1)], output: "visual" },
  scroll: { label: "Scroll", reference: ["scroll", "scrollx", "scrolly"], category: "Layout", inputs: [imageInput, ...axes(0, 0)], output: "visual" },
  scale: { label: "Scale", reference: ["scale", "scaleX", "scaleY"], help: "Scale the image by the Uniform factor. X and Y override that factor for their respective axes.", category: "Layout", inputs: [imageInput, number("value", "Uniform", 1), axis("x", "X"), axis("y", "Y")], output: "visual" },
  rotate: { label: "Rotate", reference: ["rotateZ", "rotateX", "rotateY", "rotate"], help: "Rotate the image in turns. Z rotates in the image plane, and X and Y tilt the image.", category: "Layout", inputs: [imageInput, axis("x", "X"), axis("y", "Y"), number("value", "Z", 0)], output: "visual" },
  fit: effect("Image Fit", "objectfit", text("mode", "Mode", "cover")),
  blend: effect("Blend", "blend", text("mode", "Mode", "source-over")),
  renderLayer: { label: "Render Layer", help: "Render the incoming image pattern into a single layer that downstream nodes can use as an image.", category: "Layout", inputs: [imageInput], output: "visual" },
  alpha: effect("Opacity", "alpha", number("value", "Opacity", 0.8)),
  hue: effect("Hue Rotate", "huerot", number("value", "Turns", 0.3)),
  grey: effect("Grayscale", "grey", number("value", "Amount", 1)),
  lumaToAlpha: {
    label: "Luma to Alpha", reference: ["lumaToAlpha"], category: "Image", inputs: [imageInput], output: "visual",
    modes: [
      { id: "white", label: "White to Transparent", help: "Turn white into transparency and keep black. Gray becomes partially transparent black." },
      { id: "black", label: "Black to Transparent", help: "Turn black into transparency and keep white. Gray becomes partially transparent white." },
    ],
  },
  brightness: effect("Brightness", "brightness", number("value", "Amount", 0.2)),
  contrast: effect("Contrast", "contrast", number("value", "Amount", 1.25)),
  pixelate: effect("Pixelate", "pixelate", number("value", "Size", 8)),
  blur: effect("Blur", "blur", number("value", "Radius", 4)),
  barrel: effect("Barrel", "barrel", number("value", "Amount", 0.2)),
  modulate: { label: "Modulate", reference: ["modulate"], category: "Image", inputs: [imageInput, { ...imageInput, id: "texture", label: "Modulator" }, number("value", "Amount", 0.1)], output: "visual" },
  matte: { label: "Matte", reference: ["matte"], category: "Image", inputs: [imageInput, { ...imageInput, id: "texture", label: "Matte" }, number("value", "Amount", 1)], output: "visual" },
  text: {
    label: "Text", reference: ["text"], category: "Text",
    help: "Create a text layer. Connect it to Text Style or Font Variation to change how it looks.",
    inputs: [text("content", "Content", "Hello")], output: "textLayer",
  },
  textStyle: {
    label: "Text Style", category: "Text", output: "textLayer", reference: ["font", "fontPicker", "fontSize", "fontColor"],
    help: "Set the font family, size, or color of a text layer. Empty inputs leave the existing style in place.",
    inputs: [textLayerInput, { id: "family", label: "Font", type: "text", optional: true }, axis("size", "Size"),
      { id: "color", label: "Color", type: "text", optional: true }],
  },
  fontAxis: {
    label: "Font Variation", reference: ["fontAxis"], category: "Text", output: "textLayer",
    inputs: [textLayerInput, text("tag", "Axis", "wght"), number("value", "Amount", 400), boolean("enabled", "Italic", true)],
  },
  get: { label: "Get Variable", help: "Read a value from the Set Variable node for the same variable.", category: "Variables", inputs: [] },
  set: { label: "Set Variable", help: "Supply the value that all Get Variable nodes for this variable read. Each variable has one Set Variable node.", category: "Variables", inputs: [] },
  output: { label: "Output", help: "Send an image to the final composition. With multiple outputs, layers are drawn from the lowest number to the highest.", category: "Output", inputs: [imageInput] },
} satisfies Record<string, NodeDefinition>;

export type NodeKind = keyof typeof catalog;
export const nodeKinds = Object.keys(catalog) as NodeKind[];
export const valueTypes: ValueType[] = ["number", "text", "boolean", "visual", "textLayer", "gradient"];
export const fftBands = ["vol", "bass", "mid", "treble"] as const;
export type Band = typeof fftBands[number];

export interface GraphNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  data: Record<string, Literal>;
}

export interface GraphEdge { from: string; to: string; input: string; output?: string; legacyTextInput?: true }
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

export function outputType(graph: Graph, node: GraphNode, output?: string): ValueType | undefined {
  if (output !== undefined) return definition(node.kind).extraOutputs?.find(socket => socket.id === output)?.type;
  return node.kind === "set" || node.kind === "get" ? variableFor(graph, node)?.type : definition(node.kind).output;
}

export function outputsFor(graph: Graph, node: GraphNode): readonly OutputSocket[] {
  const type = outputType(graph, node);
  const def = definition(node.kind);
  return type ? [{ type, label: def.outputLabel }, ...(def.extraOutputs ?? [])] : [];
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
  if (type === "gradient") return [gradientInput("value")];
  if (type === "textLayer") return [{ ...textLayerInput, id: "value" }];
  return type === "visual" ? [{ ...imageInput, id: "value" }] : [];
}

export function isRenderable(type: ValueType | undefined) {
  return type === "visual" || type === "textLayer";
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
  const output = outputType(graph, from, edge.output);
  if (!output || !input || (output !== input.type &&
    !(output === "textLayer" && input.acceptsTextLayer) &&
    !(output === "visual" && input === textLayerInput && edge.legacyTextInput))) return;
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

export function insertNodeOnEdge(graph: Graph, node: GraphNode, target: GraphEdge, inputId?: string, outputId?: string) {
  if (target.from === node.id || target.to === node.id || !graph.edges.includes(target)) return;
  for (const input of inputsFor(graph, node)) {
    if (inputId !== undefined && input.id !== inputId) continue;
    if (graph.edges.some(edge => edge.to === node.id && edge.input === input.id)) continue;
    const branch = withEdge(graph, { ...target, to: node.id, input: input.id });
    if (!branch) continue;
    for (const output of outputsFor(graph, node)) {
      if (outputId !== undefined && (output.id ?? "") !== outputId) continue;
      const inserted = withEdge(branch, { from: node.id, to: target.to, input: target.input, ...(output.id && { output: output.id }) });
      if (inserted) return { graph: inserted, spliced: true };
    }
    return { graph: branch, spliced: false };
  }
}

export function keepCompatibleEdges(graph: Graph): Graph {
  let result: Graph = { ...graph, edges: [] };
  for (const edge of graph.edges) result = withEdge(result, edge) ?? result;
  return result;
}
