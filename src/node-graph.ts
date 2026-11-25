import { defaultGradient, maxGradientStops, rgbInterpolations, type Gradient } from "./gradient";
import { whiteColor, type ColorValue } from "./color-value";
import { blendModes, fitModes } from "./renderer-interface";

export type ValueType = "visual" | "textLayer" | "number" | "text" | "boolean" | "color";
export type Literal = string | number | boolean | ColorValue | readonly RampStop[];
export const MIN_GRAPH_ZOOM = 0.12;

export interface RampStop { readonly id: string; readonly position: number }
const defaultRampStops = [{ id: "stop-start", position: 0 }, { id: "stop-end", position: 1 }];
const blackColor: ColorValue = { hex: "#000000", alpha: 1 };

export function isRampStops(value: unknown): value is readonly RampStop[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maxGradientStops &&
    value.every(stop => stop && typeof stop.id === "string" && /^stop-[\w-]+$/.test(stop.id) &&
      typeof stop.position === "number" && stop.position >= 0 && stop.position <= 1) &&
    new Set(value.map(stop => stop.id)).size === value.length;
}

export function rampStops(node: GraphNode): readonly RampStop[] {
  const stops = node.data.stops;
  return isRampStops(stops) ? [...stops].sort((a, b) => a.position - b.position) : defaultRampStops;
}

export function rampInterpolation(node: GraphNode): Gradient["interpolation"] {
  return rgbInterpolations.find(value => value === node.data.interpolation) ?? defaultGradient.interpolation;
}

export interface Socket {
  id: string;
  label: string;
  type: ValueType;
  acceptsTextLayer?: boolean;
  default?: Literal;
  choices?: readonly string[];
  optional?: boolean;
  dragStep?: number;
  unitInterval?: boolean;
}

interface NodeDefinition {
  label: string;
  category: string;
  inputs: readonly Socket[];
  output?: ValueType;
  outputLabel?: string;
  extraOutputs?: readonly OutputSocket[];
  reference?: readonly string[];
  aliases?: readonly string[];
  help?: string;
  modes?: readonly NodeMode[];
  hidden?: boolean;
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
const modeInput = (choices: readonly [string, ...string[]]): Socket => ({
  ...text("mode", "Mode", choices[0]), choices,
});
const axis = (id: string, label: string, dragStep?: number): Socket => ({ id, label, type: "number", optional: true, dragStep });
const unitInterval = (socket: Socket): Socket => ({ ...socket, unitInterval: true, dragStep: 0.01 });
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
] as const;

export function fontAxisFor(tag: Literal) {
  return fontAxes.find(axis => axis.tag.toLowerCase() === String(tag).toLowerCase());
}

function fontAmount(tag: Exclude<typeof fontAxes[number]["tag"], "italic">, optional = false, dragStep?: number): Socket {
  const { label, value } = fontAxes.find(axis => axis.tag === tag)!;
  return optional ? axis(tag, label, dragStep) : number(tag, label, Number(value), dragStep);
}

function fontVariation(label: string, help: string, amounts: readonly Socket[], modes?: readonly NodeMode[]): NodeDefinition {
  return {
    label, help, category: "Text", output: "textLayer", inputs: [textLayerInput, ...amounts], modes,
    aliases: ["Font Variation", "Font Axis", ...amounts.flatMap(({ id, label }) => [id, label, `Font ${label}`])],
  };
}

const fontVariationNodes = {
  fontShape: fontVariation("Font Shape", "Adjust Weight, Width, and Optical Size on fonts that support those axes. Height stretches the text vertically (1 is original height). Empty inputs keep their current values.", [
    fontAmount("wght", true, 1), axis("scaleY", "Height"), fontAmount("wdth", true, 1), fontAmount("opsz", true),
  ]),
  fontItalic: fontVariation("Font Italic", "Use a switch or a numeric blend to set the italic axis in fonts such as Anybody or Shantell Sans.", [], [
    { id: "toggle", label: "On/Off", aliases: ["Italic On/Off"], inputs: [boolean("enabled", "Italic", true)] },
    { id: "blend", label: "Blend", aliases: ["Italic Blend", "ital"], inputs: [fontAmount("ital")] },
  ]),
  fontSlant: fontVariation("Font Slant", "Set the slant angle in a font such as Recursive. 0° is upright. Negative values lean right.", [
    { ...fontAmount("slnt"), label: "Angle (°)" },
  ]),
  fontHandwriting: fontVariation("Font Handwriting", "Adjust Bounce, Informality, and Spacing in Shantell Sans. Empty inputs keep their current values.", [
    fontAmount("BNCE", true), fontAmount("INFM", true), fontAmount("SPAC", true),
  ]),
  fontLetterforms: fontVariation("Font Letterforms", "Blend Casual, Cursive, and Monospace in Recursive from 0 to 1. Empty inputs keep their current values.", [
    unitInterval(fontAmount("CASL", true)), unitInterval(fontAmount("CRSV", true)), unitInterval(fontAmount("MONO", true)),
  ]),
  fontElements: fontVariation("Font Elements", "Adjust Handjet’s Element Grid and Element Shape. Empty inputs keep their current values.", [
    fontAmount("ELGR", true), fontAmount("ELSH", true),
  ]),
};

