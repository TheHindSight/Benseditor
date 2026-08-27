/**
 * Geometry Dash clone: level data.
 *
 * Pure TypeScript. Holds the ASCII-map legend, the TS twin of the GD1 codec
 * (`gd_codec.py` is the runtime one; both are canonical and the tests round
 * trip every level through both), a mechanical balance checker built from the
 * plan's physics numbers, and the three built-in levels. `builtInPython()`
 * emits the `gd_levels` shared script.
 *
 * ASCII maps: a level is a list of chunks of equal height laid left to right;
 * each chunk is a list of lines, top line first, so the LAST line is row 0
 * (the row resting on the floor). Legend:
 *   .  empty        #  block         ^ v  spike up / down
 *   Y P R U W       pads: yellow pink red blue spider
 *   y p r b g k w d orbs: yellow pink red blue green black spider dash
 *   n u             gravity portal: normal / flipped
 *   0-7             mode portal: cube ship ball ufo wave robot spider swing
 *   - = + * !       speed portal: 0.5x 1x 2x 3x 4x
 *   M m             size portal: normal / mini
 *   c               coin (indexed 0,1,2 left to right)
 */

import {
  CELL, HEADER_DEFAULTS, HEADER_KEYS, MAGIC, MAX_COINS, MAX_LEN, MAX_NAME, MAX_OBJECTS, MIN_LEN, MODES,
  ROWS, SPAWN_COLS, SPEED_DX, SPEED_LABELS, TYPES, TYPE_ORDER, key,
} from './constants';

export interface LevelHeader {
  name: string;
  author: string;
  len: number;
  mode: number;
  speed: number;
  size: number;
  diff: number;
  bg: number;
  beat: number;
}

export interface LevelObject {
  code: string;
  col: number;
  row: number;
  param: string;
}

export interface Level {
  header: LevelHeader;
  objects: LevelObject[];
  /** Header keys the decoder did not know; dropped on re-encode. */
  extra: Record<string, string>;
}

export interface ColumnState {
  mode: number;
  speed: number;
  gravity: number;
  mini: number;
}

/** `[fromCol, toCol]`: the bot holds jump while fromCol*CELL <= x < (toCol+1)*CELL. */
export type HoldInterval = [number, number];

export interface BuiltInLevel {
  id: string;
  name: string;
  difficulty: number;
  beat: number;
  bg: number;
  speed: number;
  mode: number;
  chunks: string[][];
  solution: HoldInterval[];
}

const NAME_FORBIDDEN = ';|\n\r';

// ---- legend ----------------------------------------------------------------

/** ASCII character -> [code, param]; '#' is the block, '.' is nothing. */
export const LEGEND: Record<string, [string, string]> = (() => {
  const legend: Record<string, [string, string]> = {};
  for (const code of TYPE_ORDER) {
    const type = TYPES[code];
    if (type.params === '') {
      legend[type.legend] = [code, ''];
      continue;
    }
    for (let i = 0; i < type.legend.length; i++) legend[type.legend[i]] = [code, type.params[i]];
  }
  return legend;
})();

/** [code, param] -> ASCII character (coins all draw as 'c'). */
export function legendChar(code: string, param: string): string {
  const type = TYPES[code];
  if (!type) return '?';
  if (type.params === '') return type.legend;
  const at = type.params.indexOf(param);
  return at < 0 ? '?' : type.legend[Math.min(at, type.legend.length - 1)];
}

export function defaultParam(code: string): string {
  const params = TYPES[code]?.params ?? '';
  return params === '' ? '' : params[0];
}

/** In-memory parameter -> the character it is written as in GD1 text. */
export function paramToText(code: string, param: string): string {
  const info = TYPES[code];
  const at = info.params.indexOf(param);
  return at >= 0 && at < info.text.length ? info.text[at] : param;
}

/** GD1 text character -> in-memory parameter, or null when unknown. */
export function paramFromText(code: string, text: string): string | null {
  const info = TYPES[code];
  const at = info.text.indexOf(text);
  return at < 0 || at >= info.params.length ? null : info.params[at];
}

/**
 * Chunks -> objects. Coins are numbered left to right. Throws on an unknown
 * character or chunks of unequal height.
 */
export function mapToObjects(chunks: string[][]): LevelObject[] {
  const objects: LevelObject[] = [];
  let colBase = 0;
  const height = chunks[0]?.length ?? 0;
  for (const chunk of chunks) {
    if (chunk.length !== height) throw new Error(`chunk height ${chunk.length} differs from ${height}`);
    const width = Math.max(0, ...chunk.map((line) => line.length));
    for (let i = 0; i < chunk.length; i++) {
      const row = chunk.length - 1 - i;
      const line = chunk[i];
      for (let x = 0; x < line.length; x++) {
        const ch = line[x];
        if (ch === '.' || ch === ' ') continue;
        const entry = LEGEND[ch];
        if (!entry) throw new Error(`unknown map character '${ch}' at column ${colBase + x}, row ${row}`);
        objects.push({ code: entry[0], col: colBase + x, row, param: entry[1] });
      }
    }
    colBase += width;
  }
  objects.sort((a, b) => key(a.col, a.row) - key(b.col, b.row));
  let coin = 0;
  for (const o of objects) {
    if (o.code === 'C') o.param = String(Math.min(coin++, MAX_COINS - 1));
  }
  return objects;
}

