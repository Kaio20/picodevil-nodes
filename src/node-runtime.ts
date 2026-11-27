import { Pattern, pure, reify, sine, cosine, saw, tri, stack, silence } from "@strudel/core";
import { mini } from "@strudel/mini";
import { color } from "./color-pattern";
import { s } from "./screen-pattern";
import { text } from "./text-pattern";
import { choose, rand } from "./event-random";
import { stackN } from "./grid-stack";
import { fft, previewFft } from "./fft-audio";
import { isTexture, resolveMedia, resolveMediaId } from "./media-registry";
import { resolveUrl } from "./server-config";
import { catalogTexture } from "./texture-library";
import { CYCLES_PER_SECOND, getRuntimeCps, setRuntimeCps } from "./config";
import { createMetrics } from "./frame-metrics";
import { FrameRenderer } from "./renderer";
import { WebGLRenderer } from "./webgl-renderer";
import { createVideoPoolManager } from "./video-pool-manager";
import { hashStr, withLayoutCounter } from "./layout-counter";
import { collectScreens, getNamedScreenIndices, nextAutoRenderName, registerAutoHidden, resetRegistry, restoreRegistry, snapshotRegistry } from "./pattern-registry";
import { acceptsPixelField, expressionInputType, expressionOperations, fftBands, inputsFor, isFontVariation, isPixelOutput, isRenderable, isVariableSetter, listInputCount, listInputId, modeFor, outputType, previewType, rampInterpolation, rampStops, signalGraph, testCardStrips, variableFor, VIDEO_TEST_CARD, type Band, type Graph, type GraphEdge, type GraphNode, type Literal } from "./node-graph";
import { gradientSampler, type Gradient } from "./gradient";
import { colorRamp } from "./effects-controls";
import { clampUnit, colorCss, colorFromCss, colorHex, isColorValue, rgbFromHex, rgbHex, whiteColor, type ColorValue } from "./color-value";
import type { PixelExpression, PixelOperator, PixelRaster } from "./pixel-field";
import { index } from "./index-patterns";
import "./shuffle-stack";
import { NodeMotions, NodeTransport, wrapCycle } from "./node-transport";
import { nodeVideoPattern } from "./node-video";

export function mediaUrl(name: string, base: string): string {
  const entry = resolveMedia(name);
  return entry ? resolveUrl(entry.url) : /^(https?:|blob:|data:)/i.test(name) ? name : base + name;
}

function call(pattern: Pattern, method: string, ...args: unknown[]): Pattern {
  return pattern[method](...args);
}

function makeTestCard(): Pattern {
  return stack(...testCardStrips.flatMap(({ colors, y, height }) => colors.map((value, i) =>
    call(call(call(call(color(value), "x", (i + 0.5) / colors.length), "y", y), "width", 1 / colors.length), "height", height))));
}

class PixelField {
  constructor(readonly signal: Pattern) {}

  map(fn: (value: PixelExpression) => PixelExpression) {
    return new PixelField(this.signal.withValue(fn));
  }
}

type UniformValue = Pattern | Literal;
type Value = UniformValue | PixelField;
type PreviewValue = { layer: string } | { value: Value } | { error: string };
const sceneSource = /(?:^|[\s<\[,(])(?:all|prev)(?=$|[\s>\],):*?!/@])/;
const waveforms: Record<string, Pattern> = { sine, cosine, saw, tri };
const rampPreview = "rampPreview";

function solidImage(value: Value): Pattern {
  return reify(value).fmap(({ hex, alpha }: ColorValue) => ({ _type: "color", color: hex, colorAlpha: alpha }));
}

function renderLayer(id: string, image: Pattern): Pattern {
  const name = `__auto_layer_${id}`;
  registerAutoHidden(name, image);
  return pure({ _type: "pattern", src: name });
}

function bounded(value: Value, max: number): Pattern {
  return reify(value).fmap((item: unknown) => Math.max(1, Math.min(max, Math.round(Number(item)) || 1)));
}

function mapScalar<T extends Literal>(value: UniformValue, convert: (item: unknown) => T): UniformValue {
  return value instanceof Pattern ? value.withValue(convert) : convert(value);
}

function fieldMath(operator: PixelOperator, a: Value, b: Value): PixelField {
  const asField = (value: Value) => value instanceof PixelField ? value.signal : reify(value).withValue(Number);
  return new PixelField(asField(a).withValue((a: PixelExpression) => (b: PixelExpression): PixelExpression =>
    ({ kind: "math", operator, a, b })).appBoth(asField(b)));
}

