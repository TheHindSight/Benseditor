/**
 * Geometry Dash clone: shared constants.
 *
 * Pure TypeScript (no DOM), so the Node test suites and the preview tool can
 * import it. `constantsPython()` emits the same numbers as the `gd_const`
 * Python module, so the two sides never drift: the TS side is the source and
 * the Python text is generated from it at build time.
 *
 * Units: GD-native 30 px blocks. Level data counts rows UP from the floor
 * (row 0 = the block resting on the floor); the tile layer counts rows down
 * from the top of the room, so `tileY(row) = ROWS - 1 - row`. The two floor
 * rows sit below row 0 and are pre-filled with the ground tile.
 */

/** Size of one block in pixels. */
export const CELL = 30;
/** Playable rows above the floor (rows 0..ROWS-1). */
export const ROWS = 30;
/** Pre-filled ground rows under row 0. */
export const FLOOR_ROWS = 2;
/** Height of the tile layer in cells. */
export const LAYER_ROWS = ROWS + FLOOR_ROWS;
/** Width of the tile layer (and the room) in cells. */
export const MAX_COLUMNS = 1200;
/** Y pixel of the top of the floor: the feet of a player standing on row 0. */
export const FLOOR_Y = ROWS * CELL;
/** Y pixel of the top of the room (the hard ceiling). */
export const CEIL_Y = 0;
export const ROOM_W = MAX_COLUMNS * CELL;
export const ROOM_H = LAYER_ROWS * CELL;
/** The visible area: 19 x 11 blocks, GD's framing. */
export const VIEW_W = 570;
export const VIEW_H = 330;
/** The run-up: columns 0..SPAWN_COLS-1 must stay empty; the player spawns there. */
export const SPAWN_COLS = 8;
/** Hard cap on the objects one level may hold. */
export const MAX_OBJECTS = 3000;
export const MAX_COINS = 3;
/** Longest level: the finish needs a run-out inside the layer. */
export const MAX_LEN = MAX_COLUMNS - 20;
export const MIN_LEN = SPAWN_COLS + 8;
export const MAX_NAME = 20;

/** Tile indices in the `ts_gd` tileset. */
export const TILE_BLOCK = 0;
export const TILE_GROUND = 1;

export const LAYER_PLAY = 'lay_play';
export const LAYER_EDIT = 'lay_edit';

/** Streaming window of the spawner, in columns beyond / behind the view. */
export const SPAWN_AHEAD = 4;
export const SPAWN_BEHIND = 3;
/** Camera: the player sits this far right of the view's left edge. */
export const CAMERA_X = 150;

export const MODES = ['cube', 'ship', 'ball', 'ufo', 'wave', 'robot', 'spider', 'swing'] as const;
export const SPEED_LABELS = ['0.5x', '1x', '2x', '3x', '4x'] as const;
/** Horizontal px/step at 60 Hz per speed (addendum table). */
export const SPEED_DX = [4.186, 5.193, 6.457, 7.8, 9.6] as const;

/** The header's defaults; canonical encoding omits fields holding them (except name and len). */
export const HEADER_DEFAULTS = {
  name: 'Untitled',
  author: '',
  len: 100,
  mode: 0,
  speed: 1,
  size: 0,
  diff: 1,
  bg: 0,
  beat: 30,
} as const;
export const HEADER_KEYS = ['name', 'author', 'len', 'mode', 'speed', 'size', 'diff', 'bg', 'beat'] as const;
export const MAGIC = 'GD1';

export interface TypeInfo {
  /** One-letter code used in the GD1 text and the editor. */
  code: string;
  name: string;
  /** Allowed parameter characters, in palette order; '' for none. The first is the default. */
  params: string;
  /**
   * The character each parameter is written as in GD1 text, aligned with
   * `params`. Digit-valued parameters use letters there because a digit
   * right after the row digits would be ambiguous (`G78.11`).
   */
  text: string;
  /** ASCII-map characters, aligned with `params` ('#' for the block). */
  legend: string;
  /** Human labels aligned with `params`. */
  labels: readonly string[];
  /** Object created by the spawner, or null for a tile. */
  object: string | null;
}

