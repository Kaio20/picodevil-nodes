import { gradientResolution, type Gradient } from "./gradient";
import type { PixelExpression, PixelOperator, PixelRaster } from "./pixel-field";

export const fieldVertexSource = `#version 300 es
out highp vec2 fieldUV;
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  fieldUV = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

type FieldTexture = string | Gradient;

const math: Record<PixelOperator, (a: string, b: string) => string> = {
  add: (a, b) => `${a} + ${b}`,
  subtract: (a, b) => `${a} - ${b}`,
  multiply: (a, b) => `${a} * ${b}`,
  divide: (a, b) => `${b} == 0.0 ? 0.0 : ${a} / ${b}`,
  remainder: (a, b) => `${b} == 0.0 ? 0.0 : ${a} - ${b} * trunc(${a} / ${b})`,
  min: (a, b) => `min(${a}, ${b})`,
  max: (a, b) => `max(${a}, ${b})`,
};

const clamp = (value: string) => `clamp(${value}, 0.0, 1.0)`;

/** Compile the graph shape. Animated values and image names are bindings, so the GPU program can be reused. */
export function compilePixelRaster(raster: PixelRaster) {
  const textures: FieldTexture[] = [];
  const values: number[] = [];
  const instructions: string[] = [];
  const bindings = new Map<PixelExpression, string>();
  const texture = (source: FieldTexture) => {
    let index = textures.indexOf(source);
    if (index < 0) { index = textures.length; textures.push(source); }
    return `u_texture${index}`;
  };
  const ramp = (gradient: Gradient, value: string) => {
    const u = `(${clamp(value)} * ${gradientResolution - 1}.0 + 0.5) / ${gradientResolution}.0`;
    return `texture(${texture(gradient)}, vec2(${u}, 0.5))`;
  };
  const emit = (value: PixelExpression): string => {
    const previous = typeof value === "number" ? undefined : bindings.get(value);
    if (previous) return previous;
    let expression: string;
    if (typeof value === "number") {
      expression = `u_values[${values.length}]`;
      values.push(Number.isFinite(value) ? value : 0);
    } else switch (value.kind) {
      case "math": expression = math[value.operator](emit(value.a), emit(value.b)); break;
      case "clamp": expression = clamp(emit(value.value)); break;
      case "boolean": {
        const input = emit(value.value);
        expression = `(isnan(${input}) || ${input} == 0.0) ? 0.0 : 1.0`;
        break;
      }
      case "image": {
        const sample = `texture(${texture(value.layer)}, fieldUV)`;
        expression = value.channel === "alpha" ? `${sample}.a` : `dot(${sample}.rgb, vec3(0.2126, 0.7152, 0.0722))`;
        break;
      }
      case "rampAlpha": expression = `${ramp(value.gradient, emit(value.value))}.a`; break;
    }
    const result = `v${instructions.length}`;
    instructions.push(`float ${result} = ${expression};`);
    if (typeof value !== "number") bindings.set(value, result);
    return result;
  };
  const value = emit(raster.value);
  const color = raster.gradient ? ramp(raster.gradient, value) : `vec4(vec3(${clamp(value)}), 1.0)`;
  const source = `#version 300 es
precision highp float;
in vec2 fieldUV;
out vec4 fragColor;
${textures.map((_, index) => `uniform sampler2D u_texture${index};`).join("\n")}
${values.length ? `uniform float u_values[${values.length}];` : ""}
void main() {
  ${instructions.join("\n  ")}
  fragColor = ${color};
}`;
  return { source, textures, values };
}