/** Total width of a chunk list: the level length its finish sits at. */
export function chunksWidth(chunks: string[][]): number {
  let width = 0;
  for (const chunk of chunks) width += Math.max(0, ...chunk.map((line) => line.length));
  return width;
}

/** Objects -> ASCII lines (row `height-1` first), for the preview tool. */
export function objectsToMap(objects: LevelObject[], len: number, height = 12): string[] {
  const grid: string[][] = [];
  for (let r = 0; r < height; r++) grid.push(new Array(len).fill('.'));
  for (const o of objects) {
    if (o.row < height && o.col < len) grid[o.row][o.col] = legendChar(o.code, o.param);
  }
  const lines: string[] = [];
  for (let r = height - 1; r >= 0; r--) lines.push(grid[r].join(''));
  return lines;
}

// ---- codec (twin of gd_codec.py) ----------------------------------------------

export function newHeader(patch: Partial<LevelHeader> = {}): LevelHeader {
  return { ...HEADER_DEFAULTS, ...patch };
}

function cleanText(text: string): string {
  let out = text;
  for (const ch of NAME_FORBIDDEN) out = out.split(ch).join(' ');
  return out;
}

export function encodeHeader(header: Partial<LevelHeader>): string {
  const full = newHeader(header);
  const parts: string[] = [MAGIC];
  for (const k of HEADER_KEYS) {
    let value: string | number = full[k];
    if (k === 'name' || k === 'author') value = cleanText(String(value));
    else value = Math.trunc(Number(value));
    if (k !== 'name' && k !== 'len' && value === HEADER_DEFAULTS[k]) continue;
    parts.push(`${k}=${value}`);
  }
  return parts.join(';');
}

/** Objects as a canonical map: later entries at the same cell win. */
export function objectMap(objects: LevelObject[]): Map<number, LevelObject> {
  const map = new Map<number, LevelObject>();
  for (const o of objects) {
    const param = o.param === '' ? defaultParam(o.code) : o.param;
    map.set(key(o.col, o.row), { code: o.code, col: o.col, row: o.row, param });
  }
  return map;
}

export function encodeObjects(objects: LevelObject[]): string {
  const map = objectMap(objects);
  const keys = [...map.keys()].sort((a, b) => a - b);
  const consumed = new Set<number>();
  const out: string[] = [];
  for (const k of keys) {
    if (consumed.has(k)) continue;
    const o = map.get(k)!;
    let run = 1;
    for (;;) {
      const nk = key(o.col + run, o.row);
      const other = map.get(nk);
      if (!other || other.code !== o.code || other.param !== o.param || consumed.has(nk)) break;
      consumed.add(nk);
      run++;
    }
    let entry = `${o.code}${o.col}.${o.row}`;
    if (o.param !== defaultParam(o.code)) entry += paramToText(o.code, o.param);
    if (run > 1) entry += `*${run}`;
    out.push(entry);
  }
  return out.join(';');
}

export function encodeLevel(header: Partial<LevelHeader>, objects: LevelObject[]): string {
  return `${encodeHeader(header)}|${encodeObjects(objects)}`;
}

function parseEntry(entry: string, into: Map<number, LevelObject>): void {
  if (entry.length < 4) throw new Error(`bad object entry '${entry}'`);
  const code = entry[0];
  const info = TYPES[code];
  if (!info) throw new Error(`unknown object code '${code}' in '${entry}'`);
  let rest = entry.slice(1);
  let run = 1;
  const star = rest.indexOf('*');
  if (star >= 0) {
    run = Number(rest.slice(star + 1));
    if (!Number.isInteger(run) || run < 1) throw new Error(`bad run in '${entry}'`);
    rest = rest.slice(0, star);
  }
  const dot = rest.indexOf('.');
  if (dot <= 0) throw new Error(`missing '.' in '${entry}'`);
  const col = Number(rest.slice(0, dot));
  if (!Number.isInteger(col)) throw new Error(`bad column in '${entry}'`);
  rest = rest.slice(dot + 1);
  let digits = 0;
  while (digits < rest.length && rest[digits] >= '0' && rest[digits] <= '9') digits++;
  if (digits === 0) throw new Error(`bad row in '${entry}'`);
  const row = Number(rest.slice(0, digits));
  if (row >= ROWS) throw new Error(`row ${row} outside 0-${ROWS - 1} in '${entry}'`);
  let param = rest.slice(digits);
  if (param.length > 1) throw new Error(`bad parameter in '${entry}'`);
  if (param === '') param = defaultParam(code);
  else {
    const value = info.params === '' ? null : paramFromText(code, param);
    if (value === null) throw new Error(`unknown parameter '${param}' for ${info.name} in '${entry}'`);
    param = value;
  }
  for (let i = 0; i < run; i++) into.set(key(col + i, row), { code, col: col + i, row, param });
}