/**
 * The object types. Blocks become tiles; everything else becomes an instance
 * of `object` with `kind` = the parameter (a digit as an int, a colour letter
 * as a string) and, for coins, `index`.
 */
export const TYPES: Record<string, TypeInfo> = {
  B: { code: 'B', name: 'block', params: '', text: '', legend: '#', labels: ['block'], object: null },
  S: { code: 'S', name: 'spike', params: '01', text: 'ud', legend: '^v', labels: ['up', 'down'], object: 'obj_spike' },
  P: { code: 'P', name: 'pad', params: 'yprbw', text: 'yprbw', legend: 'YPRUW', labels: ['yellow', 'pink', 'red', 'blue', 'spider'], object: 'obj_pad' },
  O: {
    code: 'O', name: 'orb', params: 'yprbgkwd', text: 'yprbgkwd', legend: 'yprbgkwd',
    labels: ['yellow', 'pink', 'red', 'blue', 'green', 'black', 'spider', 'dash'], object: 'obj_orb',
  },
  G: { code: 'G', name: 'gravity portal', params: '01', text: 'nf', legend: 'nu', labels: ['normal', 'flipped'], object: 'obj_portal_gravity' },
  M: { code: 'M', name: 'mode portal', params: '01234567', text: 'csbuwrpg', legend: '01234567', labels: MODES, object: 'obj_portal_mode' },
  V: { code: 'V', name: 'speed portal', params: '01234', text: 'hndtq', legend: '-=+*!', labels: SPEED_LABELS, object: 'obj_portal_speed' },
  Z: { code: 'Z', name: 'size portal', params: '01', text: 'nm', legend: 'Mm', labels: ['normal', 'mini'], object: 'obj_portal_size' },
  C: { code: 'C', name: 'coin', params: '012', text: 'abc', legend: 'c', labels: ['coin 1', 'coin 2', 'coin 3'], object: 'obj_coin' },
};
export const TYPE_ORDER = ['B', 'S', 'P', 'O', 'G', 'M', 'V', 'Z', 'C'] as const;

export interface PaletteEntry {
  code: string;
  param: string;
  label: string;
}

/** The editor's palette, in display order (34 entries; the coin auto-indexes). */
export const PALETTE: readonly PaletteEntry[] = (() => {
  const entries: PaletteEntry[] = [];
  for (const code of TYPE_ORDER) {
    const type = TYPES[code];
    if (code === 'C') {
      entries.push({ code, param: '0', label: 'coin' });
      continue;
    }
    if (type.params === '') {
      entries.push({ code, param: '', label: type.name });
      continue;
    }
    for (let i = 0; i < type.params.length; i++) {
      entries.push({ code, param: type.params[i], label: `${type.labels[i]} ${type.name}` });
    }
  }
  return entries;
})();

// ---- geometry helpers (mirrored in gd_const) --------------------------------

export function cellX(col: number): number {
  return col * CELL + CELL / 2;
}
export function cellY(row: number): number {
  return FLOOR_Y - row * CELL - CELL / 2;
}
export function tileY(row: number): number {
  return ROWS - 1 - row;
}
export function colAt(x: number): number {
  return Math.floor(x / CELL);
}
export function rowAt(y: number): number {
  return Math.floor((FLOOR_Y - 1 - y) / CELL);
}
export function key(col: number, row: number): number {
  return col * ROWS + row;
}
export function unkey(k: number): [number, number] {
  return [Math.floor(k / ROWS), k % ROWS];
}

// ---- the generated Python module --------------------------------------------

function pyList(values: readonly (string | number)[]): string {
  return '[' + values.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))).join(', ') + ']';
}

