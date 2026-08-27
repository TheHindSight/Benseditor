import { detectGridFromImage } from './detectGrid';
import { DEFAULT_PALETTE, FORMAT_VERSION, NAME_PATTERN, type SpriteFile } from './types';

/**
 * Turning an image file into a sprite.
 *
 * Kept separate from the dialog so the slicing arithmetic can be exercised
 * directly: getting a sprite sheet off by a pixel is the classic way to end up
 * with every frame showing a sliver of its neighbour.
 */

/** Frames larger than this would dominate the texture atlas, which is 2048 wide. */
export const MAX_FRAME = 1024;

export interface SliceOptions {
  frameWidth: number;
  frameHeight: number;
  /** Blank border before the first frame. */
  offsetX: number;
  offsetY: number;
  /** Gap between frames. */
  spacingX: number;
  spacingY: number;
}

export const wholeImage = (width: number, height: number): SliceOptions => ({
  frameWidth: width,
  frameHeight: height,
  offsetX: 0,
  offsetY: 0,
  spacingX: 0,
  spacingY: 0,
});

/**
 * How the sheet is laid out, read off the image itself.
 *
 * Falls back to one frame when nothing can be measured and the guess would be
 * arbitrary -- a single image imported as a single image is never a surprise.
 */
export function suggestSlice(
  image: CanvasImageSource,
  width: number,
  height: number,
): { slice: SliceOptions; measured: boolean } {
  const grid = detectGridFromImage(image, width, height);
  if (grid.measured) {
    return {
      slice: {
        frameWidth: grid.x.size,
        frameHeight: grid.y.size,
        offsetX: grid.x.offset,
        offsetY: grid.y.offset,
        spacingX: grid.x.spacing,
        spacingY: grid.y.spacing,
      },
      measured: true,
    };
  }

  // Nothing measurable, but a strip wider than it is tall that divides evenly
  // is almost always a row of square frames packed flush.
  const columns = width / height;
  if (width > height && Number.isInteger(columns) && columns >= 2 && columns <= 64) {
    return { slice: wholeImage(height, height), measured: false };
  }

  return { slice: wholeImage(width, height), measured: false };
}

/** How many whole frames fit, given the margin and the gaps. */
export function sliceGrid(
  imageWidth: number,
  imageHeight: number,
  options: SliceOptions,
): { columns: number; rows: number; count: number } {
  const stepX = options.frameWidth + options.spacingX;
  const stepY = options.frameHeight + options.spacingY;
  if (stepX <= 0 || stepY <= 0 || options.frameWidth <= 0 || options.frameHeight <= 0) {
    return { columns: 0, rows: 0, count: 0 };
  }

  // The last frame needs no gap after it, so lend one to the division.
  const usableWidth = imageWidth - options.offsetX + options.spacingX;
  const usableHeight = imageHeight - options.offsetY + options.spacingY;
  const columns = Math.max(0, Math.floor(usableWidth / stepX));
  const rows = Math.max(0, Math.floor(usableHeight / stepY));

  return { columns, rows, count: columns * rows };
}

/** Top-left pixel of a frame in the sheet. */
export function framePixel(
  options: SliceOptions,
  column: number,
  row: number,
): { x: number; y: number } {
  return {
    x: options.offsetX + column * (options.frameWidth + options.spacingX),
    y: options.offsetY + row * (options.frameHeight + options.spacingY),
  };
}

type Drawable = CanvasImageSource & { width?: number; height?: number };

function frameCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Cut a sheet into base64 PNG frames, reading left to right, top to bottom.
 *
 * Blank cells at the end of the sheet are dropped -- sheets are routinely
 * padded out to a rectangle, and those empty frames would otherwise show up as
 * gaps in the animation. Blanks in the middle are kept, because there they are
 * usually deliberate.
 */
