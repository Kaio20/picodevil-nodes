import { keepCompatibleEdges, makeNode, MIN_GRAPH_ZOOM, nodeKinds, outputType, valueTypes, type Graph, type GraphNode, type Literal, type NodeKind } from "./node-graph";
import { isGradient } from "./gradient";
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
      Object.values(node.data).every(value => typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) || isGradient(value))) &&
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

/** Keep node IDs, positions and cables when restoring saved graphs from before mode selectors. */
function restoreGraph(graph?: Graph): Graph | undefined {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return;
  const remappedInputs = new Map<string, { from: string; to: string }>();
  const nodes = graph.nodes.map(node => {
    if (!node || !node.data || typeof node.data !== "object") return node;
    const variant = formerModes.get(node.kind);
    if (variant) return { ...node, kind: variant[0], data: { ...node.data, mode: variant[1] } };
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
    if (edge.input !== "image") return edge;
    const target = byId.get(edge.to)?.kind;
    if (target !== "textStyle" && target !== "fontAxis") return edge;
    const source = byId.get(edge.from);
    // Older text chains could include any visual node, including mixed media patterns.
    return source && outputType(next, source, edge.output) === "visual" ? { ...edge, legacyTextInput: true } : edge;
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