export function decodeLevel(text: string): Level {
  const trimmed = text.trim();
  const bar = trimmed.indexOf('|');
  const headerText = bar < 0 ? trimmed : trimmed.slice(0, bar);
  const body = bar < 0 ? '' : trimmed.slice(bar + 1);
  const fields = headerText.split(';');
  if (fields[0] !== MAGIC) throw new Error(`not a GD1 level (header starts with '${fields[0].slice(0, 8)}')`);
  const header = newHeader();
  const extra: Record<string, string> = {};
  for (const field of fields.slice(1)) {
    if (field === '') continue;
    const eq = field.indexOf('=');
    if (eq < 0) {
      extra[field] = '';
      continue;
    }
    const k = field.slice(0, eq);
    const raw = field.slice(eq + 1);
    if (k === 'name' || k === 'author') header[k] = raw;
    else if ((HEADER_KEYS as readonly string[]).includes(k)) {
      const n = Number(raw);
      const numeric = header as unknown as Record<string, number>;
      const defaults = HEADER_DEFAULTS as unknown as Record<string, number>;
      numeric[k] = Number.isFinite(n) ? Math.trunc(n) : defaults[k];
    } else extra[k] = raw;
  }
  const map = new Map<number, LevelObject>();
  for (const entry of body.split(';')) {
    const e = entry.trim();
    if (e !== '') parseEntry(e, map);
  }
  const objects = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, o]) => o);
  return { header, objects, extra };
}

export function nameOk(name: string): boolean {
  if (name.length < 1 || name.length > MAX_NAME || name.trim() === '') return false;
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (NAME_FORBIDDEN.includes(ch) || code < 32 || code > 126) return false;
  }
  return true;
}

/** The same problems gd_codec.validate_level reports (empty = playable). */
export function validateLevel(header: Partial<LevelHeader>, objects: LevelObject[]): string[] {
  const full = newHeader(header);
  const problems: string[] = [];
  if (!nameOk(full.name)) problems.push(`name must be 1-${MAX_NAME} printable characters without ; or |`);
  let len = full.len;
  if (!Number.isInteger(len) || len < MIN_LEN || len > MAX_LEN) {
    problems.push(`length must be between ${MIN_LEN} and ${MAX_LEN} columns`);
    len = Math.max(MIN_LEN, Math.min(MAX_LEN, Number.isInteger(len) ? len : MAX_LEN));
  }
  if (!Number.isInteger(full.mode) || full.mode < 0 || full.mode >= MODES.length) problems.push(`start mode must be 0-${MODES.length - 1}`);
  if (!Number.isInteger(full.speed) || full.speed < 0 || full.speed >= SPEED_LABELS.length) {
    problems.push(`start speed must be 0-${SPEED_LABELS.length - 1}`);
  }
  if (full.size !== 0 && full.size !== 1) problems.push('size must be 0 (normal) or 1 (mini)');
  if (!Number.isInteger(full.diff) || full.diff < 1 || full.diff > 10) problems.push('difficulty must be 1-10');
  const map = objectMap(objects);
  if (map.size > MAX_OBJECTS) problems.push(`too many objects (${map.size}, the limit is ${MAX_OBJECTS})`);
  let outOfBounds = 0;
  let runUp = 0;
  const coins = new Map<string, number>();
  for (const k of [...map.keys()].sort((a, b) => a - b)) {
    const o = map.get(k)!;
    const info = TYPES[o.code];
    if (!info) {
      problems.push(`unknown object code '${o.code}' at column ${o.col}`);
      continue;
    }
    if (info.params !== '' && !info.params.includes(o.param)) problems.push(`bad parameter '${o.param}' for ${info.name} at column ${o.col}`);
    if (o.col < 0 || o.row < 0 || o.row >= ROWS || o.col >= len) outOfBounds++;
    else if (o.col < SPAWN_COLS) runUp++;
    if (o.code === 'C') coins.set(o.param, (coins.get(o.param) ?? 0) + 1);
  }
  if (outOfBounds) problems.push(`${outOfBounds} object(s) outside the level (columns 0-${len - 1}, rows 0-${ROWS - 1})`);
  if (runUp) problems.push(`columns 0-${SPAWN_COLS - 1} must be empty (the run-up)`);
  let total = 0;
  for (const index of [...coins.keys()].sort()) {
    const count = coins.get(index)!;
    total += count;
    if (count > 1) problems.push(`coin ${index} is placed ${count} times (each index once)`);
  }
  if (total > MAX_COINS) problems.push(`at most ${MAX_COINS} coins`);
  return problems;
}

// ---- state strip ---------------------------------------------------------------

function applyState(state: ColumnState, code: string, param: string): void {
  if (code === 'M') state.mode = Number(param);
  else if (code === 'V') state.speed = Number(param);
  else if (code === 'Z') state.mini = Number(param);
  else if (code === 'G') state.gravity = Number(param);
  else if (code === 'P' && (param === 'b' || param === 'w')) state.gravity = 1 - state.gravity;
}

