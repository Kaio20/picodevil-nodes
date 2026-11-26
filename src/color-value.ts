export interface ColorValue {
  readonly hex: string;
  readonly alpha: number;
}

type RGB = [number, number, number];
export const whiteColor: ColorValue = { hex: "#ffffff", alpha: 1 };
export const clampUnit = (n: number) => Math.max(0, Math.min(1, n));
export const wrapHue = (n: number) => ((n % 1) + 1) % 1;
const hexByte = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");

export function isColorValue(value: unknown): value is ColorValue {
  if (!value || typeof value !== "object") return false;
  const { hex, alpha } = value as ColorValue;
  return typeof hex === "string" && /^#[\da-f]{6}$/i.test(hex) && typeof alpha === "number" && alpha >= 0 && alpha <= 1;
}

export function parseHexColor(text: string, alpha = 1): ColorValue | undefined {
  let hex = text.trim().replace(/^#/, "").toLowerCase();
  if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.test(hex)) return;
  if (hex.length <= 4) hex = [...hex].map(digit => digit + digit).join("");
  return { hex: `#${hex.slice(0, 6)}`, alpha: hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : alpha };
}

export function rgbFromHex(hex: string): RGB {
  const channel = (start: number) => Number.parseInt(hex.slice(start, start + 2), 16) / 255;
  return [channel(1), channel(3), channel(5)];
}

export function rgbHex([r, g, b]: readonly [number, number, number, ...number[]]) {
  return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
}

export function colorHex({ hex, alpha }: ColorValue) {
  return alpha === 1 ? hex : hex + hexByte(alpha);
}

export function colorCss({ hex, alpha }: ColorValue) {
  if (alpha === 1) return hex;
  const [r, g, b] = rgbFromHex(hex).map(channel => Math.round(channel * 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

let cssContext: CanvasRenderingContext2D | null | undefined;

/** Distinguish a CSS function from a mini string with grouping or parallel steps. */
export function isFunctionalColor(value: string): boolean {
  return /^\s*(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(value) && globalThis.CSS?.supports("color", value) === true;
}

/** Resolve CSS names and legacy color strings to sRGB for the node color controls. */
export function colorFromCss(value: string): ColorValue | undefined {
  const hex = value.trim().startsWith("#") ? parseHexColor(value) : undefined;
  if (hex) return hex;
  cssContext ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!cssContext) return;
  cssContext.fillStyle = "#010203";
  cssContext.fillStyle = value;
  const first = cssContext.fillStyle as string;
  cssContext.fillStyle = "#040506";
  cssContext.fillStyle = value;
  if (first !== cssContext.fillStyle) return;
  if (first.startsWith("#")) return parseHexColor(first);
  const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(first);
  if (rgba) return { hex: rgbHex([+rgba[1] / 255, +rgba[2] / 255, +rgba[3] / 255]), alpha: +rgba[4] };

  cssContext.clearRect(0, 0, 1, 1);
  cssContext.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = cssContext.getImageData(0, 0, 1, 1).data;
  return { hex: rgbHex([r / 255, g / 255, b / 255]), alpha: a / 255 };
}

export function rgbToHsv([r, g, b]: RGB): RGB {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (!delta) return [0, 0, max];
  const sector = max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
  return [wrapHue(sector / 6), delta / max, max];
}

export function hsvToRgb(h: number, s: number, level: number): RGB {
  const chroma = s * level;
  const base = level - chroma;
  const channel = (offset: number) => base + chroma * clampUnit(Math.abs(((h * 6 + offset) % 6) - 3) - 1);
  return [channel(0), channel(4), channel(2)];
}