export function isFontVariation(kind: NodeKind) {
  return Object.hasOwn(fontVariationNodes, kind);
}

export function fontVariationFor(tag: string) {
  const input = tag === "italic" ? "enabled" : tag;
  for (const [kind, def] of Object.entries(fontVariationNodes)) {
    if (def.inputs.some(socket => socket.id === input)) return { kind: kind as keyof typeof fontVariationNodes, input };
    const mode = def.modes?.find(mode => mode.inputs?.some(socket => socket.id === input));
    if (mode) return { kind: kind as keyof typeof fontVariationNodes, input, mode: mode.id };
  }
}

export const catalog = {
  media: { label: "Media", help: "Use a single image, video, or stream from the media library.", category: "Sources", inputs: [], output: "visual" },
  texture: { label: "Texture", help: "Choose an image from My textures, a texture pack, or an imported folder.", category: "Sources", inputs: [], output: "visual" },
  testCard: { label: "Test Card", help: "Generate the built-in test image to check the output and preview effects.", category: "Sources", inputs: [], output: "visual" },
  constant: {
    label: "Constant", category: "Sources", inputs: [],
    modes: [
      { id: "number", label: "Float", help: "Supply a fixed number.", inputs: [number("value", "Value", 0)] },
      { id: "text", label: "String", help: "Supply a fixed string.", inputs: [text("value", "Value", "")] },
      { id: "boolean", label: "Boolean", help: "Supply a fixed on/off value.", inputs: [boolean("value", "Value", false)] },
    ],
  },
  screen: { label: "Media Pattern", reference: ["screen", "s"], category: "Sources", inputs: [text("pattern", "Pattern", "testcard")], output: "visual" },
  color: {
    label: "Color", reference: ["color"], category: "Sources", inputs: [], output: "color",
    help: "Pick a color with opacity, or switch to Pattern to sequence colors. Connect it to a Color input or render it as a solid image.",
    modes: [
      { id: "solid", label: "Solid", inputs: [{ id: "color", label: "Color", type: "color", default: { hex: "#ff695b", alpha: 1 } }] },
      { id: "pattern", label: "Pattern", inputs: [text("pattern", "Color pattern", "#ff695b")] },
    ],
  },
  colorRamp: {
    label: "Color Ramp", category: "Image", inputs: [unitInterval(number("factor", "Factor", 0.5)), { ...imageInput, optional: true }],
    output: "visual", outputLabel: "Image", extraOutputs: [{ id: "alpha", label: "Alpha", type: "number" }],
    help: "Connect an image to remap its shadows and highlights with the RGB ramp. With the Image input empty, render the ramp itself. Alpha samples the ramp at Factor (0–1).",
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
  fit: effect("Image Fit", "objectfit", modeInput(fitModes)),
  blend: {
    label: "Blend", reference: ["blend"], category: "Image", output: "visual",
    help: "Blend the Overlay over Image and output the result as one layer. Leave Overlay empty to blend Image over the layers already drawn.",
    inputs: [imageInput, { ...imageInput, id: "second", label: "Overlay", optional: true }, modeInput(blendModes)],
  },
  renderLayer: { label: "Render Layer", help: "Render the incoming image pattern into a single layer that downstream nodes can use as an image.", category: "Layout", inputs: [imageInput], output: "visual" },
  alpha: {
    ...effect("Opacity", "alpha"),
    modes: [
      { id: "uniform", label: "Uniform", inputs: [number("value", "Opacity", 0.8)] },
      { id: "white", label: "White to Transparent", reference: ["lumaToAlpha"], aliases: ["Luma to Alpha"],
        help: "Turn white into transparency and keep black. Gray becomes partially transparent black." },
      { id: "black", label: "Black to Transparent", reference: ["lumaToAlpha"],
        help: "Turn black into transparency and keep white. Gray becomes partially transparent white." },
    ],
  },
  hue: effect("Hue Rotate", "huerot", number("value", "Turns", 0.3)),
  grey: effect("Grayscale", "grey", number("value", "Amount", 1)),
  brightness: effect("Brightness", "brightness", number("value", "Amount", 0.2)),
  contrast: effect("Contrast", "contrast", number("value", "Amount", 1.25)),
  pixelate: effect("Pixelate", "pixelate", number("value", "Size", 8)),
  blur: effect("Blur", "blur", number("value", "Radius", 4)),
  barrel: effect("Barrel", "barrel", number("value", "Amount", 0.2)),
  modulate: { label: "Modulate", reference: ["modulate"], category: "Image", inputs: [imageInput, { ...imageInput, id: "texture", label: "Modulator" }, number("value", "Amount", 0.1)], output: "visual" },
  matte: { label: "Matte", reference: ["matte"], category: "Image", inputs: [imageInput, { ...imageInput, id: "texture", label: "Matte" }, number("value", "Amount", 1)], output: "visual" },
  text: {
    label: "Text", reference: ["text"], category: "Text",
    help: "Create a text layer. Connect it to Text Style or Font Shape to change how it looks.",
    inputs: [text("content", "Content", "Hello")], output: "textLayer",
  },
  textStyle: {
    label: "Text Style", category: "Text", output: "textLayer", reference: ["font", "fontPicker", "fontSize", "fontColor"],
    help: "Set the font family, size, or color of a text layer. Empty inputs leave the existing style in place.",
    inputs: [textLayerInput, { id: "family", label: "Font", type: "text", optional: true }, axis("size", "Size"),
      { id: "color", label: "Color", type: "color", optional: true }],
  },
  ...fontVariationNodes,
  fontCustomAxis: {
    ...fontVariation("Custom Font Axis", "Set any OpenType axis by its four-character tag.", [text("tag", "Axis Tag", ""), number("value", "Amount", 400)]),
    reference: ["fontAxis"],
  },
  fontAxis: {
    label: "Font Variation", reference: ["fontAxis"], category: "Text", output: "textLayer", hidden: true,
    inputs: [textLayerInput, text("tag", "Axis", "wght"), number("value", "Amount", 400), boolean("enabled", "Italic", true)],
  },
  variable: {
    label: "Variable", aliases: ["Get Variable", "Set Variable"], category: "Variables", inputs: [], outputLabel: "Get Value",
    help: "Connect a value to set the variable. Without an input cable, the node reads the variable. Each variable can have one connected setter.",
  },
  output: { label: "Output", help: "Send an image to the final composition. With multiple outputs, layers are drawn from the lowest number to the highest.", category: "Output", inputs: [imageInput] },
} satisfies Record<string, NodeDefinition>;

export type NodeKind = keyof typeof catalog;
export const nodeKinds = Object.keys(catalog) as NodeKind[];
export const valueTypes: ValueType[] = ["number", "text", "boolean", "color", "visual", "textLayer"];
export const fftBands = ["vol", "bass", "mid", "treble"] as const;
export type Band = typeof fftBands[number];

export interface GraphNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  data: Record<string, Literal>;
}

