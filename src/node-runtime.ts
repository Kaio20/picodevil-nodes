import { Pattern, pure, reify, sine, cosine, saw, tri, stack } from "@strudel/core";
import { mini } from "@strudel/mini";
import { color } from "./color-pattern";
import { s } from "./screen-pattern";
import { text } from "./text-pattern";
import { choose, rand } from "./event-random";
import { stackN } from "./grid-stack";
import { fft, previewFft } from "./fft-audio";
import { isTexture, resolveMedia, resolveMediaId } from "./media-registry";
import { resolveUrl } from "./server-config";
import { CYCLES_PER_SECOND, getRuntimeCps, setRuntimeCps } from "./config";
import { CpsController } from "./cps-controller";
import { createMetrics } from "./frame-metrics";
import { FrameRenderer } from "./renderer";
import { WebGLRenderer } from "./webgl-renderer";
import { createVideoPoolManager } from "./video-pool-manager";
import { hashStr, withLayoutCounter } from "./layout-counter";
import { collectScreens, getNamedScreenIndices, registerAutoHidden, resetRegistry, restoreRegistry, snapshotRegistry } from "./pattern-registry";
import { fftBands, inputsFor, isFontVariation, isRenderable, isVariableSetter, modeFor, outputType, previewType, rampInterpolation, rampStops, variableFor, type Band, type Graph, type GraphNode, type Literal } from "./node-graph";
import { gradientSampler, type Gradient } from "./gradient";
import { colorRamp } from "./effects-controls";
import { clampUnit, colorCss, colorFromCss, isColorValue, whiteColor, type ColorValue } from "./color-value";
import "./index-patterns";
import "./shuffle-stack";

export function mediaUrl(name: string, base: string): string {
  const entry = resolveMedia(name);
  return entry ? resolveUrl(entry.url) : base + name;
}

function call(pattern: Pattern, method: string, ...args: unknown[]): Pattern {
  return pattern[method](...args);
}

function makeTestCard(): Pattern {
  const bars = ["#eeeeee", "#e4de37", "#59e4dd", "#4dd45b", "#df59e5", "#e14849", "#445ae2"];
  const tones = ["#121212", "#373737", "#797979", "#a5a5a5", "#eaeaea"];
  const strip = (colors: string[], y: number, height: number) => colors.map((value, i) =>
    call(call(call(call(color(value), "x", (i + 0.5) / colors.length), "y", y), "width", 1 / colors.length), "height", height));
  return stack(...strip(bars, 0.36, 0.72), ...strip(tones, 0.86, 0.28));
}

type Value = Pattern | Literal;
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

function buildValues(graph: Graph, preview: boolean) {
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
      const inputs = Object.fromEntries(inputsFor(graph, node).flatMap(socket => {
        if (node.kind === "colorRamp" && socket.id === "factor" && output !== "alpha") return [];
        if (node.kind === "colorRamp" && socket.id === "image" && output !== undefined) return [];
        const source = incoming.get(node.id + ":" + socket.id);
        if (node.kind === "variable" && !source) return [];
        let value = source ? read(source.from, source.output) : node.data[socket.id] ?? socket.default;
        if (source && (socket.type === "visual" || source.legacyTextInput) && outputType(graph, nodes.get(source.from)!, source.output) === "color") {
          value = solidImage(value!);
        }
        if (value !== undefined) {
          // withValue preserves per-event sampling for random signal sources.
          if (socket.unitInterval) value = reify(value).withValue((item: unknown) => clampUnit(Number(item)));
          return [[socket.id, value] as const];
        }
        if (socket.optional) return [];
        throw new Error(`${socket.label} needs a connection.`);
      }));
      const value = withLayoutCounter(hashStr(node.id), () => buildNode(node, inputs, graph, preview, setters, read, output));
      values.set(key, value);
      return value;
    } finally { visiting.delete(id); }
  };
  return read;
}