function bakeImage(image: Pattern) {
  const layer = nextAutoRenderName();
  registerAutoHidden(layer, image);
  return layer;
}

function imageField(image: Pattern, channel: "luma" | "alpha"): PixelField {
  const value: PixelExpression = { kind: "image", layer: bakeImage(image), channel };
  return new PixelField(pure(value));
}

function fieldRaster(field: PixelField, ramp?: Pattern): Pattern {
  const raster = ramp ? field.signal.withValue((value: PixelExpression) => (gradient: Gradient): PixelRaster =>
    ({ value, gradient })).appBoth(ramp) : field.signal.withValue((value: PixelExpression): PixelRaster => ({ value }));
  return raster.withValue((raster: PixelRaster) => ({ _type: "pixelField", raster }));
}

function fieldImage(field: PixelField, ramp?: Pattern): Pattern {
  return pure({ _type: "pattern", src: bakeImage(fieldRaster(field, ramp)) });
}

const pixelBoolean = (value: PixelExpression): PixelExpression => ({ kind: "boolean", value });
const transparent = { hex: "#000000", alpha: 0 };

function grayColor(value: unknown): ColorValue {
  const gray = clampUnit(Number(value) || 0);
  return { hex: rgbHex([gray, gray, gray]), alpha: 1 };
}

function colorBrightness({ hex, alpha }: ColorValue): number {
  const [r, g, b] = rgbFromHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) * alpha;
}

function convertValue(mode: string | undefined, value: Value): Value {
  if (value instanceof PixelField) {
    if (mode === "floatToImage" || mode === "booleanToImage") return fieldImage(value);
    return mode === "floatToBoolean" ? value.map(pixelBoolean) : value;
  }
  const asText = () => mapScalar(value, item => isColorValue(item) ? colorHex(item) : String(item));
  switch (mode) {
    case "imageToFloat": return imageField(value as Pattern, "luma");
    case "imageToBoolean": return imageField(value as Pattern, "luma").map(pixelBoolean);
    case "imageAlphaToFloat": return imageField(value as Pattern, "alpha");
    case "floatToBoolean": return mapScalar(value, Boolean);
    case "booleanToFloat": return mapScalar(value, Number);
    case "floatToString":
    case "booleanToString":
    case "colorToString": return asText();
    case "stringToFloat": return mapScalar(value, item => Number.isFinite(Number(item)) ? Number(item) : 0);
    case "stringToBoolean": return mapScalar(value, item => !["", "0", "false", "off", "no"].includes(String(item).trim().toLowerCase()));
    case "stringToColor": return mapScalar(value, item => colorFromCss(String(item)) ?? transparent);
    case "floatToColor":
    case "booleanToColor": return mapScalar(value, grayColor);
    case "colorToFloat": return mapScalar(value, color => colorBrightness(color as ColorValue));
    case "colorToBoolean": return mapScalar(value, color => Boolean(colorBrightness(color as ColorValue)));
    case "textToString": return (value as Pattern).withValue((item: { text?: string }) => item.text ?? "");
    case "floatToImage":
    case "booleanToImage": return solidImage(mapScalar(value, grayColor));
    case "stringToImage":
    case "stringToText":
    case "floatToText":
    case "booleanToText":
    case "colorToText": return text(asText() as string | Pattern) as Pattern;
    default: throw new Error("Choose a conversion mode.");
  }
}

function numberChoices(value: unknown): number[] {
  const choices = String(value).trim().split(/[\s,]+/).filter(Boolean).map(Number);
  return choices.every(Number.isFinite) ? choices : [];
}

function addColors(a: unknown, b: unknown): ColorValue {
  const rgb = (value: unknown) => isColorValue(value) ? rgbFromHex(value.hex) : [Number(value), Number(value), Number(value)];
  const left = rgb(a);
  const right = rgb(b);
  const alpha = (isColorValue(a) ? a.alpha : 0) + (isColorValue(b) ? b.alpha : 0);
  return { hex: rgbHex([clampUnit(left[0] + right[0]), clampUnit(left[1] + right[1]), clampUnit(left[2] + right[2])]), alpha: clampUnit(alpha) };
}

interface RuntimeContext {
  transport: NodeTransport;
  motions: NodeMotions;
  incoming: Map<string, GraphEdge>;
  nodes: Map<string, GraphNode>;
}

