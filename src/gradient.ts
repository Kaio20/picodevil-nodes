import { clampUnit, rgbFromHex } from "./color-value";

export const rgbInterpolations = ["Linear", "Constant"] as const;
export const maxGradientStops = 32;
export const gradientResolution = 1024;

export interface GradientStop {
  readonly position: number;
  readonly color: string;
  readonly alpha: number;
}

export interface Gradient {
  readonly interpolation: typeof rgbInterpolations[number];
  readonly stops: readonly GradientStop[];
}

export const defaultGradient: Gradient = {
  interpolation: "Linear",
  stops: [
    { position: 0, color: "#000000", alpha: 1 },
    { position: 1, color: "#ffffff", alpha: 1 },
  ],
};

type RGBA = [number, number, number, number];
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function gradientSampler(gradient: Gradient): (factor: number) => RGBA {
  const { interpolation } = gradient;
  const stops = [...gradient.stops].sort((a, b) => a.position - b.position).map(stop => ({
    position: stop.position, rgba: [...rgbFromHex(stop.color), stop.alpha] as RGBA,
  }));
  return factor => {
    const position = Number.isNaN(factor) ? 0 : clampUnit(factor);
    const right = stops.findIndex(stop => stop.position > position);
    if (right === 0) return stops[0].rgba;
    if (right < 0) return stops[stops.length - 1].rgba;
    const a = stops[right - 1], b = stops[right];
    if (interpolation === "Constant") return a.rgba;
    const t = (position - a.position) / (b.position - a.position);
    return a.rgba.map((component, channel) => mix(component, b.rgba[channel], t)) as RGBA;
  };
}

export function gradientPixels(gradient: Gradient, width: number): Uint8ClampedArray<ArrayBuffer> {
  const sample = gradientSampler(gradient);
  const pixels = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x++) {
    const rgba = sample(x / Math.max(1, width - 1));
    for (let channel = 0; channel < 4; channel++) pixels[x * 4 + channel] = rgba[channel] * 255;
  }
  return pixels;
}
