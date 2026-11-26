import { clampUnit, isColorValue, type ColorValue } from "../color-value";
import { textureFiles } from "../texture-files";

export const texturePacks = Object.entries(textureFiles).map(([id, files]) => ({
  id,
  label: ({ "particle-pack": "Particle Pack", "light-masks": "Light Masks", "pattern-pack": "Pattern Pack" })[id as keyof typeof textureFiles],
  assets: files.original.map(file => ({
    id: `textures/${id}/${id === "light-masks" ? "white-on-black/" : ""}${file}`,
    name: file.slice(0, -4).replaceAll("_", " "),
  })),
}));
export const textures = new Map(texturePacks.flatMap(pack => pack.assets).map(asset => [asset.id, asset]));
export const audioBands = ["Level", "Bass", "Mid", "Treble"];
export const typeNames = {
  float: "Float", integer: "Integer", vec2: "Vector", color: "Color", image: "Image", string: "String", text: "Text", bool: "Boolean",
} as const;
export type SocketType = keyof typeof typeNames;
type Scalar = number | string | boolean;
export type Value = Scalar | ColorValue;
type Parameter = { label: string; value: Scalar; min?: number; max?: number; step?: number; options?: string[] };
type Input = { label: string; type: SocketType; value?: Value; uniform?: boolean; mask?: boolean };
type Definition = {
  label: string;
  group: "Media" | "Composite" | "Shader" | "Timing";
  inputs: Record<string, Input>;
  parameters: Record<string, Parameter>;
  output: SocketType;
  spatial?: boolean;
};

const image = (label: string): Input => ({ label, type: "image" });
const float = (label: string, value: number): Input => ({ label, type: "float", value });
const color = (label: string, hex: string): Input => ({ label, type: "color", value: { hex, alpha: 1 } });
const factor: Input = { ...float("Factor", 1), mask: true };
const number = (label: string, value: number, step = 0.01): Parameter => ({ label, value, step });
const choice = (label: string, options: string[]): Parameter => ({ label, value: options[0], options });
const node = (label: string, group: Definition["group"], output: SocketType, inputs: Record<string, Input> = {}, parameters: Record<string, Parameter> = {}, spatial = false): Definition =>
  ({ label, group, inputs, parameters, output, spatial });

export const nodes = {
  video: node("Video", "Media", "image", {}, { asset: { label: "Source", value: "demo-a" } }, true),
  texture: node("Texture", "Media", "image", {}, { asset: { label: "Source", value: texturePacks[0].assets[0].id } }, true),
  audio: node("Audio Signal", "Timing", "float", {}, { band: choice("Band", audioBands) }),
  junction: node("Reroute", "Composite", "float", { in: float("Input", 0) },
    { type: choice("Type", Object.keys(typeNames)), spatial: { label: "Field", value: false } }),
  output: node("Output", "Composite", "image", { image: image("Image") }),
  merge: node("Merge", "Composite", "image", { background: image("Background"), foreground: image("Foreground"), factor }, {
    mode: choice("Blend", ["Normal", "Multiply", "Screen"]),
  }, true),
  mask: node("Apply Mask", "Composite", "image", { image: image("Image"), mask: { ...factor, label: "Mask" } }, {}, true),
  alpha: node("Alpha", "Composite", "float", { image: image("Image") }, {}, true),
  displace: node("Displace", "Composite", "image", {
    image: image("Image"), offset: { type: "vec2", label: "Offset", value: 0 }, strength: float("Strength", 0.1),
  }, {}, true),
  value: node("Float", "Shader", "float", {}, { type: choice("Type", ["Float", "Integer"]), value: number("Value", 0.5) }),
  boolean: node("Boolean", "Shader", "bool", {}, { value: { label: "Value", value: true } }),
  switch: node("Switch", "Shader", "float", {
    condition: { label: "Condition", type: "bool", value: false }, inactive: float("False", 0), active: float("True", 1),
  }),
  color: node("Color", "Shader", "color", { color: color("Color", "#198ede") }),
  mixColor: node("Mix Color", "Shader", "color", {
    a: color("A", "#000000"), b: color("B", "#ffffff"),
    factor: { ...factor, value: 0.5 },
  }),
  uv: node("UV", "Shader", "vec2", {}, {}, true),
  vector: node("Vector", "Shader", "vec2", { x: float("X", 0), y: float("Y", 0) }),
  noise: node("Noise", "Shader", "float", {
    uv: { type: "vec2", label: "UV" }, scale: float("Scale", 5), time: float("Time", 0),
  }),
  math: node("Math", "Shader", "float", { a: float("A", 0), b: float("B", 0.5) }, {
    operation: choice("Operation", ["Add", "Subtract", "Multiply", "Divide", "Minimum", "Maximum", "Greater Than"]),
  }),
  ramp: node("Color Ramp", "Shader", "color", {
    factor: { ...factor, value: 0.5 }, low: color("Start", "#000000"), high: color("End", "#ffffff"),
  }, {
    from: number("Start position", 0), to: number("End position", 1),
  }),
  expression: node("Custom Expression", "Shader", "float", { a: float("A", 0), b: float("B", 1) }, {
    code: { label: "WGSL expression", value: "sin((uv.x + time * a) * b)" },
  }, true),
  time: node("Time", "Timing", "float", {}, { unit: choice("Output", ["Seconds", "Beats", "Beat Phase"]) }),
  lfo: node("LFO", "Timing", "float", {
    rate: { ...float("Cycles / beat", 0.25), uniform: true },
  }, { shape: choice("Wave", ["Sine", "Triangle", "Saw"]) }),
  steps: node("Step Sequencer", "Timing", "float", {}, {
    grid: { label: "Steps", value: "0.1,0.3,0.1,0.6,0.2,0.4,0.2,0.8" },
    division: { label: "Steps / beat", value: 2, min: 0.125, max: 16, step: 0.125 },
  }),
};