function buildValues(
  graph: Graph, preview: boolean,
  transport = new NodeTransport(graph.tempo === undefined ? CYCLES_PER_SECOND : graph.tempo / 60), motions = new NodeMotions(),
) {
  const values = new Map<string, Value>();
  const visiting = new Set<string>();
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map(graph.edges.map(edge => [edge.to + ":" + edge.input, edge]));
  const setters = new Map(graph.nodes.filter(node => isVariableSetter(graph, node)).map(node => [node.data.variable, node]));
  const read = (id: string, output?: string): Value => {
    const key = JSON.stringify([id, output]);
    const cached = values.get(key);
    if (cached !== undefined) return cached;
    const node = nodes.get(id);
    if (!node) throw new Error("A connected node is missing.");
    if (visiting.has(id)) throw new Error("This connection creates a cycle.");
    visiting.add(id);
    try {
      const factorEdge = node.kind === "colorRamp" && output !== "alpha" && output !== rampPreview
        ? incoming.get(node.id + ":factor") : undefined;
      const factorSource = factorEdge && nodes.get(factorEdge.from);
      const spatialFactor = factorSource && isPixelOutput(graph, factorSource, factorEdge.output);
      const inputs = Object.fromEntries(inputsFor(graph, node).flatMap(socket => {
        const source = incoming.get(node.id + ":" + socket.id);
        if (node.kind === "colorRamp" && socket.id === "factor" && (output === rampPreview || (output !== "alpha" && !spatialFactor))) return [];
        if (node.kind === "colorRamp" && socket.id === "image" && (output === rampPreview || output === "alpha" || spatialFactor)) return [];
        if (node.kind === "variable" && !source) return [];
        let value = source ? read(source.from, source.output) : node.data[socket.id] ?? socket.default;
        if (source && (socket.type === "visual" || source.legacyTextInput) && outputType(graph, nodes.get(source.from)!, source.output) === "color") {
          value = solidImage(value!);
        }
        if (value !== undefined) {
          if (value instanceof PixelField) {
            if (!acceptsPixelField(node, socket.id)) throw new Error(`${socket.label} needs one value for the whole frame.`);
            if (socket.unitInterval) value = value.map(item => ({ kind: "clamp", value: item }));
            return [[socket.id, value] as const];
          }
          // withValue preserves per-event sampling for random signal sources.
          if (socket.unitInterval) value = reify(value).withValue((item: unknown) => clampUnit(Number(item)));
          return [[socket.id, value] as const];
        }
        if (socket.optional) return [];
        throw new Error(`${socket.label} needs a connection.`);
      }));
      const value = withLayoutCounter(hashStr(node.id), () => buildNode(node, inputs, graph, preview, setters, read, { transport, motions, incoming, nodes }, output));
      values.set(key, value);
      return value;
    } finally { visiting.delete(id); }
  };
  return read;
}

