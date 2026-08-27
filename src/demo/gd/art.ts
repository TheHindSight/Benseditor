/**
 * Geometry Dash art: every sprite and the tileset, as character grids.
 *
 * Hand-drawn pieces (icons, vehicles, coin, star, checkpoint) are ASCII rows;
 * the purely geometric ones (spike, orbs, portals, tiles, the title's block
 * letters) are painted onto a character grid first so their outlines come out
 * exact. Everything ends as base64 PNG frames through `frameFromAscii`, which
 * needs a DOM canvas -- so this module is build-time only (index.ts), never
 * loaded by the Node tests.
 *
 * Player sprites (spr_icon_0..3 and every mode vehicle) share one frame layout:
 *   0 outline only, 1 primary mask (white), 2 secondary mask (white),
 *   3 flat composite (outline + white body) for drawing without tints.
 * `icon_draw` tints frames 1 and 2 with the chosen colours and lays frame 0
 * on top.
 */
import { DEFAULT_PALETTE, FORMAT_VERSION, type SpriteFile, type TilesetFile } from '../../project/types';
import { frameFromAscii } from '../art';

export const GD_CELL = 30;

const BLACK = '#000000';
const WHITE = '#ffffff';
const P8 = {
  darkBlue: '#1d2b53',
  purple: '#7e2553',
  darkGreen: '#008751',
  brown: '#ab5236',
  darkGray: '#5f574f',
  lightGray: '#c2c3c7',
  cream: '#fff1e8',
  red: '#ff004d',
  orange: '#ffa300',
  yellow: '#ffec27',
  green: '#00e436',
  blue: '#29adff',
  indigo: '#83769c',
  pink: '#ff77a8',
  peach: '#ffccaa',
};

type Collision = SpriteFile['collision'];

const rect = (left: number, top: number, right: number, bottom: number): Collision => ({ mode: 'rect', left, top, right, bottom });
const FULL_30 = rect(0, 0, 29, 29);

/** Right-pad rows to `width` with transparent pixels; a longer row is a typo. */
function pad(rows: string[], width: number, height: number, name: string): string[] {
  if (rows.length !== height) throw new Error(`${name}: expected ${height} rows, got ${rows.length}`);
  return rows.map((row, i) => {
    if (row.length > width) throw new Error(`${name}: row ${i} is ${row.length} wide, max ${width}`);
    return row + '.'.repeat(width - row.length);
  });
}

function sprite(
  name: string,
  width: number,
  height: number,
  frames: string[],
  collision: Collision,
  origin?: { x: number; y: number },
  fps = 0,
): SpriteFile {
  return {
    kind: 'sprite',
    version: FORMAT_VERSION,
    name,
    width,
    height,
    originX: origin ? origin.x : Math.floor(width / 2),
    originY: origin ? origin.y : Math.floor(height / 2),
    fps,
    frames,
    palette: [...DEFAULT_PALETTE],
    collision,
  };
}

// ---- a character grid painter ------------------------------------------------

class Grid {
  readonly width: number;
  readonly height: number;
  private cells: string[][];

  constructor(width: number, height: number, fill = '.') {
    this.width = width;
    this.height = height;
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => fill));
  }

  set(x: number, y: number, ch: string): void {
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.cells[y][x] = ch;
  }

  get(x: number, y: number): string {
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? this.cells[y][x] : '.';
  }

  fillRect(x1: number, y1: number, x2: number, y2: number, ch: string): void {
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) this.set(x, y, ch);
  }

  /** A `thickness`-pixel border just inside the rectangle. */
  frame(x1: number, y1: number, x2: number, y2: number, ch: string, thickness = 1): void {
    for (let t = 0; t < thickness; t++) {
      for (let x = x1 + t; x <= x2 - t; x++) {
        this.set(x, y1 + t, ch);
        this.set(x, y2 - t, ch);
      }
      for (let y = y1 + t; y <= y2 - t; y++) {
        this.set(x1 + t, y, ch);
        this.set(x2 - t, y, ch);
      }
    }
  }

  /** Pixels whose centre lies between rIn and rOut from (cx, cy). */
  ring(cx: number, cy: number, rIn: number, rOut: number, ch: string): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= rIn && d < rOut) this.set(x, y, ch);
      }
    }
  }

  disc(cx: number, cy: number, r: number, ch: string): void {
    this.ring(cx, cy, 0, r, ch);
  }

  /** Surround every non-empty pixel with `ch` (8-neighbour dilation). */
  outline(ch: string): void {
    const marks: [number, number][] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.get(x, y) !== '.') continue;
        let touching = false;
        for (let dy = -1; dy <= 1 && !touching; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const n = this.get(x + dx, y + dy);
            if (n !== '.' && n !== ch) {
              touching = true;
              break;
            }
          }
        }
        if (touching) marks.push([x, y]);
      }
    }
    for (const [x, y] of marks) this.set(x, y, ch);
  }

  rows(): string[] {
    return this.cells.map((row) => row.join(''));
  }
}