export type Kind = keyof typeof nodes;
export interface GraphNode { id: string; kind: Kind; x: number; y: number; params: Record<string, Value> }
export interface Edge { from: string; to: string; input: string }
export interface Port { node: string; input?: string }
export interface Project { version: 1; bpm: number; nodes: GraphNode[]; edges: Edge[] }
export interface Signal { type: SocketType; spatial: boolean }
export class GraphError extends Error {
  constructor(message: string, readonly nodeId?: string) { super(message); }
}

export const kinds = Object.keys(nodes) as Kind[];

export const integerMin = -2147483648;
export const integerMax = 2147483647;
export function roundInteger(value: number) {
  return Math.max(integerMin, Math.min(integerMax, Math.sign(value) * Math.round(Math.abs(value))));
}

function normalizeParams(kind: Kind, params: Record<string, Value>) {
  const next = { ...params };
  if (kind === "value" && next.type === undefined) next.type = "Float";
  for (const [key, input] of Object.entries(nodes[kind].inputs)) {
    if (input.type !== "color") continue;
    const inputParam = "input:" + key;
    const value = next[inputParam] ?? next[key];
    if (typeof value !== "string") continue;
    const alpha = kind === "color" ? next.alpha ?? 1 : 1;
    next[inputParam] = typeof alpha === "number" && Number.isFinite(alpha)
      ? { hex: value, alpha: clampUnit(alpha) }
      : value;
    delete next[key];
    if (kind === "color") delete next.alpha;
  }
  return next;
}

export function makeNode(kind: Kind, x: number, y: number, id: string = crypto.randomUUID(), params: Record<string, Value> = {}): GraphNode {
  const defaults = Object.fromEntries(Object.entries(nodes[kind].parameters).map(([key, parameter]) => [key, parameter.value]));
  const values = normalizeParams(kind, { ...defaults, ...params });
  if (kind === "value" && values.type === "Integer" && typeof values.value === "number") values.value = roundInteger(values.value);
  return { id, kind, x, y, params: values };
}

export function inputKey(to: string, input: string) { return JSON.stringify([to, input]); }

export function conversion(source: Signal, target: Input): string | undefined {
  if (source.spatial && target.uniform) return undefined;
  if (source.type === target.type) return "";
  if (source.type === "integer") {
    if (target.type === "float") return "Integer → Float";
    const numeric = conversion({ ...source, type: "float" }, target);
    if (numeric) return numeric.replace(/^Float →/, "Integer →");
  }
  if (source.type === "bool" && target.type === "float") return "Boolean → Float (0 or 1)";
  if (source.type === "float" && target.type === "bool") return "Float → Boolean (nonzero)";
  if (source.type === "float" && target.type === "color") return "Float → Color (grayscale)";
  if (source.type === "color" && target.type === "float") return "Color → Float (luminance × alpha)";
  if (source.type === "float" && target.type === "vec2") return "Float → Vector (same value on both axes)";
  if (source.type === "color" && target.type === "image") return "Color → Image";
  if (source.type === "image" && target.type === "float" && target.mask) return "Image → Mask (luminance × alpha)";
  return undefined;
}

