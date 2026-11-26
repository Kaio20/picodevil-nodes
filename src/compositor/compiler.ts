import { isColorValue, rgbFromHex, type ColorValue } from "../color-value";
import { analyze, audioBands, GraphError, inputKey, nodes, roundInteger, typeNames, type GraphNode, type Project, type SocketType } from "./graph";

export interface ShaderPass {
  id: string;
  textures: string[];
  uniforms: number[];
  wgsl: string;
  lines: { start: number; end: number; id: string }[];
}
export interface Plan { root: string; media: Record<string, string>; passes: ShaderPass[] }

export const vertex = `
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Vertex {
  let uv = array(vec2f(0, 0), vec2f(2, 0), vec2f(0, 2))[i];
  return Vertex(vec4f(uv * vec2f(2, -2) + vec2f(-1, 1), 0, 1), uv);
}
`;

const helpers = `
fn luma(c: vec4f) -> f32 { return dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722)); }
fn divide(a: f32, b: f32) -> f32 { if (b == 0.0) { return 0.0; } return a / b; }
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn noise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = fract(p);
  let w = f*f*(3.0 - 2.0*f);
  return mix(mix(hash(cell), hash(cell + vec2f(1, 0)), w.x),
    mix(hash(cell + vec2f(0, 1)), hash(cell + vec2f(1, 1)), w.x), w.y);
}
fn blend(bg: vec4f, src: vec4f, amount: f32, mode: i32) -> vec4f {
  let fg = src * clamp(amount, 0.0, 1.0);
  var both = fg.rgb * bg.a;
  if (mode == 1) { both = fg.rgb * bg.rgb; }
  if (mode == 2) { both = fg.rgb * bg.a + bg.rgb * fg.a - fg.rgb * bg.rgb; }
  return vec4f(bg.rgb * (1.0 - fg.a) + fg.rgb * (1.0 - bg.a) + both, fg.a + bg.a * (1.0 - fg.a));
}
`;

type ShaderType = Exclude<SocketType, "string" | "text">;
const wgslType: Record<ShaderType, string> = { image: "vec4f", color: "vec4f", float: "f32", integer: "i32", bool: "bool", vec2: "vec2f" };
const zero: Record<ShaderType, string> = { image: "vec4f(0.0)", color: "vec4f(0.0)", float: "0.0", integer: "0i", bool: "false", vec2: "vec2f(0.0)" };
const expressionWords = new Set(("a b uv time x y xy yx xx yy r g sin cos tan asin acos atan atan2 abs floor ceil round fract min max pow sqrt exp log exp2 log2 clamp mix step smoothstep sign length distance dot normalize f32 vec2f pi").split(" "));

function validateExpression(text: string, id: string) {
  const expression = text.trim();
  const token = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fhiu]?|[A-Za-z_]\w*|[+*/%().,<>!=&|\-]/gy;
  let offset = 0;
  if (!expression || expression.length > 1024 || /\/\/|\/\*/.test(expression)) throw new GraphError("Enter one WGSL expression.", id);
  while (offset < expression.length) {
    const part = token.exec(expression)?.[0];
    if (!part || (/^[A-Za-z_]/.test(part) && !expressionWords.has(part))) throw new GraphError("Unknown token in WGSL expression.", id);
    offset += part.length;
  }
  return expression;
}