/** The state in force at every column (portals act at their own column). */
export function levelStates(header: Partial<LevelHeader>, objects: LevelObject[]): ColumnState[] {
  const full = newHeader(header);
  const state: ColumnState = { mode: full.mode, speed: full.speed, gravity: 0, mini: full.size ? 1 : 0 };
  const sorted = [...objectMap(objects).values()].sort((a, b) => key(a.col, a.row) - key(b.col, b.row));
  const out: ColumnState[] = [];
  let at = 0;
  for (let col = 0; col < full.len; col++) {
    while (at < sorted.length && sorted[at].col <= col) {
      applyState(state, sorted[at].code, sorted[at].param);
      at++;
    }
    out.push({ ...state });
  }
  return out;
}

export function stateAtColumn(header: Partial<LevelHeader>, objects: LevelObject[], col: number): ColumnState {
  const states = levelStates({ ...header, len: Math.max(newHeader(header).len, col + 1) }, objects);
  return states[Math.max(0, Math.min(col, states.length - 1))];
}

// ---- balance checker -------------------------------------------------------------
//
// Mechanical rules from the plan's addendum, computed per column from the
// state in force there. They are conservative approximations (no physics is
// run): a level passing them is not proven completable, but one failing them
// breaks a known rule of thumb.

/** Max consecutive ground spikes per speed (0.5x..4x); mini is stricter. */
export const MAX_SPIKES = [2, 3, 4, 4, 6] as const;
export const MAX_SPIKES_MINI = [1, 2, 2, 3, 4] as const;
/** Max width of a spike-filled pit jumped from a ledge, per speed. */
export const MAX_PIT = [3, 4, 5, 6, 8] as const;
export const MAX_PIT_MINI = [2, 3, 3, 4, 5] as const;
export const MAX_STEP_UP = 2;
export const MAX_STEP_UP_MINI = 1;
/** Free rows required above the surface around a forced jump (3.2 blocks, robot 4.5). */
export const JUMP_CLEARANCE = 3;
export const ROBOT_CLEARANCE = 4;
/** Minimum free vertical gap (blocks) per mode for the corridor modes. */
export const MIN_GAP: Record<number, number> = { 1: 2, 2: 2, 3: 3, 4: 2, 6: 2, 7: 2 };
export const GROUND_MODES = new Set([0, 5]);
export const CORRIDOR_MODES = new Set([1, 2, 3, 4, 6, 7]);
/** Spike-free columns after a mode / speed portal. */
export const MODE_PORTAL_CLEAR = 4;
export const SPEED_PORTAL_CLEAR = 2;

interface ColumnCells {
  blocks: Set<number>;
  spikesUp: Set<number>;
  spikesDown: Set<number>;
}

function columnCells(objects: LevelObject[], len: number): ColumnCells[] {
  const cols: ColumnCells[] = [];
  for (let c = 0; c < len; c++) cols.push({ blocks: new Set(), spikesUp: new Set(), spikesDown: new Set() });
  for (const o of objectMap(objects).values()) {
    if (o.col < 0 || o.col >= len) continue;
    if (o.code === 'B') cols[o.col].blocks.add(o.row);
    else if (o.code === 'S') (o.param === '1' ? cols[o.col].spikesDown : cols[o.col].spikesUp).add(o.row);
  }
  return cols;
}

/**
 * The corridor at a column: the lowest free vertical gap [lo, hi) of rows
 * without blocks or spikes that is at least two rows tall (the player travels
 * near the floor; the sky above an authored ceiling is not the corridor), or
 * the largest gap when none is.
 */
function freeGap(cells: ColumnCells, height: number): [number, number] {
  let best: [number, number] = [0, 0];
  let start = 0;
  for (let r = 0; r <= height; r++) {
    const blocked = r === height || cells.blocks.has(r) || cells.spikesUp.has(r) || cells.spikesDown.has(r);
    if (blocked) {
      if (r - start >= 2) return [start, r];
      if (r - start > best[1] - best[0]) best = [start, r];
      start = r + 1;
    }
  }
  return best;
}