export function cutFrames(
  image: Drawable,
  imageWidth: number,
  imageHeight: number,
  options: SliceOptions,
): string[] {
  const { columns, rows } = sliceGrid(imageWidth, imageHeight, options);
  if (columns === 0 || rows === 0) return [];

  const canvas = frameCanvas(options.frameWidth, options.frameHeight);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;

  const frames: string[] = [];
  const blank: boolean[] = [];

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const { x, y } = framePixel(options, column, row);
      ctx.clearRect(0, 0, options.frameWidth, options.frameHeight);
      ctx.drawImage(
        image,
        x,
        y,
        options.frameWidth,
        options.frameHeight,
        0,
        0,
        options.frameWidth,
        options.frameHeight,
      );

      const pixels = ctx.getImageData(0, 0, options.frameWidth, options.frameHeight).data;
      let empty = true;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] !== 0) {
          empty = false;
          break;
        }
      }

      blank.push(empty);
      frames.push(canvas.toDataURL('image/png').split(',')[1]);
    }
  }

  let last = frames.length;
  while (last > 1 && blank[last - 1]) last--;
  return frames.slice(0, last);
}

/**
 * Redraw a frame at a different size by cropping or padding at the top left.
 *
 * Used when importing into a sprite that already has a size: scaling pixel art
 * would blur it, so the honest thing is to leave the pixels alone.
 */
export function refitFrame(encoded: string, width: number, height: number): Promise<string> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = frameCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0);
      resolve(canvas.toDataURL('image/png').split(',')[1]);
    };
    image.onerror = () => resolve(encoded);
    image.src = 'data:image/png;base64,' + encoded;
  });
}

const hex = (value: number) => value.toString(16).padStart(2, '0');

/**
 * The image's own colours, most used first.
 *
 * Pixel art has few enough colours that counting them exactly is both cheap
 * and exactly right; the palette then matches the art you just imported.
 */
export function extractPalette(
  image: Drawable,
  imageWidth: number,
  imageHeight: number,
  max = 16,
): string[] {
  const canvas = frameCanvas(imageWidth, imageHeight);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, imageWidth, imageHeight);

  const counts = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    // Near-transparent pixels have no colour worth keeping.
    if (data[i + 3] < 8) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const found = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key]) => `#${hex((key >> 16) & 255)}${hex((key >> 8) & 255)}${hex(key & 255)}`);

  // A nearly blank image gives nothing to work with; fill up from the default.
  for (const colour of DEFAULT_PALETTE) {
    if (found.length >= Math.min(max, 8)) break;
    if (!found.includes(colour)) found.push(colour);
  }

  return found;
}

/** `player-run.png` -> `spr_player_run`. */
export function spriteNameFromFile(fileName: string, prefix = 'spr_'): string {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const cleaned = stem
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

  const name = cleaned.startsWith(prefix) ? cleaned : prefix + cleaned;
  return NAME_PATTERN.test(name) ? name : `${prefix}imported`;
}

export function spriteFromFrames(
  name: string,
  width: number,
  height: number,
  frames: string[],
  palette: string[],
): SpriteFile {
  return {
    kind: 'sprite',
    version: FORMAT_VERSION,
    name,
    width,
    height,
    originX: Math.floor(width / 2),
    originY: Math.floor(height / 2),
    fps: 12,
    frames: frames.length ? frames : [''],
    palette: palette.length ? palette : [...DEFAULT_PALETTE],
    collision: { mode: 'rect', left: 0, top: 0, right: width - 1, bottom: height - 1 },
  };
}

/** Read a file the user picked and decode it. */
export function decodeImageFile(file: File): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image.naturalWidth ? image : null);
      image.onerror = () => resolve(null);
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** Open the OS file picker and hand back whatever images were chosen. */
export function pickImageFiles(multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/gif,image/jpeg,image/webp,image/*';
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    // A dismissed picker fires nothing at all in some browsers, so the promise
    // is simply left pending rather than resolving with a lie.
    input.click();
  });
}