// ---- player sprites: outline / primary / secondary / composite ---------------

/** `k` outline, `p` primary, `s` secondary, `w` fixed white detail. */
function maskFrames(rows: string[]): string[] {
  return [
    frameFromAscii(rows, { k: BLACK, w: WHITE }),
    frameFromAscii(rows, { p: WHITE }),
    frameFromAscii(rows, { s: WHITE }),
    frameFromAscii(rows, { k: BLACK, p: WHITE, s: P8.lightGray, w: WHITE }),
  ];
}

const K30 = 'k'.repeat(30);
const BODY = 'kk' + 'p'.repeat(26) + 'kk';
const rep = (row: string, n: number): string[] => Array.from({ length: n }, () => row);

/** Classic cube: bordered face, inner square frame, two square eyes, a mouth. */
const ICON_0 = [
  ...rep(K30, 2),
  ...rep(BODY, 2),
  ...rep('kkpp' + 's'.repeat(22) + 'ppkk', 2),
  ...rep('kkppss' + 'p'.repeat(18) + 'ssppkk', 4),
  ...rep('kkppss' + 'pppkkkkppppkkkkppp' + 'ssppkk', 4),
  ...rep('kkppss' + 'p'.repeat(18) + 'ssppkk', 4),
  ...rep('kkppss' + 'ppkkkkkkkkkkkkkkpp' + 'ssppkk', 2),
  ...rep('kkppss' + 'p'.repeat(18) + 'ssppkk', 2),
  ...rep('kkpp' + 's'.repeat(22) + 'ppkk', 2),
  ...rep(BODY, 4),
  ...rep(K30, 2),
];

/** Visor cube: a dark band with a bright slit, corner studs below. */
const ICON_1 = [
  ...rep(K30, 2),
  ...rep(BODY, 4),
  ...rep('kkpp' + 's'.repeat(22) + 'ppkk', 2),
  ...rep('kkppss' + 'k'.repeat(18) + 'ssppkk', 2),
  ...rep('kkppsskk' + 'w'.repeat(14) + 'kkssppkk', 4),
  ...rep('kkppss' + 'k'.repeat(18) + 'ssppkk', 2),
  ...rep('kkpp' + 's'.repeat(22) + 'ppkk', 2),
  ...rep(BODY, 2),
  ...rep('kkppssss' + 'p'.repeat(14) + 'ssssppkk', 4),
  ...rep(BODY, 4),
  ...rep(K30, 2),
];

/** Cross: a secondary plus through the face, eyes either side of the bar. */
const ICON_2 = [
  ...rep(K30, 2),
  ...rep(BODY, 2),
  ...rep('kk' + 'p'.repeat(10) + 'ssssss' + 'p'.repeat(10) + 'kk', 4),
  ...rep('kk' + 'ppkkkkpp' + 'pp' + 'ssssss' + 'pp' + 'ppkkkkpp' + 'kk', 4),
  ...rep('kk' + 's'.repeat(26) + 'kk', 6),
  ...rep('kk' + 'p'.repeat(10) + 'ssssss' + 'p'.repeat(10) + 'kk', 8),
  ...rep(BODY, 2),
  ...rep(K30, 2),
];