export function balanceIssues(header: Partial<LevelHeader>, objects: LevelObject[]): string[] {
  const full = newHeader(header);
  const len = full.len;
  const issues: string[] = [];
  const states = levelStates(full, objects);
  const cols = columnCells(objects, len);
  const height = ROWS;
  const map = objectMap(objects);

  for (const o of map.values()) if (o.col < SPAWN_COLS) issues.push(`column ${o.col}: the run-up (0-${SPAWN_COLS - 1}) must be empty`);

  // Portal clearances.
  for (const o of map.values()) {
    const clear = o.code === 'M' ? MODE_PORTAL_CLEAR : o.code === 'V' ? SPEED_PORTAL_CLEAR : 0;
    for (let c = o.col + 1; c <= o.col + clear && c < len; c++) {
      if (cols[c].spikesUp.size || cols[c].spikesDown.size) {
        issues.push(`column ${c}: spike within ${clear} columns after the ${TYPES[o.code].name} at ${o.col}`);
      }
    }
  }

  // Ground modes, normal gravity: walk the surface.
  let surface = 0;
  let deadlyRun = 0;
  let pitStart = -1;
  let pitFrom = 0;
  let pitAllDeadly = true;
  let prevGround = false;
  for (let c = 0; c < len; c++) {
    const st = states[c];
    const ground = GROUND_MODES.has(st.mode) && st.gravity === 0;
    const cell = cols[c];
    if (!ground) {
      surface = 0;
      deadlyRun = 0;
      pitStart = -1;
      prevGround = false;
      continue;
    }
    const maxStep = st.mini ? MAX_STEP_UP_MINI : MAX_STEP_UP;
    // Highest reachable block top (<= previous surface + step); the floor otherwise.
    let top = 0;
    for (const r of cell.blocks) if (r + 1 <= surface + maxStep && r + 1 > top) top = r + 1;
    let wallTop = 0;
    for (const r of cell.blocks) if (r + 1 > top && r + 1 > wallTop && r <= top + 1) wallTop = r + 1;
    if (prevGround && wallTop > 0 && wallTop - surface > maxStep) issues.push(`column ${c}: wall ${wallTop - surface} blocks high (max step-up ${maxStep})`);
    const prevSurface = surface;
    surface = top;
    const deadly = cell.spikesUp.has(surface);
    if (deadly) {
      deadlyRun++;
      const maxRun = (st.mini ? MAX_SPIKES_MINI : MAX_SPIKES)[st.speed];
      if (deadlyRun === maxRun + 1) issues.push(`column ${c}: more than ${maxRun} spikes in a row at ${SPEED_LABELS[st.speed]}${st.mini ? ' mini' : ''}`);
      // Clearance above a forced jump: rows surface+1 .. surface+clearance free of blocks nearby.
      const clearance = st.mode === 5 ? ROBOT_CLEARANCE : JUMP_CLEARANCE;
      for (let n = Math.max(0, c - 2); n <= Math.min(len - 1, c + 2); n++) {
        for (let r = surface + 1; r <= surface + clearance; r++) {
          if (cols[n].blocks.has(r)) issues.push(`column ${n}: block at row ${r} within ${clearance} rows above the jump over the spike at ${c}`);
        }
      }
    } else deadlyRun = 0;
    // Pits: a drop whose columns are all deadly until the surface comes back up.
    if (prevGround && surface < prevSurface && pitStart < 0) {
      pitStart = c;
      pitFrom = prevSurface;
      pitAllDeadly = true;
    }
    if (pitStart >= 0) {
      if (surface >= pitFrom) {
        const width = c - pitStart;
        const maxPit = (st.mini ? MAX_PIT_MINI : MAX_PIT)[st.speed];
        if (pitAllDeadly && width > maxPit) issues.push(`column ${pitStart}: spike pit ${width} wide (max ${maxPit} at ${SPEED_LABELS[st.speed]})`);
        pitStart = -1;
      } else if (!deadly) pitAllDeadly = false;
    }
    prevGround = true;
  }

  // Ground modes, flipped gravity: the ceiling is the surface.
  let ceilRow = -1;
  let ceilRun = 0;
  let prevFlipped = false;
  for (let c = 0; c < len; c++) {
    const st = states[c];
    const flipped = GROUND_MODES.has(st.mode) && st.gravity === 1;
    if (!flipped) {
      prevFlipped = false;
      ceilRun = 0;
      ceilRow = -1;
      continue;
    }
    const cell = cols[c];
    let lowest = -1;
    for (const r of cell.blocks) if (lowest < 0 || r < lowest) lowest = r;
    if (lowest < 0) {
      issues.push(`column ${c}: flipped gravity with no ceiling to run on`);
      prevFlipped = false;
      continue;
    }
    const maxStep = st.mini ? MAX_STEP_UP_MINI : MAX_STEP_UP;
    if (prevFlipped && ceilRow >= 0 && ceilRow - lowest > maxStep) issues.push(`column ${c}: ceiling steps down ${ceilRow - lowest} blocks (max ${maxStep})`);
    ceilRow = lowest;
    if (cell.spikesDown.has(lowest - 1)) {
      ceilRun++;
      const maxRun = (st.mini ? MAX_SPIKES_MINI : MAX_SPIKES)[st.speed];
      if (ceilRun === maxRun + 1) issues.push(`column ${c}: more than ${maxRun} ceiling spikes in a row at ${SPEED_LABELS[st.speed]}`);
    } else ceilRun = 0;
    prevFlipped = true;
  }

  // Corridor modes: enough room, and slopes of at most one block per column.
  let prevGap: [number, number] | null = null;
  let prevMode = -1;
  for (let c = 0; c < len; c++) {
    const st = states[c];
    if (!CORRIDOR_MODES.has(st.mode)) {
      prevGap = null;
      prevMode = -1;
      continue;
    }
    const gap = freeGap(cols[c], height);
    const size = gap[1] - gap[0];
    const need = MIN_GAP[st.mode] ?? 2;
    if (size < need) issues.push(`column ${c}: ${MODES[st.mode]} corridor only ${size} blocks (min ${need})`);
    if (prevGap && prevMode === st.mode) {
      if (gap[0] - prevGap[0] > 1) issues.push(`column ${c}: corridor floor climbs ${gap[0] - prevGap[0]} blocks in one column`);
      if (prevGap[1] <= 8 && prevGap[1] - gap[1] > 1) issues.push(`column ${c}: corridor ceiling drops ${prevGap[1] - gap[1]} blocks in one column`);
    }
    prevGap = gap;
    prevMode = st.mode;
  }
  // Robot: the sky must be high.
  for (let c = 0; c < len; c++) {
    if (states[c].mode !== 5) continue;
    const gap = freeGap(cols[c], height);
    if (gap[1] - gap[0] < ROBOT_CLEARANCE + 1) issues.push(`column ${c}: robot ceiling only ${gap[1] - gap[0]} blocks (min ${ROBOT_CLEARANCE + 1})`);
  }
  return issues;
}

