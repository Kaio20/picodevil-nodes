export const gradientSpaces = ["RGB", "HSV", "HSL"] as const;
export const rgbInterpolations = ["Linear", "Ease", "Constant", "Cardinal", "B-Spline"] as const;
export const hueInterpolations = ["Near", "Far", "Clockwise", "Counterclockwise"] as const;
export const maxGradientStops = 32;
export const gradientResolution = 1024;

export interface GradientStop {
  readonly position: number;
  readonly color: string;
  readonly alpha: number;
}

export interface Gradient {
  readonly space: typeof gradientSpaces[number];
  readonly interpolation: typeof rgbInterpolations[number];
  readonly hue: typeof hueInterpolations[number];
  readonly stops: readonly GradientStop[];
}

export const defaultGradient: Gradient = {
  space: "RGB",
  interpolation: "Linear",
  hue: "Near",
  stops: [
    { position: 0, color: "#000000", alpha: 1 },
    { position: 1, color: "#ffffff", alpha: 1 },
  ],
};

export function isGradient(value: unknown): value is Gradient {
  if (!value || typeof value !== "object") return false;
  const { space, interpolation, hue, stops } = value as Gradient;
  const unit = (n: unknown) => typeof n === "number" && n >= 0 && n <= 1;
  return gradientSpaces.includes(space) && rgbInterpolations.includes(interpolation) && hueInterpolations.includes(hue) &&
    Array.isArray(stops) && stops.length > 0 && stops.length <= maxGradientStops &&
    stops.every(stop => stop && unit(stop.position) && unit(stop.alpha) &&
      typeof stop.color === "string" && /^#[\da-f]{6}$/i.test(stop.color));
}

type RGB = [number, number, number];
type RGBA = [number, number, number, number];
export const clampUnit = (n: number) => Math.max(0, Math.min(1, n));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const wrapHue = (n: number) => ((n % 1) + 1) % 1;

export function rgbHex(color: RGBA) {
  return "#" + color.slice(0, 3).map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
}

function toCylindrical([r, g, b]: RGB, hsl: boolean): RGB {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const level = hsl ? (max + min) / 2 : max;
  if (!delta) return [0, 0, level];
  const sector = max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
  return [wrapHue(sector / 6), delta / (hsl ? 1 - Math.abs(2 * level - 1) : max), level];
}

function fromCylindrical(h: number, s: number, level: number, hsl: boolean): RGB {
  const chroma = s * (hsl ? 1 - Math.abs(2 * level - 1) : level);
  const base = hsl ? level - chroma / 2 : level - chroma;
  const channel = (offset: number) => base + chroma * clampUnit(Math.abs(((h * 6 + offset) % 6) - 3) - 1);
  return [channel(0), channel(4), channel(2)];
}

function hueDelta(from: number, to: number, mode: Gradient["hue"]) {
  const forward = wrapHue(to - from);
  if (mode === "Counterclockwise") return forward;
  if (mode === "Clockwise") return forward ? forward - 1 : 0;
  const nearest = forward > 0.5 ? forward - 1 : forward;
  return mode === "Far" ? (nearest > 0 ? nearest - 1 : nearest + 1) : nearest;
}

function splineWeights(t: number, bspline: boolean) {
  const squared = t * t, cubed = squared * t;
  if (bspline) return [(1 - t) ** 3 / 6, (4 - 6 * squared + 3 * cubed) / 6,
    (1 + 3 * t + 3 * squared - 3 * cubed) / 6, cubed / 6];
  const tangent = 0.71;
  return [-tangent * t * (1 - t) ** 2, 1 + (tangent - 3) * squared + (2 - tangent) * cubed,
    tangent * t + (3 - 2 * tangent) * squared + (tangent - 2) * cubed, -tangent * squared * (1 - t)];
}

export function gradientSampler(gradient: Gradient): (factor: number) => RGBA {
  const { space, interpolation, hue } = gradient;
  const stops = [...gradient.stops].sort((a, b) => a.position - b.position).map(stop => {
    const channel = (start: number) => Number.parseInt(stop.color.slice(start, start + 2), 16) / 255;
    const rgb: RGB = [channel(1), channel(3), channel(5)];
    return { position: stop.position, rgba: [...rgb, stop.alpha] as RGBA, hslOrHsv: toCylindrical(rgb, space === "HSL") };
  });
  const last = stops.length - 1;
  const spline = space === "RGB" && (interpolation === "Cardinal" || interpolation === "B-Spline");

  return factor => {
    const position = Number.isNaN(factor) ? 0 : clampUnit(factor);
    const right = stops.findIndex(stop => stop.position > position);
    if (!spline || last === 0) {
      if (right === 0) return stops[0].rgba;
      if (right < 0) return stops[last].rgba;
    }
    const index = right < 0 ? last : Math.max(1, right);
    if (!index) return stops[0].rgba;
    const a = stops[index - 1], b = stops[index];
    const distance = b.position - a.position;
    const t = distance ? clampUnit((position - a.position) / distance) : 1;

    if (space !== "RGB") {
      const [ah, as, av] = a.hslOrHsv;
      const [bh, bs, bv] = b.hslOrHsv;
      const start = as ? ah : bh, end = bs ? bh : ah;
      const h = wrapHue(start + (start === end && (!as || !bs) ? 0 : hueDelta(start, end, hue)) * t);
      return [...fromCylindrical(h, mix(as, bs, t), mix(av, bv, t), space === "HSL"), mix(a.rgba[3], b.rgba[3], t)];
    }
    if (interpolation === "Constant") return a.rgba;
    if (spline) {
      const neighbors = [stops[Math.max(0, index - 2)], a, b, stops[Math.min(last, index + 1)]];
      const weights = splineWeights(t, interpolation === "B-Spline");
      return a.rgba.map((_, channel) =>
        clampUnit(neighbors.reduce((sum, stop, i) => sum + stop.rgba[channel] * weights[i], 0))) as RGBA;
    }
    const weight = interpolation === "Ease" ? t * t * (3 - 2 * t) : t;
    return a.rgba.map((component, channel) => mix(component, b.rgba[channel], weight)) as RGBA;
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
