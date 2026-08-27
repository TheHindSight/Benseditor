/**
 * Texture atlas packing.
 *
 * Every sprite frame and font glyph goes into one texture so a whole frame --
 * sprites, shapes and text -- is a single WebGL draw call.
 */

export interface AtlasEntry {
  /** Size in pixels. */
  width: number;
  height: number;
  /** Where the quad is anchored, in pixels from the top-left. */
  originX: number;
  originY: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface AtlasSource {
  image: CanvasImageSource;
  width: number;
  height: number;
  originX: number;
  originY: number;
}

export interface Atlas {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Indexed by the atlas id that Luau stores in its draw commands. */
  entries: AtlasEntry[];
  /** Id of a 1x1 opaque white pixel, used for untextured shapes. */
  whiteId: number;
}

const PADDING = 1;
const MAX_WIDTH = 2048;

function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power *= 2;
  return power;
}

/**
 * Shelf-packs `sources` into one texture. Ids are assigned in input order, so
 * callers can rely on a sprite's frames being contiguous.
 */
export function buildAtlas(sources: AtlasSource[]): Atlas {
  // A white pixel for rectangles, lines and circles, appended last so the
  // caller's ids stay exactly the indices it handed in.
  const white = document.createElement('canvas');
  white.width = 1;
  white.height = 1;
  const whiteCtx = white.getContext('2d')!;
  whiteCtx.fillStyle = '#ffffff';
  whiteCtx.fillRect(0, 0, 1, 1);

  const all: AtlasSource[] = [
    ...sources,
    { image: white, width: 1, height: 1, originX: 0, originY: 0 },
  ];
  const whiteId = sources.length;

  // Tallest first keeps the shelves tight.
  const order = all
    .map((source, id) => ({ source, id }))
    .sort((a, b) => b.source.height - a.source.height);

  const placements: { id: number; source: AtlasSource; x: number; y: number }[] = [];
  let penX = 0;
  let penY = 0;
  let shelfHeight = 0;
  let usedWidth = 0;

  for (const { source, id } of order) {
    const w = source.width + PADDING;
    const h = source.height + PADDING;
    if (penX + w > MAX_WIDTH && penX > 0) {
      penX = 0;
      penY += shelfHeight;
      shelfHeight = 0;
    }
    placements.push({ id, source, x: penX, y: penY });
    penX += w;
    shelfHeight = Math.max(shelfHeight, h);
    usedWidth = Math.max(usedWidth, penX);
  }

  const width = nextPowerOfTwo(Math.max(usedWidth, 1));
  const height = nextPowerOfTwo(Math.max(penY + shelfHeight, 1));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const entries: AtlasEntry[] = new Array(all.length);
  for (const { id, source, x, y } of placements) {
    ctx.drawImage(source.image, x, y, source.width, source.height);
    entries[id] = {
      width: source.width,
      height: source.height,
      originX: source.originX,
      originY: source.originY,
      u0: x / width,
      v0: y / height,
      u1: (x + source.width) / width,
      v1: (y + source.height) / height,
    };
  }

  return { canvas, entries, whiteId };
}

/** Decode a base64 PNG (the sprite frame format) into a drawable image. */
export function loadFrame(base64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode a sprite frame'));
    image.src = 'data:image/png;base64,' + base64;
  });
}