/** Circuit: a trace frame, a central chip with a dark core, traces to it. */
const ICON_3 = [
  ...rep(K30, 2),
  ...rep(BODY, 2),
  ...rep('kkpp' + 's'.repeat(22) + 'ppkk', 2),
  ...rep('kkppss' + 'ppppppppsspppppppp' + 'ssppkk', 5),
  ...rep('kkppss' + 'ppp' + 's'.repeat(12) + 'ppp' + 'ssppkk', 2),
  ...rep('kkppss' + 'pppss' + 'kkkkkkkk' + 'ssppp' + 'ssppkk', 1),
  ...rep('kkppss' + 'sssss' + 'kkkkkkkk' + 'sssss' + 'ssppkk', 2),
  ...rep('kkppss' + 'pppss' + 'kkkkkkkk' + 'ssppp' + 'ssppkk', 1),
  ...rep('kkppss' + 'ppp' + 's'.repeat(12) + 'ppp' + 'ssppkk', 2),
  ...rep('kkppss' + 'ppppppppsspppppppp' + 'ssppkk', 5),
  ...rep('kkpp' + 's'.repeat(22) + 'ppkk', 2),
  ...rep(BODY, 2),
  ...rep(K30, 2),
];

const SHIP = pad([
  '',
  '',
  '',
  '',
  '',
  '',
  '..........kkkkkkkk',
  '.........ksssssssssk',
  '........ksssssssssssk',
  '........kssssssssssssk',
  '.kkkkkkkkkkkkkkkkkkkkkkkkkk',
  'kkppppppppppppppppppppppppkkk',
  'kpppppppppppppppppppppppppppkk',
  'kppssssssppppppppppppppppppppk',
  'kppssssssppppppppppppppppppppk',
  'kppppppppppppppppppppppppppppk',
  'kkppppppppppppppppppppppppppkk',
  '.kkppppppppppppppppppppppkkkk',
  '..kkkkkkkkkkkkkkkkkkkkkkkk',
  '...kkkkk',
  '..kpssspk',
  '..kpssspk',
  '...kkkkk',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
], 30, 30, 'spr_ship');

const UFO = pad([
  '',
  '',
  '',
  '',
  '..........kkkkkkkkkk',
  '........kkssssssssssskk',
  '.......kssssssssssssssssk',
  '......kssssssssssssssssssk',
  '......kssswwssssssssssssk',
  '......ksssswwsssssssssssk',
  '......kssssssssssssssssssk',
  '.kkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
  'kppppppppppppppppppppppppppppk',
  'kppkkppppkkppppkkppppkkppppppk',
  'kppkkppppkkppppkkppppkkppppppk',
  'kppppppppppppppppppppppppppppk',
  '.kkpppppppppppppppppppppppppkk',
  '..kkkkkkkkkkkkkkkkkkkkkkkkkkk',
  '.......kkppppppppppkk',
  '........kkkkkkkkkkkk',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
], 30, 30, 'spr_ufo');

const WAVE = pad([
  '',
  '',
  '',
  '',
  '',
  '',
  '.....kk',
  '.....kppk',
  '.....kppppk',
  '.....kppppppk',
  '.....kpssppppk',
  '.....kpssssppppk',
  '.....kpsssssspppk',
  '.....kpssssssssppk',
  '.....kpssssssssspppk',
  '.....kpssssssssspppk',
  '.....kpssssssssppk',
  '.....kpsssssspppk',
  '.....kpssssppppk',
  '.....kpssppppk',
  '.....kppppppk',
  '.....kppppk',
  '.....kppk',
  '.....kk',
  '',
  '',
  '',
  '',
  '',
  '',
], 30, 30, 'spr_wave');

const ROBOT = pad([
  '',
  '',
  '.......kkkkkkkkkkkkkkkk',
  '.......kppppppppppppppk',
  '.......kppkkkkkkkkkkppk',
  '.......kppkwwwwwwwwkppk',
  '.......kppkkkkkkkkkkppk',
  '.......kppppppppppppppk',
  '.......kkkkkkkkkkkkkkkk',
  '..........kkpppppppk',
  '....kkkkkkkkkkkkkkkkkkkkkkk',
  '....kppppppppppppppppppppk',
  '....kppssssssssssssssssppk',
  '....kppsspppppppppppssppk',
  '....kppsspppppppppppssppk',
  '....kppsspppppppppppssppk',
  '....kppssssssssssssssssppk',
  '....kppppppppppppppppppppk',
  '....kkkkkkkkkkkkkkkkkkkkkkk',
  '......kkppppkk....kkppppkk',
  '......kppppppk....kppppppk',
  '......kppppppk....kppppppk',
  '......kkkkkkkk....kkkkkkkk',
  '......kppppppk....kppppppk',
  '......kppppppk....kppppppk',
  '.....kkppppppkk..kkppppppkk',
  '.....kssssssssk..kssssssssk',
  '.....kssssssssk..kssssssssk',
  '.....kkkkkkkkkk..kkkkkkkkkk',
  '',
], 30, 30, 'spr_robot');

