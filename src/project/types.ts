/**
 * On-disk project formats.
 *
 * Unchanged from the editor's own formats: every asset is JSON so it diffs and
 * merges in git, with sprite pixels riding along as base64 PNG per frame.
 * Behaviour scripts are `.luau` files sitting beside their `.bobject`.
 */

export const FORMAT_VERSION = 1;

export const DEFAULT_PALETTE = [
  '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
  '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
];

export type CollisionMode = 'rect' | 'circle' | 'precise';

export type AssetKind = 'sprite' | 'tileset' | 'object' | 'room' | 'script';

/** Which language the project's scripts are written in. Absent means `luau`. */
export type ScriptLanguage = 'luau' | 'python';

/**
 * How scripts are authored. `code` is the text editor; `blocks` is the
 * Scratch-style block editor, whose blocks compile to the project's language
 * so the engine, exports and error reporting never know the difference.
 * Absent means `code`.
 */
export type Scripting = 'code' | 'blocks';

/**
 * A Blockly workspace as `Blockly.serialization.workspaces.save` writes it.
 * Kept opaque here: only the block editor reads or writes it.
 */
export interface BlockWorkspace {
  blocks?: { languageVersion: number; blocks: unknown[] };
  variables?: unknown[];
}

/**
 * How the editor presents the project. `gamemaker` is five flat asset lists;
 * `roblox` is an Explorer tree of services and folders. The engine and the
 * on-disk assets are identical either way -- see `explorer.ts`.
 */
export type Paradigm = 'gamemaker' | 'roblox';

/** One row of the Explorer tree: a service, a folder, or a reference to an asset. */
export interface ExplorerNode {
  id: string;
  kind: 'service' | 'folder' | 'asset';
  name: string;
  parentId: string | null;
  asset?: { kind: AssetKind; name: string };
}

export interface ProjectFile {
  kind: 'project';
  version: number;
  name: string;
  startRoom: string;
  fps: number;
  window: { width: number; height: number; scale: number; title: string };
  /** Absent means `luau`. Chosen when the project is created; switchable in settings. */
  language?: ScriptLanguage;
  /** Absent means `code`. */
  scripting?: Scripting;
  /** Absent means `gamemaker`. */
  paradigm?: Paradigm;
  /** The Explorer tree, kept (dormant) when switching back to GameMaker style. */
  explorer?: ExplorerNode[];
}

export interface SpriteFile {
  kind: 'sprite';
  version: number;
  name: string;
  width: number;
  height: number;
  originX: number;
  originY: number;
  fps: number;
  /** Base64 PNG per frame, each `width` x `height`. */
  frames: string[];
  palette: string[];
  collision: { mode: CollisionMode; left: number; top: number; right: number; bottom: number };
}

export interface ObjectFile {
  kind: 'object';
  version: number;
  name: string;
  sprite: string | null;
  depth: number;
  visible: boolean;
  solid: boolean;
  persistent: boolean;
  parent: string | null;
  /**
   * Object names this one cannot walk into, plus the special entry "tiles"
   * for solid tiles. Enforced by the engine after movement, per axis, so
   * setting hspeed/vspeed is enough — no collision code required.
   */
  blockedBy?: string[];
  /**
   * The object's blocks, when it was authored in block mode. The generated
   * code always lives in the object's script alongside, which is all the
   * engine ever sees; this is editor state and is stripped from exports.
   */
  blocks?: BlockWorkspace;
}

export interface TilesetFile {
  kind: 'tileset';
  version: number;
  name: string;
  tileWidth: number;
  tileHeight: number;
  /**
   * Pixels of blank border before the first tile, and between tiles. Most
   * sheets found in the wild have one or both; without them the slice is off
   * by a pixel or two and every tile shows a sliver of its neighbour.
   */
  offsetX?: number;
  offsetY?: number;
  spacingX?: number;
  spacingY?: number;
  /** Grid of the source sheet, in tiles. */
  columns: number;
  rows: number;
  /** The whole sheet as one base64 PNG. */
  image: string;
  /** One flag per tile, row-major. Solid tiles block `place_meeting("tiles")`. */
  solid: boolean[];
}

