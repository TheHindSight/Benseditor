import type { AtlasSource } from './atlas';

/**
 * Bitmap font baked into the atlas.
 *
 * Text is drawn as ordinary atlas quads, so it batches with sprites and the
 * layout can happen entirely in Luau -- which matters, because measuring text
 * by calling back into JS would cost ~90us per glyph.
 */

export const FIRST_CHAR = 32;
export const LAST_CHAR = 126;

export interface GlyphMetrics {
  charCode: number;
  advance: number;
  width: number;
  height: number;
}

export interface BuiltFont {
  sources: AtlasSource[];
  metrics: GlyphMetrics[];
  lineHeight: number;
}

/**
 * Renders the printable ASCII range into one small canvas per glyph.
 *
 * A pixel font would be crisper, but this keeps the engine dependency-free and
 * matches whatever the platform has; `size` is in CSS pixels.
 */
export function buildFont(size = 12, family = 'monospace'): BuiltFont {
  const measure = document.createElement('canvas').getContext('2d')!;
  const font = `${size}px ${family}`;
  measure.font = font;

  const ascent = Math.ceil(measure.measureText('M').actualBoundingBoxAscent || size * 0.8);
  const descent = Math.ceil(measure.measureText('gjpqy').actualBoundingBoxDescent || size * 0.25);
  const lineHeight = ascent + descent + 1;

  const sources: AtlasSource[] = [];
  const metrics: GlyphMetrics[] = [];

  for (let code = FIRST_CHAR; code <= LAST_CHAR; code++) {
    const character = String.fromCharCode(code);
    const advance = measure.measureText(character).width;
    const width = Math.max(1, Math.ceil(advance));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = lineHeight;

    const ctx = canvas.getContext('2d')!;
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    if (character !== ' ') {
      // Drawing on the shared baseline keeps every glyph vertically aligned.
      ctx.fillText(character, 0, ascent);
    }

    sources.push({ image: canvas, width, height: lineHeight, originX: 0, originY: 0 });
    metrics.push({ charCode: code, advance, width, height: lineHeight });
  }

  return { sources, metrics, lineHeight };
}

/** Pack metrics as `charCode,atlasId,advance,width,height;...` for Luau. */
export function packFontMetrics(font: BuiltFont, firstAtlasId: number): string {
  return font.metrics
    .map((glyph, index) =>
      [
        glyph.charCode,
        firstAtlasId + index,
        glyph.advance.toFixed(3),
        glyph.width,
        glyph.height,
      ].join(','),
    )
    .join(';');
}