function buildNode(
  node: GraphNode, input: Record<string, Value>, graph: Graph, preview: boolean,
  setters: Map<Literal, GraphNode>, read: (id: string) => Value, context: RuntimeContext, output?: string,
): Value {
  const image = input.image as Pattern;
  if (isFontVariation(node.kind)) {
    let styled = image;
    for (const [tag, value] of Object.entries(input)) {
      if (tag === "image") continue;
      if (tag === "scaleY") styled = call(styled, "scaleY", value);
      else if (tag === "enabled") styled = call(styled, "fontAxis", "ital", reify(value).fmap(Number));
      else styled = call(styled, "fontAxis", tag, value);
    }
    return styled;
  }
  const mode = modeFor(node)?.id;
  const wrapTime = (value: Value) => context.motions.isTime(value) ? value.withValue(wrapCycle) : value;
  switch (node.kind) {
    case "time": return output === "rate" ? context.transport.rateSignal : context.motions.time;
    case "video": return nodeVideoPattern(node.id, Array.from({ length: listInputCount(node) }, (_, i) =>
      input[listInputId("video", i)] as string | Pattern ?? ""), mode ?? "clipEnd", context.transport);
    case "media":
    case "texture": {
      const mediaId = String(node.data.media ?? "");
      const texture = node.kind === "texture";
      if (texture && (!mediaId || mediaId === VIDEO_TEST_CARD)) return makeTestCard();
      const catalog = texture && preview && catalogTexture(mediaId);
      if (catalog) return pure({ _type: "image", src: catalog.url, begin: 0, end: 1 });
      const resolveSource = () => {
        const entry = resolveMediaId(mediaId);
        return entry && (!texture || isTexture(entry)) ? entry : undefined;
      };
      const medium = resolveSource();
      if (!medium || medium.unavailable) throw new Error(texture ? "Choose an available texture." : "Choose an available medium.");
      // Resolve by ID at query time so renaming the source also updates the live graph.
      return pure(mediaId).fmap(() => {
        const entry = resolveSource();
        return entry ? { _type: entry.type, src: entry.name, begin: 0, end: 1 } : { _type: "color", color: "black" };
      });
    }
    case "testCard": return makeTestCard();
    case "constant": return input.value;
    case "expression": {
      const { id, evaluate } = expressionOperations.find(operation => operation.id === mode) ?? expressionOperations[0];
      const { a, b } = input;
      if (id === "add") {
        const leftType = expressionInputType(graph, node, "a");
        const rightType = expressionInputType(graph, node, "b");
        const leftImage = isRenderable(leftType);
        const rightImage = isRenderable(rightType);
        if (leftImage || rightImage) {
          if (a instanceof PixelField || b instanceof PixelField) throw new Error("Image addition needs an image, color, or uniform number.");
          if (leftImage && (rightImage || rightType === "color")) return renderLayer(node.id, stack(a, call(rightImage ? b as Pattern : solidImage(b), "blend", "add")));
          if (rightImage && leftType === "color") return renderLayer(node.id, stack(solidImage(a), call(b as Pattern, "blend", "add")));
          const composite = renderLayer(node.id, (leftImage ? a : b) as Pattern);
          return call(composite, "brightness", leftImage ? b : a);
        }
        if (leftType === "color" || rightType === "color") {
          if (a instanceof PixelField || b instanceof PixelField) throw new Error("Color addition needs a color or uniform number.");
          if (!(a instanceof Pattern) && !(b instanceof Pattern)) return addColors(a, b);
          if (!(a instanceof Pattern)) return b.withValue((right: unknown) => addColors(a, right));
          if (!(b instanceof Pattern)) return a.withValue((left: unknown) => addColors(left, b));
          return a.withValue((left: unknown) => (right: unknown) => addColors(left, right)).appBoth(b);
        }
        const type = outputType(graph, node);
        if (type === "visual") return silence;
        if (type === "color") return transparent;
      }
      if (a instanceof PixelField || b instanceof PixelField) return fieldMath(id, a, b);
      if (id === "multiply" && context.motions.isTime(a) !== context.motions.isTime(b)) {
        const timeInput = context.motions.isTime(a) ? "a" : "b";
        const factorInput = timeInput === "a" ? "b" : "a";
        const timeEdge = context.incoming.get(`${node.id}:${timeInput}`);
        const factorEdge = context.incoming.get(`${node.id}:${factorInput}`);
        const constant = factorEdge && context.nodes.get(factorEdge.from);
        const editable = !factorEdge ? `${node.id}:${factorInput}` : constant?.kind === "constant" &&
          !context.incoming.has(`${constant.id}:value`) ? `${constant.id}:value` : undefined;
        const factor = input[factorInput];
        return context.motions.multiply(`${node.id}:${timeInput}:${timeEdge?.from ?? ""}`, input[timeInput] as Pattern,
          factor instanceof Pattern ? factor : Number(factor), editable);
      }
      if (!(b instanceof Pattern)) return mapScalar(a, left => evaluate(Number(left), Number(b)));
      if (!(a instanceof Pattern)) return mapScalar(b, right => evaluate(Number(a), Number(right)));
      return a.withValue((left: unknown) => (right: unknown) => evaluate(Number(left), Number(right))).appBoth(b);
    }
    case "convert": return convertValue(mode, input[modeFor(node)!.inputs![0].id]);
    case "screen": {
      const expression = input.pattern instanceof Pattern ? input.pattern : String(input.pattern);
      if (preview && typeof expression === "string" && sceneSource.test(expression)) throw new Error("This source uses the full scene. Run to see it in Output.");
      return s(expression) as Pattern;
    }
    case "color": {
      if (mode !== "pattern") return input.color;
      const palette = new Map<string, ColorValue>();
      const pattern = typeof input.pattern === "string" ? mini(input.pattern) : reify(input.pattern);
      return pattern.fmap((value: unknown) => {
        const name = String(value);
        const color = palette.get(name) ?? colorFromCss(name) ?? whiteColor;
        palette.set(name, color);
        return color;
      });
    }
    case "colorRamp": {
      const stops = rampStops(node);
      const interpolation = rampInterpolation(node);
      let palette = pure([] as ColorValue[]);
      for (const { id } of stops) {
        const value = input[id];
        if (value instanceof Pattern) {
          palette = palette.fmap((colors: ColorValue[]) => (color: ColorValue) => [...colors, color]).appBoth(value);
        } else {
          if (!isColorValue(value)) throw new Error("Choose a valid color.");
          palette = palette.fmap((colors: ColorValue[]) => [...colors, value]);
        }
      }
      let previous: Gradient | undefined;
      const ramp = palette.fmap((colors: ColorValue[]): Gradient => {
        if (previous?.stops.every((stop, index) => stop.color === colors[index].hex && stop.alpha === colors[index].alpha)) return previous;
        previous = { interpolation, stops: stops.map(({ position }, index) => ({
          position, color: colors[index].hex, alpha: colors[index].alpha,
        })) };
        return previous;
      });
      const { factor } = input;
      if (factor instanceof PixelField && (output === "alpha" || output === "mask")) {
        return new PixelField(ramp.fmap((gradient: Gradient) => (value: PixelExpression): PixelExpression =>
          ({ kind: "rampAlpha", gradient, value })).appBoth(factor.signal));
      }
      if (output !== "alpha") {
        const result = factor instanceof PixelField ? fieldImage(factor, ramp)
          : image ? call(colorRamp(ramp, image), "render")
          : ramp.fmap((gradient: Gradient) => ({ _type: "gradient", gradient }));
        return output === "mask" ? imageField(result, "alpha") : result;
      }
      let sampled: Gradient | undefined;
      let sample: ReturnType<typeof gradientSampler>;
      return ramp.fmap((gradient: Gradient) => {
        if (sampled !== gradient) { sample = gradientSampler(gradient); sampled = gradient; }
        const current = sample;
        return (factor: number) => current(factor)[3];
      }).appBoth(reify(factor));
    }
    case "waveform": return waveforms[mode ?? "sine"];
    case "rand": return rand;
    case "fft": {
      const band = fftBands.includes(node.data.band as Band) ? node.data.band as Band : "bass";
      return preview ? previewFft(band) : fft[band];
    }
    case "numberPattern": {
      const pattern = input.pattern instanceof Pattern ? input.pattern : mini(String(input.pattern)) as Pattern;
      return pattern.withValue((value: unknown) => Number(value) || 0);
    }
    case "range": {
      const { signal, min, max } = input;
      if ([signal, min, max].some(value => value instanceof PixelField)) {
        return fieldMath("add", min, fieldMath("multiply", signal, fieldMath("subtract", max, min)));
      }
      return call(reify(signal), "range", min, max);
    }
    case "choose": {
      if (input.choices instanceof Pattern) {
        return input.choices.withValue((value: unknown) => {
          const choices = numberChoices(value);
          return choices.length ? choose(...choices) : silence;
        }).innerJoin();
      }
      const choices = numberChoices(input.choices);
      if (!choices.length) throw new Error("Enter numbers separated by commas.");
      return choose(...choices);
    }
    case "segment": return call(reify(input.signal), "segment", input.value);
    case "signalRate": return call(reify(input.signal), mode === "slow" ? "slow" : "fast", input.value);
    case "lerp": return call(reify(input.signal), "lerp");
    case "tempo": return input.value;
    case "speed": return call(image, "speed", input.value);
    case "sync": return mode === "stack" ? call(image, "syncStack", bounded(input.value, 128)) : call(image, "sync");
    case "reverse": return call(image, "rev");
    case "chop": return call(image, "chop", bounded(input.value, 128));
    case "late": return call(image, "late", input.value);
    case "chance": {
      if (mode === "fast") return call(image, "rarely", (pattern: Pattern) => call(pattern, "fast", input.value));
      if (mode === "reverse") return call(image, "someCycles", (pattern: Pattern) => call(pattern, "rev"));
      let cropped = image;
      if (input.y !== undefined) cropped = call(cropped, "sometimes", (pattern: Pattern) => call(pattern, "croph", input.y));
      if (input.x !== undefined) cropped = call(cropped, "sometimes", (pattern: Pattern) => call(pattern, "cropw", input.x));
      return cropped;
    }
    case "stack": return mode === "repeat" ? stackN(bounded(input.value, 128), image) : stack(image, input.second);
    case "index": {
      const images = Array.from({ length: listInputCount(node) }, (_, i) => input[listInputId("index", i)] as Pattern).filter(Boolean);
      if (!images.length) throw new Error("Connect an image to Index.");
      return mode === "shuffle" ? call(images.length === 1 ? images[0] : stack(...images), "shuffleIndex", input.seed) : index(...images);
    }
    case "grid": {
      const rows = input.rows === undefined ? undefined : bounded(input.rows, 64);
      const columns = input.columns === undefined ? undefined : bounded(input.columns, 64);
      return mode === "dimensions" ? call(call(image, "rows", rows), "cols", columns) : call(image, "gridMod", rows, columns);
    }
    case "position": return call(call(image, "x", input.x), "y", input.y);
    case "size": return call(call(image, "width", input.x), "height", input.y);
    case "scroll": return call(image, "scroll", wrapTime(input.x), wrapTime(input.y));
    case "scale": return call(call(image, "scaleX", input.x ?? input.value), "scaleY", input.y ?? input.value);
    case "rotate": {
      let rotated = call(image, "rotateZ", wrapTime(input.value));
      if (input.x !== undefined) rotated = call(rotated, "rotateX", wrapTime(input.x));
      if (input.y !== undefined) rotated = call(rotated, "rotateY", wrapTime(input.y));
      return rotated;
    }
    case "fit": return call(image, "objectfit", input.mode);
    case "blend": {
      if (input.second === undefined) return call(image, "blend", input.mode);
      const overlay = call(input.second as Pattern, "blend", input.mode);
      return renderLayer(node.id, stack(image, overlay));
    }
    case "renderLayer": return renderLayer(node.id, image);
    case "alpha":
      if (mode === "white" || mode === "black") return call(image, "lumaToAlpha", mode);
      if (input.value instanceof PixelField) {
        const opacityFieldSrc = bakeImage(fieldRaster(input.value));
        return image.withValue((value: object) => ({ ...value, opacityFieldSrc }));
      }
      return call(image, "alpha", input.value);
    case "hue": return call(image, "huerot", input.value);
    case "grey": return call(image, "grey", input.value);
    case "brightness": return call(image, "brightness", input.value);
    case "contrast": return call(image, "contrast", input.value);
    case "pixelate": return call(image, "pixelate", input.value);
    case "blur": return call(image, "blur", input.value);
    case "barrel": return call(image, "barrel", input.value);
    case "modulate": return call(image, "modulate", input.texture, input.value);
    case "matte": return call(image, "matte", input.texture, input.value);
    case "text": return text(input.content as Parameters<typeof text>[0]) as Pattern;
    case "textStyle": {
      let styled = image;
      if (input.family !== undefined) styled = call(styled, "font", input.family);
      if (input.size !== undefined) styled = call(styled, "fontSize", input.size);
      if (input.color !== undefined) styled = call(styled, "fontColor", reify(input.color).fmap((value: unknown) =>
        isColorValue(value) ? colorCss(value) : value));
      return styled;
    }
    case "fontAxis":
    case "fontCustomAxis": {
      if (input.enabled !== undefined) return call(image, "fontAxis", "ital", reify(input.enabled).fmap(Number));
      return input.tag === "" ? image : call(image, "fontAxis", input.tag, input.value);
    }
    case "variable": {
      if (!variableFor(graph, node)) throw new Error("Choose a variable.");
      const setter = setters.get(node.data.variable);
      if (input.value !== undefined) {
        if (setter !== node) throw new Error("Use one Set node per variable.");
        return input.value;
      }
      if (!setter) throw new Error("Connect an input to a Variable node for this variable.");
      return read(setter.id);
    }
    case "output": return image;
    case "junction":
    case "cableEnd": throw new Error("A cable point cannot be evaluated directly.");
  }
}