export function analyze(project: Project) {
  const byId = new Map<string, GraphNode>();
  const incoming = new Map<string, Edge>();
  const signals = new Map<string, Signal>();
  const conversions = new Map<string, string>();
  const visiting = new Set<string>();
  for (const item of project.nodes) {
    if (byId.has(item.id)) throw new GraphError("Duplicate node ID.", item.id);
    byId.set(item.id, item);
  }
  for (const edge of project.edges) {
    const target = byId.get(edge.to);
    const key = inputKey(edge.to, edge.input);
    if (!target || !byId.has(edge.from) || !Object.hasOwn(nodes[target.kind].inputs, edge.input)) throw new GraphError("Invalid cable.", edge.to);
    if (incoming.has(key)) throw new GraphError("Only one cable per input.", edge.to);
    if (byId.get(edge.from)?.kind === "output") throw new GraphError("Output has no outgoing socket.", edge.to);
    incoming.set(key, edge);
  }
  function infer(id: string): Signal {
    const previous = signals.get(id);
    if (previous) return previous;
    if (visiting.has(id)) throw new GraphError("This cable creates a cycle.", id);
    visiting.add(id);
    const item = byId.get(id)!;
    const def = nodes[item.kind];
    if (item.kind === "junction") {
      const cable = incoming.get(inputKey(id, "in"));
      const signal = cable ? infer(cable.from) : { type: item.params.type as SocketType, spatial: Boolean(item.params.spatial) };
      signals.set(id, signal);
      visiting.delete(id);
      return signal;
    }
    let spatial = def.spatial || item.kind === "noise" && !incoming.has(inputKey(id, "uv"));
    for (const [key, input] of Object.entries(def.inputs)) {
      const source = incoming.get(inputKey(id, key));
      if (!source) continue;
      const upstream = infer(source.from);
      const label = conversion(upstream, input);
      if (label === undefined) throw new GraphError(`${upstream.type} cannot connect to ${input.label} (${input.type}${input.uniform ? ", single value" : ""}).`, id);
      conversions.set(inputKey(id, key), label);
      spatial ||= upstream.spatial;
    }
    const signal: Signal = { type: item.kind === "value" && item.params.type === "Integer" ? "integer" : def.output, spatial };
    signals.set(id, signal);
    visiting.delete(id);
    return signal;
  }
  for (const id of byId.keys()) infer(id);
  return { byId, incoming, signals, conversions };
}

export function connect(project: Project, edge: Edge): Project {
  const next = { ...project, edges: [...project.edges.filter(other => other.to !== edge.to || other.input !== edge.input), edge] };
  const { signals } = analyze(next);
  return withJunctionTypes(next, signals);
}

export function withJunctionTypes(project: Project, signals = analyze(project).signals): Project {
  return { ...project, nodes: project.nodes.map(node => {
    if (node.kind !== "junction") return node;
    const signal = signals.get(node.id)!;
    return { ...node, params: { type: signal.type, spatial: signal.spatial } };
  }) };
}

export function connectPorts(project: Project, a: Port, b: Port): Project | undefined {
  const [from, to] = a.input ? [b, a] : [a, b];
  if (from.input || !to.input || from.node === to.node) return;
  try { return connect(project, { from: from.node, to: to.node, input: to.input }); }
  catch (error) { if (!(error instanceof GraphError)) throw error; }
}

export function attachNode(project: Project, item: GraphNode, port: Port) {
  if (item.kind === "output" && port.input) return;
  if (port.input) return connectPorts(project, { node: item.id }, port);
  const inputs = Object.entries(nodes[item.kind].inputs);
  const signal = analyze(project).signals.get(port.node);
  inputs.sort((a, b) => Number(b[1].type === signal?.type) - Number(a[1].type === signal?.type));
  for (const [input] of inputs) {
    const next = connectPorts(project, port, { node: item.id, input });
    if (next) return next;
  }
}

