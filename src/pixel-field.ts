import type { Gradient } from "./gradient";

export type PixelOperator = "add" | "subtract" | "multiply" | "divide" | "remainder" | "min" | "max";

export type PixelExpression =
  | number
  | { kind: "image"; layer: string; channel: "luma" | "alpha" }
  | { kind: "math"; operator: PixelOperator; a: PixelExpression; b: PixelExpression }
  | { kind: "clamp" | "boolean"; value: PixelExpression }
  | { kind: "rampAlpha"; value: PixelExpression; gradient: Gradient };

/** What to draw into a hidden framebuffer when a Float field needs rasterizing. */
export interface PixelRaster {
  value: PixelExpression;
  gradient?: Gradient;
}