function previewKey(target: PreviewTarget) { return JSON.stringify([target.id, Boolean(target.showRamp)]); }

function registerGraph(draft: Graph, targets?: readonly PreviewTarget[], transport?: NodeTransport, motions = new NodeMotions()) {
  const graph = signalGraph(draft);
  const previews = new Map<string, PreviewValue>();
  const read = buildValues(graph, targets !== undefined, transport, motions);
  let tempo: Value = graph.tempo ?? CYCLES_PER_SECOND * 60;
  const tempoNode = graph.nodes.filter(node => node.kind === "tempo").at(-1);
  if (tempoNode) {
    try { tempo = read(tempoNode.id); }
    catch (error) { if (!targets) throw error; }
  }
  if (targets) {
    for (const target of targets) {
      const { id } = target;
      const key = previewKey(target);
      const node = graph.nodes.find(item => item.id === id);
      if (!node) continue;
      try {
        const value = read(id, target.showRamp ? rampPreview : undefined);
        if (value instanceof PixelField || (!target.showRamp && isRenderable(previewType(graph, node)))) {
          const layer = `__auto_preview_${id}`;
          registerAutoHidden(layer, value instanceof PixelField ? fieldRaster(value) : value as Pattern);
          previews.set(key, { layer });
        } else previews.set(key, { value });
      } catch (error) {
        previews.set(key, { error: error instanceof Error ? error.message : String(error) });
      }
    }
  } else {
    const outputs = graph.nodes.filter(node => node.kind === "output");
    if (!outputs.length) throw new Error("Add an Output node to run this graph.");
    for (const node of outputs) call(read(node.id) as Pattern, "p", "$");
  }
  motions.finish();
  return { tempo: tempo as number | Pattern, previews };
}