const SPIDER = pad([
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '.........kkkkkkkkkkkk',
  '........kssssssssssssk',
  '.......kssppppppppppssk',
  '.......ksppkkppppkkppsk',
  '.......ksppkkppppkkppsk',
  '.......kspppppppppppppsk',
  '.......ksspppppppppppssk',
  '.......ksssssssssssssssk',
  '.......ksssssssssssssssk',
  '........kkkkkkkkkkkkkkk',
  '.....kkkkppk......kppkkkk',
  '....kppkkppk......kppkkppk',
  '...kppk..kppk....kppk..kppk',
  '..kppk....kppk..kppk....kppk',
  '.kppk......kppkkppk......kppk',
  'kppk........kppppk........kppk',
  'kpk..........kkkk..........kpk',
  'kkk........................kkk',
  '',
  '',
  '',
], 30, 30, 'spr_spider');

const SWING = pad([
  '',
  '',
  '.kkkkkkkkkkkkkkkkkkkkkkkkkkkk',
  '.kssssssssssssssssssssssssssk',
  '.kkkkkkkkkkkkkkkkkkkkkkkkkkkk',
  '.............kkkk',
  '.............kppk',
  '........kkkkkkkkkkkkkk',
  '........kppppppppppppk',
  '........kppppppppppppk',
  '......kkkppkkkkkkkkppkkk',
  '......kppppkwwwwwwkppppk',
  '......kppppkwwwwwwkppppk',
  '......kppppkkkkkkkkppppk',
  '......kppppppppppppppppk',
  '......kppssssssssssssppk',
  '......kppppppppppppppppk',
  '......kkkkkkkkkkkkkkkkkk',
  '.........kkkkkkkkkkk',
  '.........kppppppppppk',
  '.........kkkkkkkkkkk',
  '.............kppk',
  '.............kkkk',
  '',
  '.kkkkkkkkkkkkkkkkkkkkkkkkkkkk',
  '.kssssssssssssssssssssssssssk',
  '.kkkkkkkkkkkkkkkkkkkkkkkkkkkk',
  '',
  '',
  '',
], 30, 30, 'spr_swing');

/** The ball: a two-tone disc so it visibly rolls. */
function ballRows(): string[] {
  const g = new Grid(30, 30);
  g.disc(15, 15, 14, 'p');
  for (let y = 0; y < 15; y++) for (let x = 0; x < 30; x++) if (g.get(x, y) === 'p') g.set(x, y, 's');
  g.ring(15, 15, 12, 14, 'k');
  g.disc(15, 15, 3, 'k');
  g.fillRect(14, 2, 15, 27, 'k');
  return g.rows();
}

// ---- play sprites ----------------------------------------------------------

function spikeRows(): string[] {
  const g = new Grid(30, 30);
  for (let y = 0; y < 30; y++) {
    const half = ((y + 1) / 30) * 14.5;
    g.fillRect(Math.round(15 - half), y, Math.round(14 + half), y, 'w');
  }
  g.outline('k');
  return g.rows();
}

const PAD_COLOURS = [P8.yellow, P8.pink, P8.red, P8.blue, P8.indigo];

function padRows(): string[] {
  const g = new Grid(30, 30);
  g.fillRect(2, 22, 27, 27, 'c');
  g.fillRect(4, 22, 25, 23, 'w');
  g.fillRect(0, 27, 29, 29, 'k');
  g.outline('k');
  return g.rows();
}

const ORB_COLOURS = [P8.yellow, P8.pink, P8.red, P8.blue, P8.green, P8.darkGray, P8.indigo, P8.green, P8.pink];