export function insertNode(project: Project, item: GraphNode, edge: Edge) {
  if (item.kind === "output" || item.id === edge.from || item.id === edge.to) return;
  const source = analyze(project).signals.get(edge.from);
  const inputs = Object.entries(nodes[item.kind].inputs);
  inputs.sort((a, b) => Number(b[1].type === source?.type) - Number(a[1].type === source?.type));
  for (const [input] of inputs) {
    const occupied = project.edges.find(link => link.to === item.id && link.input === input);
    if (occupied && occupied.from !== edge.from) continue;
    const next = { ...project, edges: project.edges.filter(link => link !== edge && link !== occupied).concat(
      { from: edge.from, to: item.id, input }, { from: item.id, to: edge.to, input: edge.input },
    ) };
    try { return withJunctionTypes(next, analyze(next).signals); }
    catch (error) { if (!(error instanceof GraphError)) throw error; }
  }
}

export function projectFromJson(value: unknown): Project {
  if (!value || typeof value !== "object") throw new GraphError("Invalid compositor project.");
  const raw = value as Project;
  if (raw.version !== 1 || !Number.isFinite(raw.bpm) || raw.bpm < 1 || raw.bpm > 480 ||
      !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new GraphError("Invalid compositor project.");
  }
  const validNodes = raw.nodes.map(item => {
    if (!item || typeof item.id !== "string" || !Object.hasOwn(nodes, item.kind) || !Number.isFinite(item.x) ||
        !Number.isFinite(item.y) || !item.params || typeof item.params !== "object") throw new GraphError("Invalid node.");
    const params = normalizeParams(item.kind, item.params);
    for (const [key, parameter] of Object.entries(nodes[item.kind].parameters)) {
      const parameterValue = params[key];
      if (typeof parameterValue !== typeof parameter.value ||
          (typeof parameterValue === "number" && !Number.isFinite(parameterValue)) ||
          (parameter.options && !parameter.options.includes(String(parameterValue)))) throw new GraphError("Invalid node parameter.", item.id);
    }
    if (item.kind === "value" && params.type === "Integer" &&
        (typeof params.value !== "number" || params.value !== roundInteger(params.value))) throw new GraphError("Invalid integer.", item.id);
    for (const [key, input] of Object.entries(nodes[item.kind].inputs)) {
      const fallback = params["input:" + key];
      if (fallback === undefined) continue;
      const valid = input.type === "color" ? isColorValue(fallback) : typeof fallback === typeof input.value &&
        (typeof fallback !== "number" || (Number.isFinite(fallback) && (input.type !== "integer" || fallback === roundInteger(fallback))));
      if (!valid) throw new GraphError("Invalid input default.", item.id);
    }
    return { ...item, params };
  });
  for (const edge of raw.edges) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string" || typeof edge.input !== "string") throw new GraphError("Invalid cable.");
  }
  const data = { ...raw, nodes: validNodes };
  analyze(data);
  return data;
}

export const demo = {
  "demo-a": { url: "compositor-media/prism.mp4", name: "Prism" },
  "demo-b": { url: "compositor-media/spectrum.mp4", name: "Spectrum" },
};

export function example(): Project {
  const entries: [Kind, string, number, number, Record<string, Value>?][] = [
    ["video", "a", 30, 36],
    ["video", "b", 30, 180, { asset: "demo-b" }],
    ["time", "time", 30, 330],
    ["steps", "steps", 30, 473],
    ["noise", "noise", 265, 310],
    ["displace", "displace", 520, 164],
    ["ramp", "ramp", 520, 375, { from: 0.33, to: 0.66 }],
    ["merge", "merge", 780, 36],
    ["output", "out", 1025, 36],
  ];
  const inputs = [
    ["time", "noise", "time"], ["a", "displace", "image"], ["noise", "displace", "offset"], ["steps", "displace", "strength"],
    ["noise", "ramp", "factor"], ["b", "merge", "background"], ["displace", "merge", "foreground"],
    ["ramp", "merge", "factor"], ["merge", "out", "image"],
  ];
  return { version: 1, bpm: 120, nodes: entries.map(([kind, id, x, y, params]) => makeNode(kind, x, y, id, params)),
    edges: inputs.map(([from, to, input]) => ({ from, to, input })) };
}
