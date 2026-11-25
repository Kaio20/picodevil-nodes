import { fontAxisFor, fontVariationFor, isFontVariation, isRampStops, keepCompatibleEdges, makeNode, MIN_GRAPH_ZOOM, nodeKinds, outputType, rampInterpolation, valueTypes, type Graph, type GraphNode, type Literal, type NodeKind } from "./node-graph";
import { defaultGradient, maxGradientStops, rgbInterpolations, type Gradient } from "./gradient";
import { isColorValue, whiteColor } from "./color-value";
import type { GraphView } from "./node-editor";
import type { FftConfig, UrlMediaEntry } from "./url-state";

const key = "nodesdevil-session-v1";

export interface NodeSession {
  draft: Graph;
  live?: Graph;
  view: GraphView;
  media: UrlMediaEntry[];
  fft?: FftConfig;
}

function validGraph(graph: Graph | undefined): graph is Graph {
  return Boolean(graph && Array.isArray(graph.nodes) && Array.isArray(graph.edges) && Array.isArray(graph.variables) &&
    graph.nodes.every(node => node && typeof node.id === "string" && nodeKinds.includes(node.kind) &&
      Number.isFinite(node.x) && Number.isFinite(node.y) && node.data && typeof node.data === "object" &&
      Object.entries(node.data).every(([key, value]) => typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) || isColorValue(value) ||
        (node.kind === "colorRamp" && key === "stops" && isRampStops(value)))) &&
    graph.edges.every(edge => edge && typeof edge.from === "string" && typeof edge.to === "string" && typeof edge.input === "string" &&
      (edge.output === undefined || typeof edge.output === "string")) &&
    graph.variables.every(item => item && typeof item.id === "string" && typeof item.name === "string" && valueTypes.includes(item.type)));
}

const formerModes = new Map<string, [NodeKind, string]>([
  ["sine", ["waveform", "sine"]], ["cosine", ["waveform", "cosine"]],
  ["saw", ["waveform", "saw"]], ["tri", ["waveform", "tri"]],
  ["fastSignal", ["signalRate", "fast"]], ["slowSignal", ["signalRate", "slow"]],
  ["syncStack", ["sync", "stack"]], ["stackN", ["stack", "repeat"]],
  ["shuffleIndex", ["index", "shuffle"]], ["gridDimensions", ["grid", "dimensions"]],
  ["rarelyFast", ["chance", "fast"]], ["someCyclesReverse", ["chance", "reverse"]],
  ["sometimesCrop", ["chance", "crop"]],
]);

const formerText = new Map<string, { key: string; input: string; fallback: Literal }>([
  ["font", { key: "family", input: "family", fallback: "sans-serif" }],
  ["fontSize", { key: "size", input: "value", fallback: 48 }],
  ["fontColor", { key: "color", input: "value", fallback: "white" }],
]);

const formerFontVariations = new Map<string, { kind: NodeKind; input: string; fallback: number }>([
  ["fontWeight", { kind: "fontShape", input: "wght", fallback: 400 }],
  ["fontWidth", { kind: "fontShape", input: "wdth", fallback: 100 }],
  ["fontOpticalSize", { kind: "fontShape", input: "opsz", fallback: 20 }],
  ["fontMonospace", { kind: "fontLetterforms", input: "MONO", fallback: 1 }],
]);

function savedGradient(value: unknown): Gradient {
  if (!value || typeof value !== "object") return defaultGradient;
  const { stops, interpolation, space } = value as Gradient & { space?: string };
  if (!Array.isArray(stops) || stops.length === 0 || stops.length > maxGradientStops || !stops.every(stop =>
    stop && typeof stop.position === "number" && stop.position >= 0 && stop.position <= 1 &&
    isColorValue({ hex: stop.color, alpha: stop.alpha }))) return defaultGradient;
  const rgb = !space || space === "RGB";
  return { stops, interpolation: rgb && rgbInterpolations.includes(interpolation) ? interpolation : "Linear" };
}

function dataFromGradient(gradient: Gradient): GraphNode["data"] {
  const stops = gradient.stops.map(({ position }, index) => ({ id: `stop-${index}`, position }));
  const data: GraphNode["data"] = { stops, interpolation: gradient.interpolation };
  gradient.stops.forEach(({ color, alpha }, index) => { data[stops[index].id] = { hex: color, alpha }; });
  return data;
}