function orbRows(kind: number): string[] {
  const g = new Grid(30, 30);
  g.disc(15, 15, 12, 'c');
  g.ring(15, 15, 9, 11, 'w');
  if (kind === 5) g.disc(15, 15, 6, 'k');
  if (kind === 6) {
    g.fillRect(4, 14, 25, 15, 'k');
    g.fillRect(14, 4, 15, 25, 'k');
  }
  if (kind >= 7) {
    // A chevron: the orb carries you in that direction while held.
    for (let i = 0; i < 6; i++) g.fillRect(9 + i, 9 + i, 12 + i, 9 + i, 'w');
    for (let i = 0; i < 6; i++) g.fillRect(9 + i, 20 - i, 12 + i, 20 - i, 'w');
  }
  g.outline('k');
  return g.rows();
}

function portalRows(width: number, height: number): string[] {
  const g = new Grid(width, height);
  g.fillRect(2, 2, width - 3, height - 3, 'c');
  g.fillRect(6, 8, width - 7, height - 9, '.');
  g.frame(6, 8, width - 7, height - 9, 'w');
  g.outline('k');
  return g.rows();
}

function speedPortalRows(chevrons: number): string[] {
  const g = new Grid(60, 30);
  g.fillRect(2, 24, 57, 27, 'c');
  const step = Math.floor(48 / Math.max(1, chevrons));
  for (let n = 0; n < chevrons; n++) {
    const x0 = 8 + n * step;
    for (let i = 0; i < 9; i++) {
      g.fillRect(x0 + i, 4 + i, x0 + i + 3, 4 + i, 'c');
      g.fillRect(x0 + i, 20 - i, x0 + i + 3, 20 - i, 'c');
    }
  }
  g.outline('k');
  return g.rows();
}

function finishRows(): string[] {
  const g = new Grid(30, 90);
  for (let y = 0; y < 90; y++) {
    for (let x = 0; x < 30; x++) {
      g.set(x, y, (Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0 ? 'g' : 'w');
    }
  }
  g.frame(0, 0, 29, 89, 'k');
  return g.rows();
}

function checkpointRows(): string[] {
  const g = new Grid(30, 30);
  for (let y = 0; y < 30; y++) {
    const half = 13 - Math.abs(y - 14.5);
    if (half > 0) g.fillRect(Math.round(15 - half), y, Math.round(14 + half), y, 'g');
  }
  for (let y = 8; y < 22; y++) {
    const half = 6 - Math.abs(y - 14.5);
    if (half > 0) g.fillRect(Math.round(15 - half), y, Math.round(14 + half), y, 'w');
  }
  g.outline('k');
  return g.rows();
}

function explosionRows(frame: number): string[] {
  const g = new Grid(30, 30);
  const r = 4 + frame * 3.5;
  g.ring(15, 15, r - 2, r, 'w');
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + frame * 0.4;
    const d = r + 2 + frame;
    g.set(Math.round(15 + Math.cos(a) * d), Math.round(15 + Math.sin(a) * d), 'w');
  }
  return g.rows();
}

const STAR_FULL = ['...ww...', '...ww...', 'wwwwwwww', '.wwwwww.', '..wwww..', '..wwww..', '.ww..ww.', 'w......w'];
const STAR_HOLLOW = ['...ww...', '...ww...', 'wwwwwwww', '.w....w.', '..w..w..', '..w..w..', '.w....w.', 'w......w'];

const COIN_FULL = [
  '.......wwwwwwww.......',
  '.....wwwwwwwwwwww.....',
  '....wwww......wwww....',
  '...www..........www...',
  '..www............www..',
  '.www..............www.',
  '.www..............www.',
  'www......wwww......www',
  'www.....wwwwww.....www',
  'www....www..www....www',
  'www....www..www....www',
  'www....www..www....www',
  'www....www..www....www',
  'www.....wwwwww.....www',
  'www......wwww......www',
  '.www..............www.',
  '.www..............www.',
  '..www............www..',
  '...www..........www...',
  '....wwww......wwww....',
  '.....wwwwwwwwwwww.....',
  '.......wwwwwwww.......',
];
const COIN_THIN = [
  '.........wwww.........',
  '........wwwwww........',
  '........ww..ww........',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '.......ww....ww.......',
  '........ww..ww........',
  '........wwwwww........',
  '.........wwww.........',
];