export interface GraphEdge { from: string; to: string; input: string; output?: string; legacyTextInput?: true; legacyColorInput?: true }
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
  const selected = node.data.mode ?? (node.kind === "color" && typeof node.data.pattern === "string" ? "pattern" : undefined);
  return modes?.find(mode => mode.id === selected) ?? modes?.[0];
}

export function variableFor(graph: Graph, node: GraphNode): Variable | undefined {
  return graph.variables.find(variable => variable.id === node.data.variable);
}

export function isVariableSetter(graph: Graph, node: GraphNode): boolean {
  return node.kind === "variable" && graph.edges.some(edge => edge.to === node.id && edge.input === "value");
}

export function outputType(graph: Graph, node: GraphNode, output?: string): ValueType | undefined {
  if (output !== undefined) return definition(node.kind).extraOutputs?.find(socket => socket.id === output)?.type;
  if (node.kind === "variable") return variableFor(graph, node)?.type;
  if (node.kind === "constant") return modeFor(node)?.inputs?.[0]?.type;
  return definition(node.kind).output;
}

export function outputsFor(graph: Graph, node: GraphNode): readonly OutputSocket[] {
  const type = outputType(graph, node);
  const def = definition(node.kind);
  return type ? [{ type, label: def.outputLabel }, ...(def.extraOutputs ?? [])] : [];
}

export function inputsFor(graph: Graph, node: GraphNode, includeInactive = false): readonly Socket[] {
  if (node.kind !== "variable") {
    const def = definition(node.kind);
    if (node.kind === "colorRamp") {
      const stops = rampStops(node).map(({ id }, index): Socket => ({
        id, label: `Color ${index + 1}`, type: "color", default: id === "stop-start" ? blackColor : whiteColor,
      }));
      return [...stops, ...def.inputs];
    }
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
  return type ? [{ id: "value", label: "Set Value", type, ...(type === "visual" && { acceptsTextLayer: true }) }] : [];
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
    if (def.hidden) continue;
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
    !(output === "color" && input.type === "visual") &&
    !((output === "visual" || output === "color") && input === textLayerInput && edge.legacyTextInput) &&
    !(output === "text" && input.type === "color" && to.kind === "textStyle" && edge.legacyColorInput))) return;
  if (to.kind === "variable" && graph.nodes.some(node =>
    node !== to && node.data.variable === to.data.variable && isVariableSetter(graph, node))) return;
  const edges = graph.edges.filter(existing => existing.to !== edge.to || existing.input !== edge.input);
  edges.push(edge);
  const next = { ...graph, edges };
  const pending = [from.id];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === to.id) return;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = graph.nodes.find(item => item.id === id);
    if (node?.kind === "variable" && !isVariableSetter(next, node)) {
      const setter = graph.nodes.find(item => item.data.variable === node.data.variable && isVariableSetter(next, item));
      if (setter) pending.push(setter.id);
    }
    for (const connection of edges) if (connection.to === id) pending.push(connection.from);
  }
  return next;
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