function compile(draft: Graph, targets?: readonly PreviewTarget[], transport?: NodeTransport, motions = new NodeMotions()) {
  const previous = snapshotRegistry();
  resetRegistry();
  try {
    const { tempo, previews } = registerGraph(draft, targets, transport, motions);
    const screens = collectScreens();
    const namedScreens = getNamedScreenIndices();
    return { screens, namedScreens, registry: snapshotRegistry(), tempo, previews, motions };
  } finally { restoreRegistry(previous); }
}

export function compileLiveGraph(graph: Graph, transport?: NodeTransport, motions?: NodeMotions) { return compile(graph, undefined, transport, motions); }

export function registerLiveGraph(graph: Graph) { return registerGraph(graph).tempo; }

export function readLiveGraph(graph: Graph) { return buildValues(signalGraph(graph), false); }

export interface PreviewTarget {
  id: string;
  element: HTMLElement;
  canvas?: HTMLCanvasElement;
  status: HTMLElement;
  samples: number[];
  gradient?: Gradient;
  showRamp?: (gradient?: Gradient) => void;
  color?: string;
}

export class NodePreviews {
  private canvas?: HTMLCanvasElement;
  private renderer?: WebGLRenderer;
  private frameRenderer?: FrameRenderer;
  private pool?: ReturnType<typeof createVideoPoolManager>;
  private transport = new NodeTransport();
  private graph?: Graph;
  private result?: ReturnType<typeof compile>;
  private signature = "";
  private nextFrame = 0;
  private nextBatch = 0;
  private priority?: string;
  private idleSince = 0;
  private unavailable = false;

