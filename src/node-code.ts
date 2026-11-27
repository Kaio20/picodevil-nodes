import { CYCLES_PER_SECOND } from "./config";
import { clampUnit, colorCss, colorFromCss, isColorValue } from "./color-value";
import { gradientSampler } from "./gradient";
import {
  expressionOperations, fftBands, inputsFor, isFontVariation, isPixelOutput, modeFor, outputType,
  rampInterpolation, rampStops, signalGraph, testCardStrips, type Band, type Graph, type GraphEdge, type GraphNode, type Literal,
} from "./node-graph";
import type { MediaEntry } from "./media-registry";

function codeLiteral(value: unknown): string {
  // Double-quoted strings are Strudel mini-notation in the code editor.
  return JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"/g, (token, offset: number, json: string) => {
    const quoted = `'${token.slice(1, -1).replace(/'/g, "\\'")}'`;
    return token === '"__proto__"' && json[offset + token.length] === ":" ? `[${quoted}]` : quoted;
  });
}

function portableMedia(entry: MediaEntry) {
  return (entry.type === "video" || entry.type === "image") && entry.url && !entry.url.startsWith("blob:");
}

function graphCall(name: string, graph: Graph, media: readonly MediaEntry[]) {
  const namedSources = graph.nodes.some(node => node.kind === "screen");
  const sourceIds = new Set(graph.nodes.flatMap(node => node.kind === "media" || node.kind === "texture" ? [node.data.media] : []));
  const sources = media.filter(entry => portableMedia(entry) && (namedSources || sourceIds.has(entry.id)))
    .map(({ id, name, url, type, collection }) => ({ id, name, url, type, collection }));
  const list = (items: readonly object[], indent: string) => items.length
    ? `[\n${items.map(item => `${indent}  ${codeLiteral(item)},\n`).join("")}${indent}]` : "[]";

  return `${name}({
  nodes: ${list(graph.nodes, "  ")},
  edges: ${list(graph.edges, "  ")},
  variables: ${list(graph.variables, "  ")},
}${sources.length ? `, ${list(sources, "")}` : ""})`;
}

interface Expression {
  source: string;
  methods: string[];
  literal?: Literal;
}

const expression = (source: string): Expression => ({ source, methods: [] });
const literal = (value: Literal): Expression => ({ ...expression(codeLiteral(value)), literal: value });
const format = (value: Expression, separator = "") => [value.source, ...value.methods].join(separator);
const method = (value: Expression, name: string, ...args: (Expression | undefined)[]): Expression => {
  while (args.length && args.at(-1) === undefined) args.pop();
  return { source: value.source, methods: [...value.methods,
    `.${name}(${args.map(arg => arg ? format(arg) : "undefined").join(", ")})`] };
};
const invoke = (name: string, ...args: Expression[]) => expression(`${name}(${args.map(arg => format(arg)).join(", ")})`);
const reified = (value: Expression) => value.literal === undefined ? value : invoke("reify", value);
const miniTokens = (pattern: string) => pattern.split(/[\s<>\[\](),{}:!?*%@/|]+/).filter(Boolean);

function bounded(value: Expression | undefined, max: number): Expression | undefined {
  if (!value) return;
  if (typeof value.literal === "number") return literal(Math.max(1, Math.min(max, Math.round(value.literal) || 1)));
  return method(reified(value), "fmap", expression(`value => Math.max(1, Math.min(${max}, Math.round(Number(value)) || 1))`));
}

class IncompleteGraph extends Error {}