// ---- the title -------------------------------------------------------------

const LETTERS: Record<string, string[]> = {
  G: ['.###.', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
};

/** Block letters at 2x with a one-pixel outline: top half `a`, bottom `b`. */
function titleRows(text: string, width: number, height: number): string[] {
  const g = new Grid(width, height);
  const pitch = 12;
  const total = text.length * pitch - 2;
  let x = Math.floor((width - total) / 2);
  const top = Math.floor((height - 14) / 2);
  for (const ch of text) {
    const glyph = LETTERS[ch];
    if (glyph) {
      glyph.forEach((row, gy) => {
        for (let gx = 0; gx < row.length; gx++) {
          if (row[gx] !== '#') continue;
          const colour = gy < 4 ? 'a' : 'b';
          g.fillRect(x + gx * 2, top + gy * 2, x + gx * 2 + 1, top + gy * 2 + 1, colour);
        }
      });
    }
    x += pitch;
  }
  g.outline('k');
  return g.rows();
}

// ---- the tileset ----------------------------------------------------------------

/** Three 30x30 tiles in a row: 0 outlined block, 1 ground fill, 2 decor. */
function tilesetRows(): string[] {
  const g = new Grid(90, 30);
  // Block: dark body, bright 2 px border, an inner frame.
  g.fillRect(0, 0, 29, 29, 'b');
  g.frame(0, 0, 29, 29, 'k', 1);
  g.frame(1, 1, 28, 28, 'e', 2);
  g.frame(6, 6, 23, 23, 'e', 1);
  // Ground: solid dark fill with a faint grid of dots.
  g.fillRect(30, 0, 59, 29, 'd');
  for (let y = 4; y < 30; y += 8) for (let x = 34; x < 60; x += 8) g.set(x, y, 'e');
  g.fillRect(30, 0, 59, 0, 'e');
  // Decor: transparent with a small light diamond.
  g.fillRect(60, 0, 89, 29, '.');
  for (let y = 0; y < 30; y++) {
    const half = 5 - Math.abs(y - 14.5);
    if (half > 0) g.fillRect(Math.round(75 - half), y, Math.round(74 + half), y, 'l');
  }
  return g.rows();
}

// ---- assembly ----------------------------------------------------------------

const PLAYER_RECT = FULL_30;
const PORTAL_RECT = rect(2, 2, 27, 87);

function buildSprites(): SpriteFile[] {
  const icons = [ICON_0, ICON_1, ICON_2, ICON_3].map((rows, i) =>
    sprite(`spr_icon_${i}`, 30, 30, maskFrames(pad(rows, 30, 30, `spr_icon_${i}`)), PLAYER_RECT),
  );
  const cube = sprite('spr_cube', 30, 30, maskFrames(pad(ICON_0, 30, 30, 'spr_cube')), PLAYER_RECT);
  const vehicles = [
    sprite('spr_ship', 30, 30, maskFrames(SHIP), PLAYER_RECT),
    sprite('spr_ball', 30, 30, maskFrames(ballRows()), PLAYER_RECT),
    sprite('spr_ufo', 30, 30, maskFrames(UFO), PLAYER_RECT),
    sprite('spr_wave', 30, 30, maskFrames(WAVE), PLAYER_RECT),
    sprite('spr_robot', 30, 30, maskFrames(ROBOT), PLAYER_RECT),
    sprite('spr_spider', 30, 30, maskFrames(SPIDER), PLAYER_RECT),
    sprite('spr_swing', 30, 30, maskFrames(SWING), PLAYER_RECT),
  ];

  const title = sprite(
    'spr_title', 160, 24,
    [frameFromAscii(titleRows('GEOMETRY DASH', 160, 24), { a: P8.blue, b: P8.cream, k: BLACK })],
    rect(0, 0, 159, 23),
  );
  const star = sprite('spr_star', 8, 8, [STAR_FULL, STAR_HOLLOW].map((rows) => frameFromAscii(rows, { w: WHITE })), rect(0, 0, 7, 7));
  const coin = sprite('spr_coin', 22, 22, [COIN_FULL, COIN_THIN].map((rows) => frameFromAscii(rows, { w: WHITE })), rect(4, 4, 25, 25));
  const checkpoint = sprite('spr_checkpoint', 30, 30, [frameFromAscii(checkpointRows(), { g: P8.green, w: WHITE, k: BLACK })], FULL_30);
  const explosion = sprite(
    'spr_explosion', 30, 30,
    [0, 1, 2, 3].map((i) => frameFromAscii(explosionRows(i), { w: WHITE })),
    FULL_30,
  );

  // A forgiving hazard box, as in GD: a narrow column up the middle so grazing
  // a spike's shoulder is survivable. Death is only the tip-to-base centre.
  const spike = sprite('spr_spike', 30, 30, [frameFromAscii(spikeRows(), { w: WHITE, k: BLACK })], rect(12, 20, 17, 29));
  const padSprite = sprite(
    'spr_pad', 30, 30,
    PAD_COLOURS.map((colour) => frameFromAscii(padRows(), { c: colour, w: WHITE, k: BLACK })),
    rect(0, 20, 29, 29),
  );
  const orb = sprite(
    'spr_orb', 30, 30,
    ORB_COLOURS.map((colour, kind) => frameFromAscii(orbRows(kind), { c: colour, w: WHITE, k: BLACK })),
    FULL_30,
  );
  const portalRing = portalRows(30, 90);
  const gravity = sprite(
    'spr_portal_gravity', 30, 90,
    [P8.yellow, P8.blue].map((colour) => frameFromAscii(portalRing, { c: colour, w: WHITE, k: BLACK })),
    PORTAL_RECT,
  );
  const modeColours = [P8.green, P8.pink, P8.red, P8.orange, P8.blue, P8.lightGray, P8.indigo, P8.peach];
  const mode = sprite(
    'spr_portal_mode', 30, 90,
    modeColours.map((colour) => frameFromAscii(portalRing, { c: colour, w: WHITE, k: BLACK })),
    PORTAL_RECT,
  );
  const speedColours = [P8.orange, P8.blue, P8.green, P8.pink, P8.red];
  const speed = sprite(
    'spr_portal_speed', 60, 30,
    speedColours.map((colour, i) => frameFromAscii(speedPortalRows(i + 1), { c: colour, k: BLACK })),
    rect(2, 2, 57, 27),
  );
  const size = sprite(
    'spr_portal_size', 30, 90,
    [P8.pink, P8.green].map((colour) => frameFromAscii(portalRing, { c: colour, w: WHITE, k: BLACK })),
    PORTAL_RECT,
  );
  const finish = sprite('spr_finish', 30, 90, [frameFromAscii(finishRows(), { g: P8.green, w: P8.cream, k: BLACK })], rect(0, 0, 29, 89));

  return [title, ...icons, cube, ...vehicles, star, coin, checkpoint, explosion, spike, padSprite, orb, gravity, mode, speed, size, finish];
}

function buildTileset(): TilesetFile {
  return {
    kind: 'tileset',
    version: FORMAT_VERSION,
    name: 'ts_gd',
    tileWidth: GD_CELL,
    tileHeight: GD_CELL,
    offsetX: 0,
    offsetY: 0,
    spacingX: 0,
    spacingY: 0,
    columns: 3,
    rows: 1,
    image: frameFromAscii(tilesetRows(), { b: P8.darkBlue, e: P8.blue, k: BLACK, d: '#101c40', l: P8.indigo }),
    solid: [true, true, false],
  };
}

/** Built lazily: `frameFromAscii` needs a canvas, so this runs in the browser only. */
export const GD_SPRITES: SpriteFile[] = typeof document === 'undefined' ? [] : buildSprites();
export const GD_TILESET: TilesetFile = typeof document === 'undefined'
  ? { kind: 'tileset', version: FORMAT_VERSION, name: 'ts_gd', tileWidth: GD_CELL, tileHeight: GD_CELL, columns: 3, rows: 1, image: '', solid: [true, true, false] }
  : buildTileset();

export { buildSprites as buildGdSprites, buildTileset as buildGdTileset };
