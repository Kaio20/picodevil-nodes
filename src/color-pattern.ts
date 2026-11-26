import type { Pattern } from "@strudel/mini";
import { mini } from "@strudel/mini";
import { pure } from "@strudel/core";
import { warn } from "./warnings";
import { isFunctionalColor } from "./color-value";

/**
 * Creates a pattern of solid colors. Use CSS names or hex codes for steps and RGB/RGBA for a single color.
 *
 * @param {string | Pattern} pat mininotation string or existing Pattern of color values
 * @returns {Pattern} pattern of {_type: "color", color} objects
 * @example
 * // three colors per cycle
 * $: color("red blue green")
 *
 * // hex and named colors
 * $: color("#ff0000 cyan darkblue")
 *
 * // alternates across cycles
 * $: color("<red blue> <green yellow>")
 * @example
 * $: color('rgba(255, 0, 0, 0.5)')
 *
 */
export function color(pat: string | Pattern): Pattern {
  if (typeof pat !== 'string' && !(pat && typeof (pat as any).queryArc === 'function')) {
    warn(`color() expected string or Pattern, got ${typeof pat}`);
  }
  const p = typeof pat === 'string' ? (isFunctionalColor(pat) ? pure(pat) : mini(pat)) : pat;
  return p.withValue((v: string) => {
    if (typeof v !== 'string') {
      warn(`color pattern produced non-string value: ${typeof v}`);
    }
    return { _type: "color", color: v };
  });
}