/** Reach numbers per speed from the addendum, for the preview tool. */
export function reachTable(): { speed: string; dx: number; apex: number; jump: number; d20: number; spikes: number; pit: number }[] {
  const apex = [2.0, 2.17, 2.27, 2.19, 2.19];
  const jump = [3.5, 4.49, 5.71, 6.75, 8.31];
  const d20 = [85.8, 112.1, 143.9, 168.9, 207.8];
  return SPEED_LABELS.map((speed, i) => ({
    speed, dx: SPEED_DX[i], apex: apex[i], jump: jump[i], d20: d20[i], spikes: MAX_SPIKES[i], pit: MAX_PIT[i],
  }));
}

// ---- built-in levels ---------------------------------------------------------------

export const CHUNK_HEIGHT = 12;

/** A chunk from its non-empty rows: `{ row: line }`, lines padded to `width`. */
function chunk(width: number, rows: Record<number, string>): string[] {
  const lines: string[] = [];
  for (let r = CHUNK_HEIGHT - 1; r >= 0; r--) {
    const line = rows[r] ?? '';
    if (line.length > width) throw new Error(`row ${r} is ${line.length} wide, chunk is ${width}`);
    lines.push(line.padEnd(width, '.'));
  }
  return lines;
}

const dots = (n: number) => '.'.repeat(n);
const blocks = (n: number) => '#'.repeat(n);

/**
 * Level 1 -- cube only, 1x. Single spikes, low platforms, one yellow pad, one
 * optional yellow orb and a gravity-portal pair along an authored ceiling.
 * The first coin sits on the ground before any hazard (the end-screen test
 * collects it).
 */
const LEVEL_1: BuiltInLevel = {
  id: 'b1',
  name: 'Stereo Steps',
  difficulty: 1,
  beat: 30,
  bg: 0,
  speed: 1,
  mode: 0,
  chunks: [
    // 0-39: coin, two single spikes, a 1-high platform.
    chunk(40, {
      0: dots(12) + 'c' + dots(5) + '^' + dots(5) + '^' + dots(5) + blocks(4),
    }),
    // 40-79: double spike, yellow pad, spike + optional orb, two 1-block steps, the flip portal.
    chunk(40, {
      5: dots(36) + blocks(4),
      2: dots(21) + 'y' + dots(8) + 'c',
      1: dots(29) + blocks(4) + dots(5) + 'u',
      0: '^^' + dots(6) + 'Y' + dots(11) + '^' + dots(5) + blocks(7),
    }),
    // 80-115: the ceiling run with two hanging spikes and a coin, back to normal, one last spike.
    chunk(36, {
      5: blocks(23),
      4: dots(8) + 'v' + dots(2) + 'c' + dots(2) + 'v',
      3: dots(20) + 'n',
      0: dots(28) + '^',
    }),
  ],
  solution: [
    [16.2, 16.2], [22.2, 22.2], [28.3, 28.3], [38.5, 38.5], [58.2, 58.2], [64.3, 64.3], [67.3, 67.3],
    [86.2, 86.2], [92.2, 92.2], [106.2, 106.2],
  ],
};

/**
 * Level 2 -- adds a ship corridor (4 blocks, one gentle ceiling step), pink and
 * red pads with a coin in the red flight, a mini portal pair, a speed portal
 * pair to 2x, an optional blue orb under an authored ceiling, three coins.
 */