function buildNode(
  node: GraphNode, input: Record<string, Value>, graph: Graph, preview: boolean,
  setters: Map<Literal, GraphNode>, read: (id: string) => Value, output?: string,
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
  switch (node.kind) {
    case "media":
    case "texture": {
      const mediaId = String(node.data.media ?? "");
      const texture = node.kind === "texture";
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
    case "screen": {
      const expression = String(input.pattern);
      if (preview && sceneSource.test(expression)) throw new Error("This source uses the full scene. Run to see it in Output.");
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
      if (output !== "alpha") {
        if (image) return call(colorRamp(ramp, image), "render");
        return ramp.fmap((gradient: Gradient) => ({ _type: "gradient", gradient }));
      }
      let sampled: Gradient | undefined;
      let sample: ReturnType<typeof gradientSampler>;
      return ramp.fmap((gradient: Gradient) => {
        if (sampled !== gradient) { sample = gradientSampler(gradient); sampled = gradient; }
        const current = sample;
        return (factor: number) => current(factor)[3];
      }).appBoth(reify(input.factor));
    }
    case "waveform": return waveforms[mode ?? "sine"];
    case "rand": return rand;
    case "fft": {
      const band = fftBands.includes(node.data.band as Band) ? node.data.band as Band : "bass";
      return preview ? previewFft(band) : fft[band];
    }
    case "numberPattern": return (mini(String(input.pattern)) as Pattern).fmap((value: unknown) => Number(value) || 0);
    case "range": return call(reify(input.signal), "range", input.min, input.max);
    case "choose": {
      const choices = String(input.choices).trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (!choices.length || !choices.every(Number.isFinite)) throw new Error("Enter numbers separated by commas.");
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
    case "index": return mode === "shuffle" ? call(image, "shuffleIndex", input.seed) : call(image, "index");
    case "grid": {
      const rows = input.rows === undefined ? undefined : bounded(input.rows, 64);
      const columns = input.columns === undefined ? undefined : bounded(input.columns, 64);
      return mode === "dimensions" ? call(call(image, "rows", rows), "cols", columns) : call(image, "gridMod", rows, columns);
    }
    case "position": return call(call(image, "x", input.x), "y", input.y);
    case "size": return call(call(image, "width", input.x), "height", input.y);
    case "scroll": return call(image, "scroll", input.x, input.y);
    case "scale": return call(call(image, "scaleX", input.x ?? input.value), "scaleY", input.y ?? input.value);
    case "rotate": {
      let rotated = call(image, "rotateZ", input.value);
      if (input.x !== undefined) rotated = call(rotated, "rotateX", input.x);
      if (input.y !== undefined) rotated = call(rotated, "rotateY", input.y);
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
  }
}

function previewKey(target: PreviewTarget) { return JSON.stringify([target.id, Boolean(target.showRamp)]); }

function compile(graph: Graph, targets?: readonly PreviewTarget[]) {
  const previous = snapshotRegistry();
  resetRegistry();
  try {
    const previews = new Map<string, PreviewValue>();
    const read = buildValues(graph, targets !== undefined);
    const outputs = graph.nodes.filter(node => node.kind === "output");
    let tempo: Value = CYCLES_PER_SECOND * 60;
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
          if (!target.showRamp && isRenderable(previewType(graph, node))) {
            const layer = `__auto_preview_${id}`;
            registerAutoHidden(layer, value as Pattern);
            previews.set(key, { layer });
          } else previews.set(key, { value });
        } catch (error) {
          previews.set(key, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    } else {
      if (!outputs.length) throw new Error("Add an Output node to run this graph.");
      for (const node of outputs) call(read(node.id) as Pattern, "p", "$");
    }
    const screens = collectScreens();
    const namedScreens = getNamedScreenIndices();
    return { screens, namedScreens, registry: snapshotRegistry(), tempo: tempo as number | Pattern, previews };
  } finally { restoreRegistry(previous); }
}

export function compileLiveGraph(graph: Graph) { return compile(graph); }

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
  private clock?: CpsController;
  private graph?: Graph;
  private result?: ReturnType<typeof compile>;
  private signature = "";
  private nextFrame = 0;
  private nextBatch = 0;
  private idleSince = 0;
  private unavailable = false;

  draw(graph: Graph, visibleTargets: () => PreviewTarget[], now: number, cycle: number, ratio: number) {
    if (now < this.nextFrame) return;
    this.nextFrame = now + 1000 / 15;
    const targets = visibleTargets();
    if (!targets.length) {
      this.idleSince ||= now;
      if (this.renderer && now - this.idleSince > 5000) this.dispose();
      this.clock = undefined;
      return;
    }
    this.idleSince = 0;
    // Rotate the first target so an expensive preview can't consume the budget every tick.
    const start = this.nextBatch % targets.length;
    const batch = [...targets.slice(start), ...targets.slice(0, start)].slice(0, 4);
    this.nextBatch = start + (targets.length > 4 ? 4 : 1);
    const signature = batch.map(previewKey).join(",");
    if (!this.clock) {
      this.clock = new CpsController(CYCLES_PER_SECOND, now);
      this.clock.restore({ ...this.clock.snapshot(), startMs: now - cycle / CYCLES_PER_SECOND * 1000, accumulatedCycle: cycle });
      this.result = undefined;
    }
    if (!this.result || this.graph !== graph || this.signature !== signature) {
      const result = compile(graph, batch);
      if (this.graph !== graph || !this.result) this.clock.setCpm(result.tempo, now);
      this.graph = graph;
      this.signature = signature;
      this.result = result;
    }
    const result = this.result;
    const time = this.clock.tick(now);
    const registry = snapshotRegistry();
    const cps = getRuntimeCps();
    restoreRegistry(result.registry);
    setRuntimeCps(time.cps);
    try {
      const hasImages = result.screens.length > 0 && !this.unavailable;
      if (hasImages) {
        this.prepareRenderer(ratio);
        if (!this.renderer?.isContextLost()) this.frameRenderer?.render(result.screens, result.namedScreens, time.t, time.cps, time.cycle, now);
      }
      for (const target of batch) this.drawTarget(target, result.previews.get(previewKey(target)), time.t);
    } catch (error) {
      for (const target of batch) target.status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      setRuntimeCps(cps);
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
        resolveMediaUrl: mediaUrl,
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