function restoreRamps(graph: Graph): Graph {
  const oldVariables = new Set(graph.variables.filter(variable => String(variable?.type) === "gradient").map(variable => variable.id));
  const oldRampInputs = new Set(graph.edges.filter(edge => edge?.input === "gradient").map(edge => edge.to));
  const byId = new Map(graph.nodes.filter(Boolean).map(node => [node.id, node]));
  const setters = new Map(graph.nodes.filter(node => String(node?.kind) === "set").map(node => [node.data?.variable, node]));
  const incoming = new Map(graph.edges.filter(Boolean).map(edge => [JSON.stringify([edge.to, edge.input]), edge]));
  const fromInput = (node: GraphNode, input: string, visiting = new Set<string>()): Gradient => {
    if (visiting.has(node.id)) return defaultGradient;
    visiting.add(node.id);
    const edge = incoming.get(JSON.stringify([node.id, input]));
    const source = edge && byId.get(edge.from);
    if (source && String(source.kind) === "get") {
      const setter = setters.get(source.data?.variable);
      if (setter) return fromInput(setter, "value", visiting);
    }
    if (source && String(source.kind) === "set") return fromInput(source, "value", visiting);
    if (source?.kind === "colorRamp" && edge?.output === "gradient") return fromInput(source, "gradient", visiting);
    return savedGradient(node.data?.[input]);
  };
  const addedNodes: GraphNode[] = [];
  const addedEdges: Graph["edges"] = [];
  const nodes = graph.nodes.map(node => {
    if (!node?.data || typeof node.data !== "object") return node;
    const data = { ...node.data };
    if (String(node.kind) === "gradientImage" || (node.kind === "colorRamp" && ("gradient" in data || oldRampInputs.has(node.id)))) {
      delete data.gradient;
      return { ...node, kind: "colorRamp" as const, data: { ...data, ...dataFromGradient(fromInput(node, "gradient")) } };
    }
    if (node.kind === "colorRamp" && data.interpolation !== undefined) {
      return { ...node, data: { ...data, interpolation: rampInterpolation(node) } };
    }
    if (String(node.kind) !== "set" || typeof data.variable !== "string" || !oldVariables.has(data.variable)) return node;
    delete data.value;
    if (!incoming.has(JSON.stringify([node.id, "value"]))) {
      const ramp = makeNode("colorRamp", node.x - 310, node.y, dataFromGradient(fromInput(node, "value")));
      addedNodes.push(ramp);
      addedEdges.push({ from: ramp.id, to: node.id, input: "value" });
    }
    return { ...node, data };
  });
  const edges = graph.edges.flatMap(edge => {
    if (edge?.input === "gradient") return [];
    if (edge?.output !== "gradient") return [edge];
    const { output, ...imageEdge } = edge;
    return [imageEdge];
  });
  const variables = graph.variables.map(variable => oldVariables.has(variable?.id) ? { ...variable, type: "visual" as const } : variable);
  return { nodes: [...nodes, ...addedNodes], edges: [...edges, ...addedEdges], variables };
}

function restoreVariables(graph: Graph): Graph {
  const sources: GraphNode[] = [];
  const edges = [...graph.edges];
  const nodes = graph.nodes.map(node => {
    const kind = String(node?.kind);
    if ((kind !== "get" && kind !== "set") || !node.data || typeof node.data !== "object") return node;
    const { value, ...data } = node.data;
    if (kind === "set" && !edges.some(edge => edge?.to === node.id && edge.input === "value")) {
      const type = graph.variables.find(variable => variable?.id === data.variable)?.type;
      let source: GraphNode | undefined;
      if (type === "color") {
        source = makeNode("color", node.x - 310, node.y, { color: isColorValue(value) ? value : whiteColor });
      } else if (type === "number" || type === "text" || type === "boolean") {
        source = makeNode("constant", node.x - 310, node.y, { mode: type, ...(value !== undefined && { value }) });
      }
      if (source) {
        sources.push(source);
        edges.push({ from: source.id, to: node.id, input: "value" });
      }
    }
    return { ...node, kind: "variable" as const, data };
  });
  return { ...graph, nodes: [...nodes, ...sources], edges };
}

