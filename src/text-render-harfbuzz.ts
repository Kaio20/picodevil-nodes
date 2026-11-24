import {
  Blob as HBBlob,
  Face,
  Font as HBFont,
  Buffer as HBBuffer,
  Variation,
  shape,
  type AxisInfo,
} from 'harfbuzzjs';
import { PAD, LINE_HEIGHT_FACTOR, textSlant } from './text-render';

type FontEntry = { face: Face; hbFont: HBFont; axes: Map<string, AxisInfo & { tag: string }> };
const fontCache = new Map<string, FontEntry>();
const fontLoading = new Set<string>();

/**
 * Returns a cached HarfBuzz font entry for srcUrl, or null if not yet loaded.
 * Triggers an async load (harfbuzzjs WASM init + TTF fetch) on first call.
 */
export function getHarfbuzzFace(srcUrl: string): FontEntry | null {
  const cached = fontCache.get(srcUrl);
  if (cached) return cached;
  if (!fontLoading.has(srcUrl)) {
    fontLoading.add(srcUrl);
    import('harfbuzzjs')
      .then(() => fetch(srcUrl))
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status))
      .then(buf => {
        fontCache.set(srcUrl, makeFontEntryFromBuffer(buf));
      })
      .catch(err => {
        fontLoading.delete(srcUrl);
        console.warn('[pd] harfbuzz font load failed:', srcUrl, err);
      });
  }
  return null;
}

/**
 * Keep the real font's axis ranges and case-sensitive tags with its cached face.
 */
export function makeFontEntryFromBuffer(buf: ArrayBuffer): FontEntry {
  const blob = new HBBlob(buf);
  const face = new Face(blob, 0);
  const hbFont = new HBFont(face);
  const axes = new Map(Object.entries(face.getAxisInfos()).map(([tag, info]) => [tag.toLowerCase(), { tag, ...info }]));
  return { face, hbFont, axes };
}

/**
 * Render text using HarfBuzz shaping + HarfBuzz glyph path drawing to Canvas 2D.
 *
 * HarfBuzz handles full GSUB/GPOS shaping and extracts glyph outlines respecting
 * variable font axes — no opentype.js required. Glyph paths are fed to Path2D
 * which never taints the canvas, so the result can be uploaded to WebGL.
 *
 * @param text — may contain \n for multi-line
 * @param entry — cached { face, hbFont } from getHarfbuzzFace / makeFontEntryFromBuffer
 * @param size — font size in px
 * @param variation — axis values keyed by correct-case tag (e.g. { wght: 700, MONO: 0.5 })
 * @param fontColor — CSS color string for glyph fill
 * @param fontBGColor — CSS color string for background (default: transparent)
 */
export function renderTextHarfbuzz(
  text: string,
  entry: FontEntry,
  size: number,
  variation: Record<string, number>,
  fontColor: string,
  fontBGColor?: string,
  slant = 0,
): HTMLCanvasElement {
  const { face, hbFont } = entry;
  const scale = size / face.upem;

  // Apply variation axes (setVariations resets all axes, so always pass full set).
  const variations = Object.entries(variation).map(([tag, value]) => new Variation(tag, value));
  hbFont.setVariations(variations);

  // Font metrics from HarfBuzz (in font units; multiply by scale for pixels).
  const extents = hbFont.hExtents();
  const ascPx = (extents?.ascender ?? face.upem * 0.8) * scale;
  const descPx = Math.abs(extents?.descender ?? face.upem * 0.2) * scale;
  const emPx = ascPx + descPx;

  const lines = text.split('\n');
  const lh = size * LINE_HEIGHT_FACTOR;
  const { shear, extraWidth } = textSlant(slant, lh);

  // Shape each line: HarfBuzz resolves GSUB substitutions and GPOS positioning.
  const shapedLines = lines.map(line => {
    if (!line) return [];
    const buf = new HBBuffer();
    buf.addText(line);
    buf.guessSegmentProperties();
    shape(hbFont, buf);
    const glyphs = buf.getGlyphInfosAndPositions();
    return glyphs;
  });

  // Canvas width = widest line (sum of shaped advances) + padding.
  const lineWidths = shapedLines.map(glyphs =>
    glyphs.reduce((sum, g) => sum + (g.xAdvance ?? 0) * scale, 0),
  );
  const maxW = Math.max(1, ...lineWidths);

  const canvas = document.createElement('canvas');
  canvas.width  = Math.ceil(maxW + PAD * 2 + extraWidth);
  canvas.height = Math.ceil(lh * lines.length + PAD * 2);

  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (fontBGColor) {
    ctx.fillStyle = fontBGColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.fillStyle = fontColor;

  for (let i = 0; i < lines.length; i++) {
    const glyphs = shapedLines[i];
    if (!glyphs.length) continue;
    // Centre text vertically within line height using ascender/descender metrics.
    const center = PAD + i * lh + lh / 2;
    const baseline = center + ascPx - emPx / 2;
    if (shear) ctx.setTransform(1, 0, shear, 1, extraWidth / 2 - shear * center, 0);

    let penX = PAD;
    for (const g of glyphs) {
      const svgPath = hbFont.glyphToPath(g.codepoint);
      if (svgPath) {
        // HarfBuzz glyph paths are in font units with Y-up origin at baseline.
        // We translate to (penX + xOffset, baseline - yOffset) then scale to pixels,
        // flipping Y to match canvas Y-down convention.
        const x = penX + (g.xOffset ?? 0) * scale;
        const y = baseline - (g.yOffset ?? 0) * scale;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(scale, -scale);
        ctx.fill(new Path2D(svgPath));
        ctx.restore();
      }
      penX += (g.xAdvance ?? 0) * scale;
    }
  }

  return canvas;
}
