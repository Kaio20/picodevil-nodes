export function controlGlyph(text: string): HTMLSpanElement {
  const glyph = document.createElement("span");
  glyph.className = "bd-glyph";
  glyph.textContent = text;
  glyph.setAttribute("aria-hidden", "true");
  return glyph;
}