const LEVEL_2: BuiltInLevel = {
  id: 'b2',
  name: 'Sky Lanes',
  difficulty: 3,
  beat: 24,
  bg: 1,
  speed: 1,
  mode: 0,
  chunks: [
    // 0-47: spikes, coin, pink pad over a spike, red pad over a double with a coin in the air.
    chunk(48, {
      7: dots(38) + 'c',
      0: dots(12) + '^' + dots(3) + '^^' + dots(2) + 'c' + dots(3) + 'P' + '.' + '^' + dots(7) + 'R' + dots(2) + '^^',
    }),
    // 48-89: ship portal, corridor under a ceiling at row 4 (row 3 for 66-72), floor spike, ceiling spike, coin, cube portal.
    chunk(42, {
      4: dots(2) + blocks(35),
      3: dots(14) + 'v' + dots(3) + blocks(7),
      2: dots(28) + 'c',
      1: '1' + dots(33) + '0',
      0: dots(8) + '^',
    }),
    // 90-117: mini portal, two single spikes, a 1-high platform, back to normal size.
    chunk(28, {
      1: 'm' + dots(21) + 'M',
      0: dots(4) + '^' + dots(3) + '^' + dots(5) + blocks(4),
    }),
    // 118-169: 2x, two doubles, optional blue orb under a ceiling with a normal portal, back to 1x, last spike.
    chunk(52, {
      5: dots(16) + blocks(17),
      3: dots(28) + 'n',
      1: '+' + dots(37) + '=',
      0: dots(6) + '^^' + dots(4) + '^^' + dots(6) + 'b' + dots(3) + '^' + dots(19) + '^',
    }),
  ],
  solution: [
    [10.2, 10.2], [14.5, 14.5], [53, 55], [73, 75], [92.7, 92.7], [96.7, 96.7], [101.8, 101.8],
    [121.7, 121.7], [127.7, 127.7], [140, 140], [160.2, 160.2],
  ],
};

/**
 * Level 3 -- every mode, every speed, both sizes, every pad and orb.
 * Sections: cube 1x pads -> 3x triple -> ship 3x -> wave 1x -> ball -> UFO 2x
 * -> robot -> spider 1x -> swing 0.5x -> cube 4x -> flip garden and orbs at 1x
 * -> mini finale. Orbs are optional (both paths are safe); pads are on the
 * path. Portals in corridors are doubled at rows 1 and 3 so they catch the
 * player on either surface.
 */
const LEVEL_3: BuiltInLevel = {
  id: 'b3',
  name: 'Octane',
  difficulty: 6,
  beat: 20,
  bg: 2,
  speed: 1,
  mode: 0,
  chunks: [
    // A 0-43: spike, pink pad over a spike, red pad over a double (coin in the flight), yellow pad over a double.
    chunk(44, {
      7: dots(28) + 'c',
      0: dots(12) + '^' + dots(3) + 'P' + '.' + '^' + dots(5) + 'R' + dots(2) + '^^' + dots(5) + 'Y' + '.' + '^^',
    }),
    // B 44-59: 3x, a triple, the ship portal.
    chunk(16, {
      1: '*' + dots(13) + '1',
      0: dots(6) + '^^^',
    }),
    // C 60-99: ship at 3x under a ceiling at row 5; floor spike, ceiling spike, double; 1x; wave portal.
    chunk(40, {
      5: blocks(40),
      4: dots(14) + 'v',
      1: dots(30) + '=' + dots(5) + '4',
      0: dots(6) + '^' + dots(15) + '^^',
    }),
    // D 100-127: wave at 1x under a ceiling at row 4; three floor teeth and one hanging block.
    chunk(28, {
      4: blocks(28),
      3: dots(18) + '#',
      0: dots(6) + '#' + dots(7) + '#' + dots(7) + '#',
    }),
    // E 128-169: ball portal; floor spike, ceiling spike, coin, floor spike; UFO portal then a normal-gravity portal (doubled).
    chunk(42, {
      4: blocks(42),
      3: dots(18) + 'v' + dots(17) + '3' + '.' + 'n',
      1: '2' + dots(35) + '3' + '.' + 'n',
      0: dots(8) + '^' + dots(13) + 'c' + dots(5) + '^',
    }),
    // F 170-199: 2x (doubled), UFO under a ceiling to 197; three floor spikes, a harmless ceiling spike; robot portal (doubled).
    chunk(30, {
      4: blocks(28),
      3: '+' + dots(9) + 'v' + dots(17) + '5',
      1: '+' + dots(27) + '5',
      0: dots(6) + '^' + dots(7) + '^' + dots(7) + '^',
    }),
    // G 200-239: robot in the open; single, double, single; spider portal, 1x; the next ceiling begins.
    chunk(40, {
      4: dots(36) + blocks(4),
      1: dots(34) + '6' + dots(3) + '=',
      0: dots(8) + '^' + dots(7) + '^^' + dots(8) + '^',
    }),
    // H 240-279: spider under a ceiling at row 4; spider pad up, ceiling spike, floor spike, optional spider orb; swing, normal gravity, 0.5x (all doubled).
    chunk(40, {
      4: blocks(40),
      3: dots(12) + 'v' + dots(13) + 'w' + dots(7) + '7' + '.' + 'n' + '.' + '-',
      1: dots(34) + '7' + '.' + 'n' + '.' + '-',
      0: dots(4) + 'W' + dots(15) + '^',
    }),
    // I 280-327: swing at 0.5x; floor/ceiling spikes alternate; cube portal + normal gravity under the ceiling's end; 4x.
    chunk(48, {
      4: blocks(45),
      3: dots(14) + 'v' + dots(11) + 'v' + dots(11) + '0' + dots(3) + 'n',
      1: dots(38) + '0' + dots(3) + 'n' + dots(3) + '!',
      0: dots(8) + '^' + dots(11) + '^' + dots(11) + '^',
    }),
    // J 328-363: cube at 4x, a quad and a triple, back to 1x.
    chunk(36, {
      1: dots(32) + '=',
      0: dots(12) + '^^^^' + dots(8) + '^^^',
    }),
    // K 364-431: flip garden under a ceiling at row 5 (blue pad up, green orb, blue orb, normal portal), coin, the other orbs.
    chunk(68, {
      5: blocks(33),
      4: dots(12) + 'g',
      3: dots(28) + 'n',
      0: dots(4) + 'U' + dots(15) + 'b' + dots(15) + 'c' + dots(3) + 'y' + dots(5) + 'p' + dots(5) + 'r' + dots(5) + 'k' + dots(5) + 'd',
    }),
    // L 432-471: mini finale: two spikes, a 1-high platform, normal size, one last spike.
    chunk(40, {
      1: dots(2) + 'm' + dots(25) + 'M',
      0: dots(8) + '^' + dots(5) + '^' + dots(5) + blocks(4) + dots(10) + '^',
    }),
  ],
  solution: [
    [10.2, 10.2], [47.5, 47.5], [61, 64], [78, 81], [104.5, 106], [112.5, 114], [120.5, 122],
    [134, 134], [144, 144], [154, 154], [174.5, 174.5], [182.5, 182.5], [190.5, 190.5],
    [205.5, 206.5], [213.5, 215], [223.5, 224.5], [250.5, 250.5], [258.5, 258.5],
    [285, 285], [291, 291], [297, 297], [303, 303], [309, 309], [337, 337], [349.2, 349.2],
    [438.7, 438.7], [444.7, 444.7], [449.8, 449.8], [464.2, 464.2],
  ],
};