/** The `gd_const` shared script: the same names, generated from this file. */
export function constantsPython(): string {
  const lines: string[] = [
    '# Generated by src/demo/gd/constants.ts -- do not edit by hand.',
    '# Units: 30 px blocks; level rows count UP from the floor (row 0 rests on it),',
    '# tile rows count down from the top of the layer.',
    'import math',
    '',
    `CELL = ${CELL}`,
    `ROWS = ${ROWS}`,
    `FLOOR_ROWS = ${FLOOR_ROWS}`,
    `LAYER_ROWS = ${LAYER_ROWS}`,
    `MAX_COLUMNS = ${MAX_COLUMNS}`,
    `FLOOR_Y = ${FLOOR_Y}`,
    `CEIL_Y = ${CEIL_Y}`,
    `ROOM_W = ${ROOM_W}`,
    `ROOM_H = ${ROOM_H}`,
    `VIEW_W = ${VIEW_W}`,
    `VIEW_H = ${VIEW_H}`,
    `SPAWN_COLS = ${SPAWN_COLS}`,
    `MAX_OBJECTS = ${MAX_OBJECTS}`,
    `MAX_COINS = ${MAX_COINS}`,
    `MAX_LEN = ${MAX_LEN}`,
    `MIN_LEN = ${MIN_LEN}`,
    `MAX_NAME = ${MAX_NAME}`,
    `TILE_BLOCK = ${TILE_BLOCK}`,
    `TILE_GROUND = ${TILE_GROUND}`,
    `LAYER_PLAY = ${JSON.stringify(LAYER_PLAY)}`,
    `LAYER_EDIT = ${JSON.stringify(LAYER_EDIT)}`,
    `SPAWN_AHEAD = ${SPAWN_AHEAD}`,
    `SPAWN_BEHIND = ${SPAWN_BEHIND}`,
    `CAMERA_X = ${CAMERA_X}`,
    `MODES = ${pyList(MODES)}`,
    `SPEED_LABELS = ${pyList(SPEED_LABELS)}`,
    `SPEED_DX = ${pyList(SPEED_DX)}`,
    `MAGIC = ${JSON.stringify(MAGIC)}`,
    `HEADER_KEYS = ${pyList(HEADER_KEYS)}`,
    'HEADER_DEFAULTS = {',
  ];
  for (const k of HEADER_KEYS) {
    const v = HEADER_DEFAULTS[k];
    lines.push(`    ${JSON.stringify(k)}: ${typeof v === 'string' ? JSON.stringify(v) : v},`);
  }
  lines.push('}', '', 'TYPE_ORDER = ' + pyList(TYPE_ORDER), '', 'TYPES = {');
  for (const code of TYPE_ORDER) {
    const t = TYPES[code];
    lines.push(
      `    ${JSON.stringify(code)}: {"code": ${JSON.stringify(code)}, "name": ${JSON.stringify(t.name)}, `
        + `"params": ${JSON.stringify(t.params)}, "text": ${JSON.stringify(t.text)}, "legend": ${JSON.stringify(t.legend)}, `
        + `"labels": ${pyList(t.labels)}, "object": ${t.object === null ? 'None' : JSON.stringify(t.object)}},`,
    );
  }
  lines.push('}', '', 'PALETTE = [');
  for (const entry of PALETTE) {
    lines.push(`    (${JSON.stringify(entry.code)}, ${JSON.stringify(entry.param)}, ${JSON.stringify(entry.label)}),`);
  }
  lines.push(
    ']',
    '',
    '',
    'def cell_x(col):',
    '    """Room x of the centre of a column."""',
    '    return col * CELL + CELL // 2',
    '',
    '',
    'def cell_y(row):',
    '    """Room y of the centre of a level row (rows count up from the floor)."""',
    '    return FLOOR_Y - row * CELL - CELL // 2',
    '',
    '',
    'def tile_y(row):',
    '    """Tile-layer row (counted from the top) of a level row."""',
    '    return ROWS - 1 - row',
    '',
    '',
    'def col_at(x):',
    '    return int(math.floor(x / CELL))',
    '',
    '',
    'def row_at(y):',
    '    return int(math.floor((FLOOR_Y - 1 - y) / CELL))',
    '',
    '',
    'def key(col, row):',
    '    """One int per cell, so objects can live in a dict."""',
    '    return col * ROWS + row',
    '',
    '',
    'def unkey(k):',
    '    return (k // ROWS, k % ROWS)',
    '',
  );
  return lines.join('\n');
}