  draw(graph: Graph, visibleTargets: () => PreviewTarget[], now: number, cycle: number, cps: number, ratio: number, priority?: string) {
    if (now < this.nextFrame) return;
    this.nextFrame = now + 1000 / 15;
    const visible = visibleTargets();
    const focused = priority ?? this.priority;
    this.priority = priority;
    const preferred = focused ? visible.filter(target => target.id === focused) : [];
    const targets = preferred.length ? visible.filter(target => target.id !== focused) : visible;
    if (!visible.length) {
      this.idleSince ||= now;
      if (this.renderer && now - this.idleSince > 5000) this.dispose();
      this.result = undefined;
      return;
    }
    this.idleSince = 0;
    // Rotate the first target so an expensive preview can't consume the budget every tick.
    const start = targets.length ? this.nextBatch % targets.length : 0;
    const budget = 4 - preferred.length;
    const rotating = [...targets.slice(start), ...targets.slice(0, start)];
    const batch = preferred.concat(rotating.slice(0, budget));
    this.nextBatch = start + (targets.length > budget ? budget : 1);
    const signature = batch.map(previewKey).join(",");
    if (!this.result || cycle < this.transport.position) {
      this.transport.reset(now);
      this.result = undefined;
    }
    this.transport.advance(cycle, cps, now);
    if (!this.result || this.graph !== graph || this.signature !== signature) {
      this.graph = graph;
      this.signature = signature;
      this.result = compile(graph, batch, this.transport, new NodeMotions(this.result?.motions, cycle));
    }
    const result = this.result;
    result.motions.advance(cycle);
    const registry = snapshotRegistry();
    const previousCps = getRuntimeCps();
    restoreRegistry(result.registry);
    setRuntimeCps(cps);
    try {
      const hasImages = result.screens.length > 0 && !this.unavailable;
      if (hasImages) {
        this.prepareRenderer(ratio);
        if (!this.renderer?.isContextLost()) this.frameRenderer?.render(result.screens, result.namedScreens, cycle, cps, cycle, now);
      }
      for (const target of batch) this.drawTarget(target, result.previews.get(previewKey(target)), cycle);
    } catch (error) {
      for (const target of batch) target.status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      setRuntimeCps(previousCps);
      restoreRegistry(registry);
    }
  }