export const LEVELS: readonly BuiltInLevel[] = [LEVEL_1, LEVEL_2, LEVEL_3];

export function levelHeader(level: BuiltInLevel): LevelHeader {
  return newHeader({
    name: level.name,
    author: 'Benseditor',
    len: chunksWidth(level.chunks),
    mode: level.mode,
    speed: level.speed,
    size: 0,
    diff: level.difficulty,
    bg: level.bg,
    beat: level.beat,
  });
}

export function levelObjects(level: BuiltInLevel): LevelObject[] {
  return mapToObjects(level.chunks);
}

export function levelData(level: BuiltInLevel): string {
  return encodeLevel(levelHeader(level), levelObjects(level));
}

export function findLevel(id: string): BuiltInLevel | undefined {
  return LEVELS.find((level) => level.id === id);
}

/** Every (code, param) pair the built-in set uses -- the coverage rule. */
export function usedParams(levels: readonly BuiltInLevel[] = LEVELS): Set<string> {
  const used = new Set<string>();
  for (const level of levels) {
    for (const o of levelObjects(level)) used.add(`${o.code}${o.param}`);
  }
  return used;
}

/** Every (code, param) pair the TYPES table defines. */
export function allParams(): Set<string> {
  const all = new Set<string>();
  for (const code of TYPE_ORDER) {
    const type = TYPES[code];
    if (type.params === '') all.add(code);
    else for (const p of type.params) all.add(`${code}${p}`);
  }
  return all;
}

/** The `gd_levels` shared script: BUILTIN = [{id, name, difficulty, data, solution}, ...]. */
export function builtInPython(): string {
  const lines = [
    '# Generated by src/demo/gd/levels.ts -- do not edit by hand.',
    '# The built-in levels as GD1 text plus the bot solution: hold intervals',
    `# [from_col, to_col] -- hold jump while from_col * ${CELL} <= x < (to_col + 1) * ${CELL}.`,
    '',
    'BUILTIN = [',
  ];
  for (const level of LEVELS) {
    lines.push('    {');
    lines.push(`        "id": ${JSON.stringify(level.id)},`);
    lines.push(`        "name": ${JSON.stringify(level.name)},`);
    lines.push(`        "difficulty": ${level.difficulty},`);
    lines.push(`        "len": ${chunksWidth(level.chunks)},`);
    lines.push(`        "data": ${JSON.stringify(levelData(level))},`);
    lines.push(`        "solution": [${level.solution.map(([a, b]) => `[${a}, ${b}]`).join(', ')}],`);
    lines.push('    },');
  }
  lines.push(
    ']',
    '',
    '',
    'def builtin_level(level_id):',
    '    for entry in BUILTIN:',
    '        if entry["id"] == level_id:',
    '            return entry',
    '    return None',
    '',
  );
  return lines.join('\n');
}