export function exportNodeCode(draft: Graph, media: readonly MediaEntry[]): string {
  const graph = signalGraph(draft);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const inputs = new Map<string, Map<string, GraphEdge>>();
  const counts = new Map<string, number>();
  const keyFor = (id: string, output?: string) => JSON.stringify([id, output]);
  for (const edge of graph.edges) {
    const sockets = inputs.get(edge.to) ?? new Map<string, GraphEdge>();
    sockets.set(edge.input, edge);
    inputs.set(edge.to, sockets);
  }
  const setters = new Map(graph.nodes.filter(node => node.kind === "variable" && inputs.get(node.id)?.has("value"))
    .map(node => [node.data.variable, node]));
  const outputs = graph.nodes.filter(node => node.kind === "output");
  const tempo = graph.nodes.filter(node => node.kind === "tempo").at(-1);
  const reachable = new Set<string>();
  function countUses(id: string, output?: string) {
    const key = keyFor(id, output);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const node = nodes.get(id);
    if (!node || reachable.has(key)) return;
    reachable.add(key);
    const incoming = inputs.get(id);
    if (node.kind === "variable" && !incoming?.has("value")) {
      const setter = setters.get(node.data.variable);
      if (setter) countUses(setter.id, output);
    }
    for (const socket of inputsFor(graph, node)) {
      const edge = incoming?.get(socket.id);
      if (edge) countUses(edge.from, edge.output);
    }
  }
  if (tempo) countUses(tempo.id);
  for (const node of outputs) countUses(node.id);
  const cache = new Map<string, Expression>();
  const visiting = new Set<string>();
  const statements: string[] = [];
  const nativeMedia = new Set<MediaEntry>();
  const fallbackNodes = new Set<string>();
  const fallbackVariables = new Set<Literal>();
  const usedNames = new Set(media.map(entry => entry.name));
  for (const node of graph.nodes) {
    if (typeof node.data.pattern === "string") miniTokens(node.data.pattern).forEach(token => usedNames.add(token));
  }
  let variableIndex = 0;
  let layerIndex = 0;

  function addFallback(id: string) {
    if (fallbackNodes.has(id)) return;
    fallbackNodes.add(id);
    const node = nodes.get(id);
    if (node?.kind === "variable") {
      fallbackVariables.add(node.data.variable);
      const setter = setters.get(node.data.variable);
      if (setter) addFallback(setter.id);
    }
    for (const edge of inputs.get(id)?.values() ?? []) addFallback(edge.from);
  }

  function fallback(node: GraphNode, output?: string) {
    addFallback(node.id);
    return invoke("readNode", literal(node.id), ...(output ? [literal(output)] : []));
  }

  function hiddenLayer(value: Expression, preferred?: Literal) {
    let name = typeof preferred === "string" && /^[a-zA-Z]\w*$/.test(preferred) && !usedNames.has(preferred) ? preferred : "";
    while (!name || usedNames.has(name)) name = `nodeLayer${++layerIndex}`;
    usedNames.add(name);
    statements.push(`H${name}: ${format(value, "\n  ")}`);
    return invoke("s", expression(JSON.stringify(name)));
  }

  function coversCanvas(output: GraphNode) {
    const edge = inputs.get(output.id)?.get("image");
    const source = edge && nodes.get(edge.from);
    if (!source || inputs.get(source.id)?.size) return false;
    if (source.kind === "color" && modeFor(source)?.id === "solid") {
      const color = source.data.color ?? inputsFor(graph, source)[0]?.default;
      return isColorValue(color) && color.alpha === 1;
    }
    const pattern = source.data.pattern;
    return source.kind === "screen" && typeof pattern === "string" && /^[#a-zA-Z0-9]+$/.test(pattern) &&
      !media.some(entry => entry.name === pattern) && colorFromCss(pattern)?.alpha === 1;
  }

  function imageColor(value: Expression) {
    if (isColorValue(value.literal)) {
      const { hex, alpha } = value.literal;
      if (alpha === 1) return invoke("color", literal(hex));
      return method(invoke("color", literal(hex)), "withValue", expression(`value => ({ ...value, colorAlpha: ${alpha} })`));
    }
    return method(reified(value), "fmap", expression("({ hex, alpha }) => ({ _type: 'color', color: hex, colorAlpha: alpha })"));
  }

  function read(id: string, output?: string, asImage = false): Expression {
    const node = nodes.get(id);
    if (!node) throw new IncompleteGraph();
    const key = keyFor(id, output);
    const renderColor = asImage && outputType(graph, node, output) === "color";
    const cacheKey = renderColor ? `${key}:image` : key;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    if (visiting.has(cacheKey)) throw new IncompleteGraph();
    visiting.add(cacheKey);
    try {
      let result: Expression | undefined;
      if (renderColor && node.kind === "color" && modeFor(node)?.id === "pattern" && !inputs.get(id)?.has("pattern")) {
        const pattern = node.data.pattern ?? inputsFor(graph, node)[0]?.default;
        if (typeof pattern === "string" && !pattern.includes(":") &&
            miniTokens(pattern).every(token => token === "~" || token === "-" || colorFromCss(token)?.alpha === 1)) {
          result = invoke("color", expression(JSON.stringify(pattern)));
        }
      }
      if (!result && renderColor) result = imageColor(read(id, output));
      if (!result) {
        result = isPixelOutput(graph, node, output) ? fallback(node, output) : translate(node, output) ?? fallback(node, output);
      }
      if (result.literal === undefined && (counts.get(key) ?? 0) > 1 && (result.methods.length || result.source.includes("("))) {
        const name = `pattern${++variableIndex}`;
        statements.push(`const ${name} = ${format(result, "\n  ")}`);
        result = expression(name);
      }
      cache.set(cacheKey, result);
      return result;
    } finally { visiting.delete(cacheKey); }
  }

  function translate(node: GraphNode, output?: string): Expression | undefined {
    const sockets = inputsFor(graph, node);
    const incoming = inputs.get(node.id);
    const mode = modeFor(node)?.id;
    const input = (id: string) => {
      const socket = sockets.find(item => item.id === id);
      if (!socket) return;
      const edge = incoming?.get(id);
      const data = node.data[id] ?? socket.default;
      const value = edge ? read(edge.from, edge.output, socket.type === "visual" || edge.legacyTextInput === true)
        : data !== undefined ? literal(data) : undefined;
      if (!value || !socket.unitInterval) return value;
      return typeof value.literal === "number" ? literal(clampUnit(value.literal))
        : method(reified(value), "withValue", expression("value => Math.max(0, Math.min(1, Number(value)))"));
    };
    const required = (id: string) => {
      const value = input(id);
      if (!value) throw new IncompleteGraph();
      return value;
    };
    const image = () => required("image");
    const effect = (name: string, ...args: (Expression | undefined)[]) => method(image(), name, ...args);
    const signal = (name: string, ...args: Expression[]) => method(reified(required("signal")), name, ...args);
    const value = () => required("value");

    if (isFontVariation(node.kind)) {
      let result = image();
      for (const { id } of sockets) {
        if (id === "image") continue;
        const setting = input(id);
        if (!setting) continue;
        if (id === "scaleY") result = method(result, "scaleY", setting);
        else if (id === "enabled") result = method(result, "fontAxis", literal("ital"), numericBoolean(setting));
        else result = method(result, "fontAxis", literal(id), setting);
      }
      return result;
    }

    switch (node.kind) {
      case "media":
      case "texture": {
        const medium = media.find(entry => entry.id === node.data.media);
        if (!medium || medium.unavailable) return;
        nativeMedia.add(medium);
        const name = medium.name;
        return invoke("s", /^[\w.-]+$/.test(name) && Number.isNaN(Number(name))
          ? expression(JSON.stringify(name)) : invoke("pure", literal(name)));
      }
      case "screen": {
        const pattern = required("pattern");
        const tokens = typeof pattern.literal === "string" ? new Set(miniTokens(pattern.literal)) : undefined;
        for (const entry of media) if (!tokens || tokens.has(entry.name)) nativeMedia.add(entry);
        return invoke("s", typeof pattern.literal === "string" ? expression(JSON.stringify(pattern.literal)) : pattern);
      }
      case "testCard": {
        const strips = testCardStrips.map(({ colors, y, height }) =>
          `  ...${codeLiteral(colors)}.map((shade, i, colors) => color(shade).x((i + 0.5) / colors.length).y(${y}).width(1 / colors.length).height(${height}))`);
        return expression(`stack(\n${strips.join(",\n")}\n)`);
      }
      case "color": return mode === "solid" ? required("color") : undefined;
      case "constant":
      case "tempo": return value();
      case "variable": {
        const setter = setters.get(node.data.variable);
        if (!setter || !graph.variables.some(item => item.id === node.data.variable)) return;
        return setter.id === node.id ? value() : read(setter.id, output);
      }
      case "waveform": return expression(mode ?? "sine");
      case "rand": return expression("rand");
      case "fft": return expression(`fft.${fftBands.includes(node.data.band as Band) ? node.data.band : "bass"}`);
      case "numberPattern": {
        const pattern = required("pattern");
        if (typeof pattern.literal !== "string") return method(pattern, "withValue", expression("value => Number(value) || 0"));
        const sequence = expression(JSON.stringify(pattern.literal));
        const numeric = !pattern.literal.includes(":") && miniTokens(pattern.literal).every(token =>
          token === "~" || token === "-" || Number.isFinite(Number(token)));
        return numeric ? sequence
          : method(sequence, "withValue", expression("value => Number(value) || 0"));
      }
      case "choose": {
        const choices = required("choices").literal;
        if (typeof choices !== "string") return;
        const numbers = choices.trim().split(/[\s,]+/).filter(Boolean).map(Number);
        if (numbers.length && numbers.every(Number.isFinite)) return invoke("choose", ...numbers.map(literal));
        return;
      }
      case "expression": return arithmetic(mode, required("a"), required("b"));
      case "convert": {
        switch (mode) {
          case "booleanToFloat": return numericBoolean(required("boolean"));
          case "floatToBoolean": {
            const number = required("float");
            return number.literal !== undefined ? literal(Boolean(number.literal)) : method(number, "withValue", expression("Boolean"));
          }
          case "floatToString":
          case "booleanToString": {
            const scalar = required(mode === "floatToString" ? "float" : "boolean");
            return scalar.literal !== undefined ? literal(String(scalar.literal)) : method(scalar, "withValue", expression("String"));
          }
          case "stringToImage":
          case "stringToText": return invoke("text", required("text"));
          default: return;
        }
      }
      case "range": return signal("range", required("min"), required("max"));
      case "segment": return signal("segment", value());
      case "signalRate": return signal(mode === "slow" ? "slow" : "fast", value());
      case "lerp": return signal("lerp");
      case "speed": case "late": case "grey": case "brightness": case "contrast": case "pixelate": case "blur": case "barrel":
        return effect(node.kind, value());
      case "sync": return mode === "stack" ? effect("syncStack", bounded(value(), 128)) : effect("sync");
      case "reverse": return effect("rev");
      case "chop": return effect("chop", bounded(value(), 128));
      case "chance": {
        if (mode === "fast") return effect("rarely", invoke("fast", value()));
        if (mode === "reverse") return effect("someCycles", expression("rev"));
        let result = image();
        const y = input("y"), x = input("x");
        if (y) result = method(result, "sometimes", invoke("croph", y));
        if (x) result = method(result, "sometimes", invoke("cropw", x));
        return result;
      }
      case "stack": return mode === "repeat" ? effect("stackN", bounded(value(), 128)) : method(image(), "stack", required("second"));
      case "index": return mode === "shuffle" ? effect("shuffleIndex", input("seed")) : effect("index");
      case "grid": {
        const rows = bounded(input("rows"), 64), cols = bounded(input("columns"), 64);
        return mode === "dimensions" ? method(effect("rows", rows), "cols", cols) : effect("gridMod", rows, cols);
      }
      case "position": return method(effect("x", required("x")), "y", required("y"));
      case "size": return method(effect("width", required("x")), "height", required("y"));
      case "scroll": return effect("scroll", required("x"), required("y"));
      case "scale": {
        const x = input("x"), y = input("y");
        return x || y ? method(effect("scaleX", x ?? value()), "scaleY", y ?? value()) : effect("scale", value());
      }
      case "rotate": {
        let result = effect("rotateZ", value());
        const x = input("x"), y = input("y");
        if (x) result = method(result, "rotateX", x);
        if (y) result = method(result, "rotateY", y);
        return result;
      }
      case "fit": return effect("objectfit", required("mode"));
      case "blend": {
        const main = image();
        const second = input("second"), blend = required("mode");
        return second ? hiddenLayer(invoke("stack", main, method(second, "blend", blend))) : method(main, "blend", blend);
      }
      case "renderLayer": return hiddenLayer(image(), node.data.name);
      case "alpha": {
        if (mode === "white" || mode === "black") return effect("lumaToAlpha", literal(mode));
        const edge = incoming?.get("value");
        const source = edge && nodes.get(edge.from);
        if (edge && source && isPixelOutput(graph, source, edge.output)) return;
        return effect("alpha", value());
      }
      case "hue": return effect("huerot", value());
      case "modulate": case "matte": return effect(node.kind, required("texture"), value());
      case "colorRamp": {
        const stops = rampStops(node);
        const factor = incoming?.get("factor");
        const source = factor && nodes.get(factor.from);
        if (output === "mask" || (factor && (output === "alpha" || (source && isPixelOutput(graph, source, factor.output)))) ||
            stops.some(stop => incoming?.has(stop.id))) return;
        const gradient = { interpolation: rampInterpolation(node), stops: stops.map(({ id, position }) => {
          const color = required(id).literal;
          if (!isColorValue(color)) throw new IncompleteGraph();
          return { position, color: color.hex, alpha: color.alpha };
        }) };
        if (output === "alpha") return literal(gradientSampler(gradient)(Number(required("factor").literal))[3]);
        const image = input("image");
        return image ? method(method(image, "colorRamp", invoke("pure", expression(codeLiteral(gradient)))), "render")
          : invoke("pure", expression(codeLiteral({ _type: "gradient", gradient })));
      }
      case "text": return invoke("text", required("content"));
      case "textStyle": {
        const color = input("color");
        if (color && !isColorValue(color.literal) && typeof color.literal !== "string") return;
        let result = image();
        const family = input("family"), size = input("size");
        if (family) result = method(result, "font", family);
        if (size) result = method(result, "fontSize", size);
        if (color) {
          const css = isColorValue(color.literal) ? colorCss(color.literal) : String(color.literal);
          const param = isColorValue(color.literal) && color.literal.alpha !== 1 ? invoke("pure", literal(css)) : literal(css);
          result = method(result, "fontColor", param);
        }
        return result;
      }
      case "fontAxis":
      case "fontCustomAxis": {
        const enabled = input("enabled");
        if (enabled) return effect("fontAxis", literal("ital"), numericBoolean(enabled));
        const tag = required("tag");
        return tag.literal === "" ? image() : effect("fontAxis", tag, value());
      }
      case "output": return image();
      default: return;
    }
  }

  try {
    if (!outputs.length) throw new IncompleteGraph();
    statements.push(format(invoke("setCpm", tempo ? read(tempo.id) : literal(CYCLES_PER_SECOND * 60))));
    outputs.forEach((node, index) => {
      const output = `$: ${format(read(node.id), "\n  ")}`;
      const note = index > 0 && coversCanvas(node)
        ? `// Layer ${index + 1} covers the earlier outputs. For a background, put this layer first.\n` : "";
      statements.push(note + output);
    });
  } catch (error) {
    if (!(error instanceof IncompleteGraph)) throw error;
    return `${graphCall("nodeGraph", draft, media)}\n`;
  }

  const setup = [...nativeMedia].filter(portableMedia).map(entry =>
    format(invoke(entry.type === "image" ? "loadImage" : "loadVideo", literal(entry.name), literal(entry.url))));
  if (fallbackNodes.size) {
    const fragment = {
      nodes: graph.nodes.filter(node => fallbackNodes.has(node.id)).map(node => ({ ...node, x: 0, y: 0 })),
      edges: graph.edges.filter(edge => fallbackNodes.has(edge.from) && fallbackNodes.has(edge.to)),
      variables: graph.variables.filter(item => fallbackVariables.has(item.id)),
    };
    setup.unshift(`const readNode = ${graphCall("nodeGraphValues", fragment, media)}`);
  }
  return `${[setup.join("\n"), ...statements].filter(Boolean).join("\n\n")}\n`;
}

function numericBoolean(value: Expression) {
  return value.literal !== undefined ? literal(Number(value.literal)) : method(value, "withValue", expression("Number"));
}

function arithmetic(mode: string | undefined, a: Expression, b: Expression) {
  const operation = expressionOperations.find(item => item.id === mode) ?? expressionOperations[0];
  if (typeof a.literal === "number" && typeof b.literal === "number") {
    const result = operation.evaluate(a.literal, b.literal);
    if (Number.isFinite(result)) return literal(result);
  }
  const formula = (left: string, right: string) => {
    switch (operation.id) {
      case "add": return `Number(${left}) + Number(${right})`;
      case "subtract": return `Number(${left}) - Number(${right})`;
      case "multiply": return `Number(${left}) * Number(${right})`;
      case "divide": return `Number(${right}) === 0 ? 0 : Number(${left}) / Number(${right})`;
      case "remainder": return `Number(${right}) === 0 ? 0 : Number(${left}) % Number(${right})`;
      default: return `Math.${operation.id}(${left}, ${right})`;
    }
  };
  if (b.literal !== undefined) return method(reified(a), "withValue", expression(`a => ${formula("a", format(b))}`));
  if (a.literal !== undefined) return method(b, "withValue", expression(`b => ${formula(format(a), "b")}`));
  return method(method(a, "withValue", expression(`a => b => ${formula("a", "b")}`)), "appBoth", b);
}