  private prepareRenderer(ratio: number) {
    if (!this.renderer) {
      const canvas = document.createElement("canvas");
      // Blitting a single-sample preview target into a multisampled drawing buffer is invalid in WebGL2.
      try { this.renderer = new WebGLRenderer(canvas, { antialias: false, onUnrecoverable: () => this.unavailable = true }); }
      catch { this.unavailable = true; return; }
      this.canvas = canvas;
      this.pool = createVideoPoolManager({
        resolveMediaUrl: (name, base) => {
          const texture = catalogTexture(name);
          return texture ? resolveUrl(texture.url) : mediaUrl(name, base);
        },
        createElement: () => Object.assign(document.createElement("video"), { crossOrigin: "anonymous" }),
        onDestroyElement: el => this.renderer?.releaseSource(el),
        maxFreeTotal: 12,
      });
      this.frameRenderer = new FrameRenderer(this.renderer, this.pool, createMetrics());
      this.frameRenderer.prewarmVideos = false;
      this.frameRenderer.maxDrawTimeMs = 10;
    }
    const width = Math.max(1, Math.round(320 * Math.min(1, ratio)));
    const height = Math.max(1, Math.round(320 / Math.max(1, ratio)));
    if (this.canvas && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.renderer.resize(width, height);
    }
  }

  private drawTarget(target: PreviewTarget, preview: PreviewValue | undefined, cycle: number) {
    if (!preview) return;
    if ("error" in preview) {
      if (target.gradient) target.showRamp?.();
      target.gradient = undefined;
      target.status.textContent = preview.error;
      return;
    }
    if ("layer" in preview) {
      if (this.unavailable) { target.status.textContent = "Image preview unavailable."; return; }
      if (!this.canvas || !target.canvas || this.renderer?.isContextLost() || !this.renderer?.presentLayer(preview.layer)) return;
      if (target.canvas.width !== this.canvas.width || target.canvas.height !== this.canvas.height) {
        target.canvas.width = this.canvas.width;
        target.canvas.height = this.canvas.height;
      }
      const context = target.canvas.getContext("2d")!;
      context.globalCompositeOperation = "copy";
      context.drawImage(this.canvas, 0, 0);
      target.canvas.hidden = false;
      target.samples.length = 0;
      target.status.textContent = "";
      return;
    }
    const dynamic = preview.value instanceof Pattern;
    const value = dynamic ? (preview.value as Pattern).queryArc(cycle, cycle)[0]?.value : preview.value;
    if (isColorValue(value) && target.canvas) {
      const color = colorCss(value);
      if (target.color !== color) {
        const context = target.canvas.getContext("2d")!;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        target.color = color;
      }
      target.canvas.hidden = false;
      target.status.textContent = "";
      return;
    }
    if (target.showRamp) {
      const gradient: Gradient | undefined = value?.gradient;
      if (target.gradient !== gradient) {
        target.showRamp(gradient);
        target.gradient = gradient;
      }
      target.status.textContent = "";
      return;
    }
    target.status.textContent = typeof value === "number" ? String(Number(value.toFixed(3))) : String(value ?? "—");
    if (!target.canvas) return;
    const g = target.canvas.getContext("2d")!;
    if (target.element.dataset.type === "number" && target.canvas.height !== 36) {
      target.canvas.width = 200;
      target.canvas.height = 36;
    }
    const { width, height } = target.canvas;
    g.clearRect(0, 0, width, height);
    target.color = undefined;
    const chart = dynamic && typeof value === "number" && Number.isFinite(value);
    target.canvas.hidden = !chart;
    if (!chart) { target.samples.length = 0; return; }
    target.samples.push(value);
    if (target.samples.length > 80) target.samples.shift();
    const lo = Math.min(0, ...target.samples), hi = Math.max(1, ...target.samples);
    g.beginPath();
    target.samples.forEach((sample, index) => g.lineTo(index / 79 * width, 2 + (hi - sample) / (hi - lo) * (height - 4)));
    g.strokeStyle = getComputedStyle(target.canvas).color;
    g.lineWidth = 1.5;
    g.stroke();
  }

  dispose() {
    if (this.pool && this.frameRenderer) {
      for (const item of this.frameRenderer.activeVideoEls.splice(0)) this.pool.destroyVideoEl(item);
      for (const list of this.pool.freeVideoPool.values()) for (const item of list) this.pool.destroyVideoEl(item);
    }
    this.renderer?.dispose();
    this.canvas = this.renderer = this.frameRenderer = this.pool = undefined;
  }
}
