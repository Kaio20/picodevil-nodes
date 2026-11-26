export type SocketType = "image" | "color" | "float" | "bool" | "vec2";
export type Value = number | string | boolean;
type Parameter = { label: string; value: Value; min?: number; max?: number; step?: number; options?: string[] };
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
const factor: Input = { ...float("Factor", 1), mask: true };
const number = (label: string, value: number, step = 0.01): Parameter => ({ label, value, step });
const choice = (label: string, options: string[]): Parameter => ({ label, value: options[0], options });
const node = (label: string, group: Definition["group"], output: SocketType, inputs: Record<string, Input> = {}, parameters: Record<string, Parameter> = {}, spatial = false): Definition =>
  ({ label, group, inputs, parameters, output, spatial });

export const nodes = {
  video: node("Video", "Media", "image", {}, { asset: { label: "Source", value: "demo-a" } }, true),
  output: node("Output", "Composite", "image", { image: image("Image") }),
  merge: node("Merge", "Composite", "image", { background: image("Background"), foreground: image("Foreground"), factor }, {
    mode: choice("Blend", ["Normal", "Multiply", "Screen"]),
  }, true),
  mask: node("Apply Mask", "Composite", "image", { image: image("Image"), mask: { ...factor, label: "Mask" } }, {}, true),
  alpha: node("Alpha", "Composite", "float", { image: image("Image") }, {}, true),
  displace: node("Displace", "Composite", "image", {
    image: image("Image"), offset: { type: "vec2", label: "Offset", value: 0 }, strength: float("Strength", 0.1),
  }, {}, true),
  value: node("Float", "Shader", "float", {}, { value: number("Value", 0.5) }),
  boolean: node("Boolean", "Shader", "bool", {}, { value: { label: "Value", value: true } }),
  switch: node("Switch", "Shader", "float", {
    condition: { label: "Condition", type: "bool", value: false }, inactive: float("False", 0), active: float("True", 1),
  }),
  color: node("Color", "Shader", "color", {}, { color: { label: "Color", value: "#198ede" }, alpha: number("Alpha", 1) }),
  mixColor: node("Mix Color", "Shader", "color", {
    a: { type: "color", label: "A", value: "#000000" }, b: { type: "color", label: "B", value: "#ffffff" },
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
  ramp: node("Color Ramp", "Shader", "color", { factor: { ...factor, value: 0.5 } }, {
    low: { label: "Start", value: "#000000" }, high: { label: "End", value: "#ffffff" },
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
export interface Project { version: 1; bpm: number; nodes: GraphNode[]; edges: Edge[] }
export interface Signal { type: SocketType; spatial: boolean }
export class GraphError extends Error {
  constructor(message: string, readonly nodeId?: string) { super(message); }
}

export const kinds = Object.keys(nodes) as Kind[];

export function makeNode(kind: Kind, x: number, y: number, id: string = crypto.randomUUID(), params: Record<string, Value> = {}): GraphNode {
  return { id, kind, x, y, params: { ...Object.fromEntries(Object.entries(nodes[kind].parameters).map(([key, value]) => [key, value.value])), ...params } };
}

export function inputKey(to: string, input: string) { return JSON.stringify([to, input]); }

export function conversion(source: Signal, target: Input): string | undefined {
  if (source.spatial && target.uniform) return undefined;
  if (source.type === target.type) return "";
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
    const signal = { type: def.output, spatial };
    signals.set(id, signal);
    visiting.delete(id);
    return signal;
  }
  for (const id of byId.keys()) infer(id);
  return { byId, incoming, signals, conversions };
}

export function connect(project: Project, edge: Edge): Project {
  const next = { ...project, edges: [...project.edges.filter(other => other.to !== edge.to || other.input !== edge.input), edge] };
  analyze(next);
  return next;
}

export function projectFromJson(value: unknown): Project {
  if (!value || typeof value !== "object") throw new GraphError("Invalid compositor project.");
  const data = value as Project;
  if (data.version !== 1 || !Number.isFinite(data.bpm) || data.bpm < 1 || data.bpm > 480 ||
      !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new GraphError("Invalid compositor project.");
  }
  for (const item of data.nodes) {
    if (!item || typeof item.id !== "string" || !Object.hasOwn(nodes, item.kind) || !Number.isFinite(item.x) ||
        !Number.isFinite(item.y) || !item.params || typeof item.params !== "object") throw new GraphError("Invalid node.");
    for (const [key, parameter] of Object.entries(nodes[item.kind].parameters)) {
      const parameterValue = item.params[key];
      if (typeof parameterValue !== typeof parameter.value ||
          (typeof parameterValue === "number" && !Number.isFinite(parameterValue)) ||
          (parameter.options && !parameter.options.includes(String(parameterValue)))) throw new GraphError("Invalid node parameter.", item.id);
    }
    for (const [key, input] of Object.entries(nodes[item.kind].inputs)) {
      const fallback = item.params["input:" + key];
      if (fallback !== undefined && (typeof fallback !== typeof input.value ||
          (typeof fallback === "number" && !Number.isFinite(fallback)))) throw new GraphError("Invalid input default.", item.id);
    }
  }
  for (const edge of data.edges) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string" || typeof edge.input !== "string") throw new GraphError("Invalid cable.");
  }
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