/** Top-left pixel of a tile in its sheet, honouring margin and spacing. */
export function tilePixel(
  tileset: TilesetFile,
  column: number,
  row: number,
): { x: number; y: number } {
  return {
    x: (tileset.offsetX ?? 0) + column * (tileset.tileWidth + (tileset.spacingX ?? 0)),
    y: (tileset.offsetY ?? 0) + row * (tileset.tileHeight + (tileset.spacingY ?? 0)),
  };
}

/** How many whole tiles fit in a sheet of this size. */
export function tilesetGrid(
  tileset: TilesetFile,
  imageWidth: number,
  imageHeight: number,
): { columns: number; rows: number } {
  const stepX = tileset.tileWidth + (tileset.spacingX ?? 0);
  const stepY = tileset.tileHeight + (tileset.spacingY ?? 0);
  const usableW = imageWidth - (tileset.offsetX ?? 0) + (tileset.spacingX ?? 0);
  const usableH = imageHeight - (tileset.offsetY ?? 0) + (tileset.spacingY ?? 0);
  return {
    columns: Math.max(0, Math.floor(usableW / stepX)),
    rows: Math.max(0, Math.floor(usableH / stepY)),
  };
}

export interface TileLayer {
  id: string;
  name: string;
  tileset: string;
  /** Lower draws in front, matching instances. */
  depth: number;
  visible: boolean;
  columns: number;
  rows: number;
  /** Row-major tile indices into the tileset; -1 is empty. */
  tiles: number[];
}

export interface RoomInstance {
  id: string;
  object: string;
  x: number;
  y: number;
  xscale: number;
  yscale: number;
  angle: number;
  /** The instance's `name` at runtime; defaults to the object name. */
  name?: string;
}

export interface RoomFile {
  kind: 'room';
  version: number;
  name: string;
  width: number;
  height: number;
  backgroundColor: string;
  gridWidth: number;
  gridHeight: number;
  instances: RoomInstance[];
  layers?: TileLayer[];
}

/** A project held in memory, with each object paired to its Luau source. */
export interface Project {
  config: ProjectFile;
  sprites: SpriteFile[];
  tilesets: TilesetFile[];
  objects: { def: ObjectFile; source: string }[];
  rooms: RoomFile[];
  /** Shared `scripts/*.luau` modules, run before any object script. */
  scripts: { name: string; source: string }[];
}

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateAssetName(name: string): string | undefined {
  if (!name) return 'Name cannot be empty.';
  if (!NAME_PATTERN.test(name)) {
    return 'Use letters, digits and underscores only, starting with a letter or underscore.';
  }
  return undefined;
}

/**
 * Run-length encode a tile grid for the trip into Luau: `index:count,...`.
 *
 * A room-sized layer is mostly empty, so this turns thousands of numbers into
 * a short string and keeps the load-time crossing cheap.
 */
export function encodeTiles(tiles: number[]): string {
  if (tiles.length === 0) return '';

  const runs: string[] = [];
  let value = tiles[0];
  let count = 1;

  for (let i = 1; i <= tiles.length; i++) {
    if (i < tiles.length && tiles[i] === value) {
      count++;
      continue;
    }
    runs.push(`${value}:${count}`);
    value = tiles[i];
    count = 1;
  }

  return runs.join(',');
}

export function decodeTiles(packed: string, length: number): number[] {
  const tiles = new Array<number>(length).fill(-1);
  if (!packed) return tiles;

  let at = 0;
  for (const run of packed.split(',')) {
    const [value, count] = run.split(':').map(Number);
    for (let i = 0; i < count && at < length; i++) tiles[at++] = value;
  }
  return tiles;
}

/** `"#1d2b53"` -> `0x1d2b53`, the integer form Luau uses for colours. */
export function colorToInt(hex: string): number {
  const text = hex.replace('#', '');
  const full = text.length === 3 ? text.split('').map((c) => c + c).join('') : text;
  return parseInt(full.slice(0, 6), 16) || 0;
}
