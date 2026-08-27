/**
 * Working out how a sheet is cut up, by looking at it.
 *
 * Two questions, one per axis: where does each tile start, and how wide is it.
 * The reliable answer comes from the blank pixels a sheet leaves between tiles
 * -- a margin and a gap are visible in the image, so they can be measured
 * rather than guessed. Only when a sheet is packed flush, with nothing to
 * measure, does this fall back to guessing a size, and it says so.
 */

export interface DetectedAxis {
  /** Tile size along this axis. */
  size: number;
  /** Blank border before the first tile. */
  offset: number;
  /** Gap between tiles. */
  spacing: number;
  /** False when the answer is a guess from the dimensions alone. */
  measured: boolean;
}

export interface DetectedGrid {
  x: DetectedAxis;
  y: DetectedAxis;
  /** True only when both axes were measured from the pixels. */
  measured: boolean;
}

/** Sizes worth guessing at, in the order people actually use them. */
const LIKELY_SIZES = [16, 32, 8, 24, 48, 64, 12, 10, 20, 40, 96, 128];

/** A run of consecutive indices that hold something. */
interface Run {
  start: number;
  length: number;
}

function runsOf(occupied: boolean[]): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let i = 0; i <= occupied.length; i++) {
    if (i < occupied.length && occupied[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push({ start, length: i - start });
      start = -1;
    }
  }
  return runs;
}

const allSame = (values: number[]) => values.every((value) => value === values[0]);

/**
 * Read a size, margin and gap out of the blank lines in one axis.
 *
 * Needs at least two tiles to be sure: a single run of content tells you the
 * margin but nothing about the spacing, and calling that a grid would be
 * guessing dressed up as a measurement.
 */
function measureAxis(occupied: boolean[], length: number): DetectedAxis | null {
  const runs = runsOf(occupied);
  if (runs.length < 2) return null;

  const sizes = runs.map((run) => run.length);
  if (!allSame(sizes)) return null;

  const gaps: number[] = [];
  for (let i = 1; i < runs.length; i++) {
    gaps.push(runs[i].start - (runs[i - 1].start + runs[i - 1].length));
  }
  if (!allSame(gaps)) return null;

  const size = sizes[0];
  const spacing = gaps[0];
  const offset = runs[0].start;

  // A tile one or two pixels across is noise, not a grid.
  if (size < 4 || size > length) return null;
  return { size, offset, spacing, measured: true };
}

/** No blank lines to measure, so pick a size that at least divides evenly. */
function guessAxis(length: number, other: number): DetectedAxis {
  // A strip of squares is by far the most common flush layout.
  if (length > other && length % other === 0 && length / other >= 2 && length / other <= 64) {
    return { size: other, offset: 0, spacing: 0, measured: false };
  }

  for (const size of LIKELY_SIZES) {
    if (size < length && length % size === 0) {
      return { size, offset: 0, spacing: 0, measured: false };
    }
  }

  return { size: length, offset: 0, spacing: 0, measured: false };
}

/**
 * Detect the grid in a decoded sheet.
 *
 * `data` is RGBA, as `getImageData` returns it.
 */
export function detectGrid(data: Uint8ClampedArray, width: number, height: number): DetectedGrid {
  const columnHasContent = new Array<boolean>(width).fill(false);
  const rowHasContent = new Array<boolean>(height).fill(false);

  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] < 8) continue;
      columnHasContent[x] = true;
      rowHasContent[y] = true;
    }
  }

  const x = measureAxis(columnHasContent, width);
  const y = measureAxis(rowHasContent, height);

  // One measured axis is still worth having: a strip of frames separated
  // horizontally is a single band vertically, and the band's height is the
  // frame height.
  const verticalBand = runsOf(rowHasContent);
  const fallbackY =
    x && verticalBand.length === 1 && verticalBand[0].length >= 4
      ? { size: verticalBand[0].length, offset: verticalBand[0].start, spacing: 0, measured: true }
      : null;

  const horizontalBand = runsOf(columnHasContent);
  const fallbackX =
    y && horizontalBand.length === 1 && horizontalBand[0].length >= 4
      ? { size: horizontalBand[0].length, offset: horizontalBand[0].start, spacing: 0, measured: true }
      : null;

  const resolvedX = x ?? fallbackX ?? guessAxis(width, height);
  const resolvedY = y ?? fallbackY ?? guessAxis(height, width);

  return { x: resolvedX, y: resolvedY, measured: resolvedX.measured && resolvedY.measured };
}

/** Convenience for callers holding an image rather than pixels. */
export function detectGridFromImage(
  image: CanvasImageSource,
  width: number,
  height: number,
): DetectedGrid {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  return detectGrid(ctx.getImageData(0, 0, width, height).data, width, height);
}
