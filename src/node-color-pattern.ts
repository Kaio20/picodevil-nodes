import { mini2ast, type MiniAst } from "@strudel/mini";
import { colorFromCss, type ColorValue } from "./color-value";

export function colorPatternTokens(pattern: string) {
  const colors: { start: number; end: number; color: ColorValue }[] = [];
  if (!pattern.trim()) return colors;
  let ast: MiniAst;
  try { ast = mini2ast(`"${pattern}"`); }
  catch { return colors; }

  function collect(node: MiniAst) {
    if (node.type_ === "pattern") {
      node.source_.forEach(collect);
    } else if (node.type_ === "element") {
      collect(node.source_);
    } else {
      const color = colorFromCss(node.source_);
      if (!color) return;
      // Parser offsets include the opening quote and adjacent whitespace.
      const offset = node.location_.start.offset - 1;
      const end = node.location_.end.offset - 1;
      const start = offset + pattern.slice(offset, end).indexOf(node.source_);
      colors.push({ start, end: start + node.source_.length, color });
    }
  }
  collect(ast);
  return colors;
}

export function replaceColorPatternTokens(pattern: string, replace: (index: number) => string | undefined) {
  return colorPatternTokens(pattern).reduceRight((result, { start, end }, index) => {
    const value = replace(index);
    return value === undefined ? result : result.slice(0, start) + value + result.slice(end);
  }, pattern);
}