/** Keep node IDs, positions and cables when restoring older saved graphs. */
function restoreGraph(graph?: Graph): Graph | undefined {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.variables)) return;
  graph = restoreVariables(restoreRamps(graph));
  const remappedInputs = new Map<string, { from: string; to: string }>();
  const savedEdges = graph.edges;
  const nodes = graph.nodes.map(node => {
    if (!node || !node.data || typeof node.data !== "object") return node;
    if (String(node.kind) === "lumaToAlpha") {
      return { ...node, kind: "alpha" as const, data: { ...node.data, mode: node.data.mode === "black" ? "black" : "white" } };
    }
    const variant = formerModes.get(node.kind);
    if (variant) return { ...node, kind: variant[0], data: { ...node.data, mode: variant[1] } };
    const formerFont = formerFontVariations.get(node.kind);
    if (formerFont) {
      const { kind, input, fallback } = formerFont;
      return { ...node, kind, data: { ...node.data, [input]: node.data[input] ?? fallback } };
    }
    if (node.kind === "fontAxis") {
      const hasCable = (input: string) => savedEdges.some(edge => edge?.to === node.id && edge.input === input);
      const tag = node.data.tag ?? "wght";
      const preset = fontAxisFor(tag);
      const variation = !hasCable("tag") && preset ? fontVariationFor(preset.tag) : undefined;
      // This cable can become active again by switching the legacy axis to Italic On/Off.
      if (hasCable("enabled") && variation?.kind !== "fontItalic") return node;
      const value = node.data.value ?? 400;
      if (!variation) return { ...node, kind: "fontCustomAxis" as const, data: { tag, value } };
      if (variation.kind === "fontItalic") {
        remappedInputs.set(node.id, { from: "value", to: "ital" });
        return { ...node, kind: variation.kind, data: { mode: variation.mode ?? "toggle", ital: value, enabled: node.data.enabled ?? true } };
      }
      remappedInputs.set(node.id, { from: "value", to: variation.input });
      return { ...node, kind: variation.kind, data: { [variation.input]: value } };
    }
    const text = formerText.get(node.kind);
    if (!text) return node;
    if (text.key !== text.input) remappedInputs.set(node.id, { from: text.input, to: text.key });
    return { ...node, kind: "textStyle" as const, data: { [text.key]: node.data[text.input] ?? text.fallback } };
  });
  const edges = graph.edges.map(edge => {
    const remap = remappedInputs.get(edge?.to);
    return remap && edge.input === remap.from ? { ...edge, input: remap.to } : edge;
  });
  const next = { ...graph, nodes, edges };
  if (!validGraph(next)) return;
  if (!nodes.some(node => node.kind === "output")) {
    const rightmost = nodes.reduce<GraphNode | undefined>((right, node) => !right || node.x > right.x ? node : right, undefined);
    nodes.push(makeNode("output", rightmost ? rightmost.x + 230 : 330, rightmost?.y ?? 96));
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  next.edges = edges.map(edge => {
    const target = byId.get(edge.to)?.kind;
    if (!target || (target !== "textStyle" && target !== "fontAxis" && target !== "fontCustomAxis" && !isFontVariation(target))) return edge;
    const source = byId.get(edge.from);
    if (!source) return edge;
    const type = outputType(next, source, edge.output);
    if (target === "textStyle" && edge.input === "color" && type === "text") return { ...edge, legacyColorInput: true };
    // Older text chains could include any visual node, including mixed media patterns.
    const formerVisual = source.kind === "color";
    return edge.input === "image" && (type === "visual" || (type === "color" && formerVisual)) ? { ...edge, legacyTextInput: true } : edge;
  });
  return keepCompatibleEdges(next);
}

export function loadNodes(): NodeSession | undefined {
  try {
    const session = JSON.parse(localStorage.getItem(key) ?? "null") as NodeSession | null;
    if (!session) return;
    const draft = restoreGraph(session.draft);
    if (!draft) return;
    session.draft = draft;
    session.live = restoreGraph(session.live);
    if (!session.view || !Number.isFinite(session.view.x) || !Number.isFinite(session.view.y) || !Number.isFinite(session.view.zoom)) {
      session.view = { x: 0, y: 0, zoom: 1, previews: [] };
    }
    session.view.zoom = Math.max(MIN_GRAPH_ZOOM, Math.min(2.5, session.view.zoom));
    if (!Array.isArray(session.view.previews)) session.view.previews = [];
    if (!Array.isArray(session.media)) session.media = [];
    session.media = session.media.filter(item => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.url === "string");
    return session;
  } catch { return; }
}

export function saveNodes(session: NodeSession) {
  try { localStorage.setItem(key, JSON.stringify(session)); }
  catch { /* The current graph remains available in memory. */ }
}