function linearColor({ hex, alpha }: ColorValue): number[] {
  const rgb = rgbFromHex(hex).map(channel => alpha * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return [...rgb, alpha];
}

function visualize(expression: string, type: SocketType) {
  if (type === "bool") return `vec4f(vec3f(select(0.0, 1.0, ${expression})), 1.0)`;
  if (type === "float") return `vec4f(vec3f(${expression}), 1.0)`;
  if (type === "integer") return visualize(`f32(${expression})`, "float");
  if (type === "vec2") return `vec4f(${expression}, 0.0, 1.0)`;
  return expression;
}

export function compile(project: Project, target?: string): Plan {
  const { byId, incoming, signals } = analyze(project);
  const outputs = project.nodes.filter(node => node.kind === "output");
  if (!target && outputs.length !== 1) throw new GraphError("Add exactly one Output node.");
  const root = target ?? outputs[0].id;
  const media: Record<string, string> = Object.create(null);
  const passes = new Map<string, ShaderPass>();
  function imagePass(id: string): string {
    const item = byId.get(id);
    if (!item) throw new GraphError("The preview node was removed.");
    if (item.kind === "video") {
      media[id] = String(item.params.asset);
      return id;
    }
    if (item.kind === "junction" && signals.get(id)!.type === "image") {
      const source = incoming.get(inputKey(id, "in"));
      if (source) return imagePass(source.from);
    }
    if (item.kind === "output") {
      const source = incoming.get(inputKey(id, "image"));
      if (!source) throw new GraphError("Connect an image to Output.", id);
      if (signals.get(source.from)!.type === "image") return imagePass(source.from);
    }
    if (passes.has(id)) return id;
    const textures: string[] = [];
    const uniforms = [0, 0, 0, 0, 0, 0, 0, 0];
    const functions = new Map<string, { name: string; body: string }>();
    const definitions: { id: string; text: string }[] = [];
    function param(...values: number[]): string {
      if (values.some(value => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) throw new GraphError("Invalid numeric parameter.", id);
      const index = uniforms.length / 4;
      uniforms.push(...values, ...Array<number>(4 - values.length).fill(0));
      return `frame.data[${index}]`;
    }
    function integer(value: number): string {
      if (value !== roundInteger(value)) throw new GraphError("Invalid integer.", id);
      // Keep both halves exact in the existing f32 uniform buffer.
      const high = Math.floor(value / 65536);
      const pair = param(high, value - high * 65536);
      return `(i32(${pair}.x) * 65536i + i32(${pair}.y))`;
    }
    function sample(source: string, uv: string): string {
      let index = textures.indexOf(source);
      if (index === -1) index = textures.push(source) - 1;
      return `textureSampleLevel(tex${index}, linearSampler, ${uv}, 0.0)`;
    }
    function read(sourceId: string, uv = "uv", inlineImage = false): string {
      const source = byId.get(sourceId)!;
      const type = signals.get(sourceId)!.type;
      if (type === "string" || type === "text") throw new GraphError(`${typeNames[type]} cannot be previewed as a shader value.`, sourceId);
      if (source.kind === "junction") {
        const cable = incoming.get(inputKey(source.id, "in"));
        return cable ? read(cable.from, uv) : zero[type];
      }
      if (type === "image" && !inlineImage) return sample(imagePass(sourceId), uv);
      let fn = functions.get(sourceId);
      if (!fn) {
        const name = `node_${functions.size}`;
        fn = { name, body: "" };
        functions.set(sourceId, fn);
        try {
          fn.body = body(source);
        } catch (error) {
          if (error instanceof GraphError && error.nodeId === sourceId) throw error;
          if (error instanceof GraphError && error.nodeId !== id) throw error;
          throw new GraphError(error instanceof Error ? error.message : String(error), sourceId);
        }
        definitions.push({ id: sourceId, text: `fn ${name}(uv: vec2f) -> ${wgslType[type]} {\n${fn.body}\n}` });
      }
      return `${fn.name}(${uv})`;
    }
    function body(item: GraphNode): string {
      const p = item.params;
      const def = nodes[item.kind];
      const input = (key: string, uv = "uv") => {
        const port = def.inputs[key];
        const cable = incoming.get(inputKey(item.id, key));
        if (!cable) {
          if (port.type === "image") return "vec4f(0.0)";
          if (port.type === "vec2" && port.value === undefined) return uv;
          const value = p["input:" + key] ?? port.value;
          if (port.type === "color") {
            if (!isColorValue(value)) throw new GraphError("Invalid color.", item.id);
            return param(...linearColor(value));
          }
          if (port.type === "integer") return integer(Number(value));
          const v = `${param(Number(value))}.x`;
          if (port.type === "bool") return `(${v} != 0.0)`;
          return port.type === "vec2" ? `vec2f(${v})` : v;
        }
        const type = signals.get(cable.from)!.type;
        const v = read(cable.from, uv);
        if (type === port.type || (type === "color" && port.type === "image")) return v;
        if (type === "integer" && port.type === "float") return `f32(${v})`;
        const scalar = type === "integer" ? `f32(${v})` : v;
        if (port.type === "bool") return `(${scalar} != 0.0)`;
        if (port.type === "vec2") return `vec2f(${scalar})`;
        if (port.type === "color") return visualize(scalar, "float");
        return type === "bool" ? `select(0.0, 1.0, ${v})` : `luma(${v})`;
      };
      const result = (value: string) => `return ${value};`;
      switch (item.kind) {
        case "output": return result(input("image"));
        case "texture":
          media[item.id] = String(p.asset);
          return `let pixel = ${sample(item.id, "uv")}; return vec4f(pixel.rgb * pixel.a, pixel.a);`;
        case "audio": return result(`frame.data[1][${audioBands.indexOf(String(p.band))}]`);
        case "merge": return result(`blend(${input("background")}, ${input("foreground")}, ${input("factor")}, ${["Normal", "Multiply", "Screen"].indexOf(String(p.mode))})`);
        case "mask": return result(`${input("image")} * clamp(${input("mask")}, 0.0, 1.0)`);
        case "alpha": return result(`${input("image")}.a`);
        case "displace": {
          const shift = `uv + ${input("offset")} * ${input("strength")}`;
          return result(input("image", shift));
        }
        case "value": return result(p.type === "Integer" ? integer(Number(p.value)) : `${param(Number(p.value))}.x`);
        case "boolean": return result(`${param(Number(p.value))}.x != 0.0`);
        case "switch": return result(`select(${input("inactive")}, ${input("active")}, ${input("condition")})`);
        case "color": return result(input("color"));
        case "mixColor": return result(`mix(${input("a")}, ${input("b")}, clamp(${input("factor")}, 0.0, 1.0))`);
        case "uv": return result("uv");
        case "vector": return result(`vec2f(${input("x")}, ${input("y")})`);
        case "noise": return result(`noise(${input("uv")} * ${input("scale")} + vec2f(${input("time")} * 0.41, ${input("time")} * 0.23))`);
        case "math": {
          const a = input("a"), b = input("b");
          if (p.operation === "Divide") return result(`divide(${a}, ${b})`);
          if (p.operation === "Minimum") return result(`min(${a}, ${b})`);
          if (p.operation === "Maximum") return result(`max(${a}, ${b})`);
          if (p.operation === "Greater Than") return result(`select(0.0, 1.0, ${a} > ${b})`);
          return result(`${a} ${p.operation === "Multiply" ? "*" : p.operation === "Subtract" ? "-" : "+"} ${b}`);
        }
        case "ramp": {
          const positions = param(Number(p.from), Number(p.to));
          return result(`mix(${input("low")}, ${input("high")}, clamp(divide(${input("factor")} - ${positions}.x, ${positions}.y - ${positions}.x), 0.0, 1.0))`);
        }
        case "expression": {
          const expr = validateExpression(String(p.code), item.id);
          return `let a = ${input("a")}; let b = ${input("b")}; let time = frame.data[0].x; let pi = 3.141592653589793;\nreturn (${expr});`;
        }
        case "time": return result(p.unit === "Beats" ? "frame.data[0].y" : p.unit === "Beat Phase" ? "fract(frame.data[0].y)" : "frame.data[0].x");
        case "lfo": {
          const phase = `fract(frame.data[0].y * ${input("rate")})`;
          return result(p.shape === "Saw" ? phase : p.shape === "Triangle" ? `1.0 - abs(2.0 * ${phase} - 1.0)` : `0.5 + 0.5 * sin(${phase} * 6.2831853)`);
        }
        case "steps": {
          const steps = String(p.grid).split(",").map(Number);
          if (steps.length < 1 || steps.length > 16 || Number(p.division) <= 0 || Number(p.division) > 16) throw new GraphError("Set 1–16 steps and a positive steps-per-beat value.", item.id);
          const values = steps.map(step => `${param(step)}.x`);
          const division = param(Number(p.division));
          return `let steps = array<f32, ${steps.length}>(${values.join(", ")});\nreturn steps[u32(floor(frame.data[0].y * ${division}.x)) % ${steps.length}u];`;
        }
        case "video":
        case "junction": throw new GraphError("Node is resolved before shader evaluation.", item.id);
      }
    }
    const final = visualize(read(id, "uv", true), signals.get(id)!.type);
    let wgsl = `${vertex}${helpers}
struct Frame { data: array<vec4f, ${uniforms.length / 4}> }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var linearSampler: sampler;
${textures.map((_, index) => `@group(0) @binding(${index + 2}) var tex${index}: texture_2d<f32>;`).join("\n")}
`;
    const lines = definitions.map(def => {
      const start = wgsl.split("\n").length;
      wgsl += def.text + "\n";
      return { start, end: wgsl.split("\n").length - 1, id: def.id };
    });
    wgsl += `@fragment fn fs(vertex: Vertex) -> @location(0) vec4f { let uv = vertex.uv; return ${final}; }\n`;
    passes.set(id, { id, textures, uniforms, wgsl, lines });
    return id;
  }
  const rootTexture = imagePass(root);
  return { root: rootTexture, media, passes: [...passes.values()] };
}

export const present = `${vertex}
@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var image: texture_2d<f32>;
@fragment fn fs(vertex: Vertex) -> @location(0) vec4f {
  let rgb = max(vec3f(0.0), textureSampleLevel(image, linearSampler, vertex.uv, 0.0).rgb);
  let srgb = select(1.055 * pow(rgb, vec3f(1.0 / 2.4)) - 0.055, rgb * 12.92, rgb <= vec3f(0.0031308));
  return vec4f(srgb, 1.0);
}
`;

export function fixturePixel(x: number, y: number, seed: number) {
  return [(x + seed * 53) & 255, (y + seed * 87) & 255, ((x ^ y) + seed * 17) & 255, 255];
}
