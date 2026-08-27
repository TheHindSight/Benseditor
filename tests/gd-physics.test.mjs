/**
 * Geometry Dash physics core (`src/demo/gd/scripts/gdphys.py` + objects)
 * on the headless Python engine.
 *
 * Every scenario builds a small room (a tile floor plus whatever blocks it
 * needs), starts it, drives `__frame_packed` with frame-indexed inputs and
 * reads the player back through `gd_probe()` -- the state string
 * `x;y;vy;g;mode;on_ground;dead;won;speed;mini`. The expected numbers are
 * the ones the addendum's constants predict.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const python = (name) => readFileSync(join(root, 'src', 'python', name), 'utf8');
const script = (name) => readFileSync(join(root, 'src', 'demo', 'gd', 'scripts', name + '.py'), 'utf8');
const ROBLOX = python('roblox.py');
const PRELUDE = python('prelude.py');

const { loadMicroPython } = await import(pathToFileURL(join(root, 'src', 'vendor', 'micropython.js')).href);

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function section(name, body) {
  console.log(`\n=== ${name} ===`);
  try {
    await body();
  } catch (error) {
    failed++;
    const detail = String(error.stack ?? error.message ?? error).split('\n').slice(0, 14).join(' | ');
    console.log(`  FAIL ${name} threw -- ${detail}`);
  }
}

const near = (a, b, eps) => Math.abs(a - b) <= eps;
const POS = 1.5;
const VEL = 0.01;

// ---- the engine --------------------------------------------------------------

const hostStore = new Map();
let shared;

async function engine() {
  if (!shared) {
    const printed = [];
    const mp = await loadMicroPython({
      stdout: (line) => printed.push(line),
      stderr: (line) => console.error(line),
    });
    mp.registerJsModule('__host', {
      store_get: (key) => hostStore.get(key) ?? '',
      store_set: (key, value) => {
        if (value === '') hostStore.delete(key);
        else hostStore.set(key, value);
      },
    });
    mp.runPython(ROBLOX);
    mp.runPython(PRELUDE);
    const g = (name) => mp.globals.get(name);
    shared = {
      mp,
      printed,
      frame: (input) => g('__frame_packed')(input, 1 / 60),
      start: (room) => g('__start')(room, 60),
      reset: g('__reset'),
      register_sprite: g('__register_sprite'),
      register_tileset: g('__register_tileset'),
      register_object: g('__register_object'),
      register_room: g('__register_room'),
      register_room_layer: g('__register_room_layer'),
      register_module: g('__register_module'),
      instance_number: g('instance_number'),
      run: (source) => mp.runPython(source),
      /** Evaluate a Python expression and return it as a string. */
      eval: (expression) => {
        mp.runPython(`gd_test_out = str(${expression})`);
        return mp.globals.get('gd_test_out');
      },
    };
  }
  shared.reset();
  shared.printed.length = 0;
  return shared;
}

const CELL = 30;
const OBJECTS = [
  // name, sprite, depth, parent
  ['obj_start', 'spr_start', 0, null],
  ['obj_hazard', null, 0, null],
  ['obj_spike', 'spr_spike', 0, 'obj_hazard'],
  ['obj_pad', 'spr_pad', 0, null],
  ['obj_orb', 'spr_orb', 0, null],
  ['obj_portal', null, 0, null],
  ['obj_portal_gravity', 'spr_portal', 0, 'obj_portal'],
  ['obj_portal_mode', 'spr_portal', 0, 'obj_portal'],
  ['obj_portal_speed', 'spr_portal', 0, 'obj_portal'],
  ['obj_portal_size', 'spr_portal', 0, 'obj_portal'],
  ['obj_coin', 'spr_coin', 0, null],
  ['obj_finish', 'spr_finish', 0, null],
  ['obj_checkpoint', 'spr_checkpoint', 0, null],
  ['obj_explosion', null, -20, null],
  ['obj_player', 'spr_cube', -10, null],
];

/** Fresh engine with every gd asset registered: sprites (addendum hitboxes), tileset, module, objects. */
async function setup() {
  const e = await engine();
  let atlas = 1;
  const sprite = (name, w, h, frames, l, t, r, b) => {
    e.register_sprite(name, atlas, frames, w, h, w / 2, h / 2, 0, l, t, r, b);
    atlas += frames;
  };
  for (const mode of ['cube', 'ship', 'ball', 'ufo', 'robot', 'spider', 'swing']) sprite('spr_' + mode, 30, 30, 1, 0, 0, 29, 29);
  sprite('spr_wave', 30, 30, 1, 10, 10, 19, 19);
  sprite('spr_start', 30, 30, 1, 0, 0, 29, 29);
  sprite('spr_spike', 30, 30, 2, 5, 10, 24, 29);
  sprite('spr_pad', 30, 30, 5, 0, 20, 29, 29);
  sprite('spr_orb', 30, 30, 9, 0, 0, 29, 29);
  sprite('spr_portal', 30, 90, 8, 0, 0, 29, 89);
  sprite('spr_coin', 30, 30, 1, 4, 4, 25, 25);
  sprite('spr_finish', 30, 30, 1, 0, 0, 29, 29);
  sprite('spr_checkpoint', 30, 30, 1, 0, 0, 29, 29);
  e.register_tileset('ts_gd', 500, CELL, CELL, 2, 1, '11');
  e.register_module('gdphys', script('gdphys'));
  for (const [name, spr, depth, parent] of OBJECTS) {
    e.register_object(name, script(name), spr, depth, true, false, false, parent, '');
  }
  // The probes as callables, fetched once: a runPython per frame would recompile.
  e.run("gd_probe_main = __API['gd_probe']; gd_field_main = __API['gd_probe_field']");
  e.probeFn = e.mp.globals.get('gd_probe_main');
  e.fieldFn = e.mp.globals.get('gd_field_main');
  return e;
}

/** Run-length pack a flat tile list the way the host does. */
function rle(tiles) {
  const runs = [];
  let value = tiles[0];
  let count = 0;
  for (const tile of tiles) {
    if (tile === value) count++;
    else {
      runs.push(`${value}:${count}`);
      value = tile;
      count = 1;
    }
  }
  runs.push(`${value}:${count}`);
  return runs.join(',');
}

/**
 * A room: `columns` x `rows` cells, floor top at row `floorRow` (solid to the
 * bottom), extra solid `blocks` as [col, rowUp] with rows counted up from the
 * floor (0 = standing on the floor), and placements `{obj, col, row, name?,
 * xscale?, yscale?, angle?}` at cell centres. Returns the geometry.
 */
function roomWith(e, { columns = 80, rows = 14, floorRow = 12, blocks = [], placements = [] } = {}) {
  const tiles = new Array(columns * rows).fill(-1);
  for (let c = 0; c < columns; c++) {
    for (let r = floorRow; r < rows; r++) tiles[r * columns + c] = r === floorRow ? 0 : 1;
  }
  const floorY = floorRow * CELL;
  const cellX = (col) => col * CELL + CELL / 2;
  const cellY = (row) => floorY - row * CELL - CELL / 2;
  for (const [col, rowUp] of blocks) {
    const r = floorRow - 1 - rowUp;
    if (col >= 0 && col < columns && r >= 0 && r < rows) tiles[r * columns + col] = 0;
  }
  const packed = placements.map((p) => {
    const x = p.x ?? cellX(p.col);
    const y = p.y ?? cellY(p.row ?? 0);
    return `${p.obj},${x},${y},${p.xscale ?? 1},${p.yscale ?? 1},${p.angle ?? 0},${p.name ?? ''}`;
  }).join(';');
  e.register_room('rm_test', columns * CELL, rows * CELL, 0x101030, CELL, CELL, packed);
  // Buffer 0: the host keeps a layer this size on the GPU, so drawing it costs one record.
  e.register_room_layer('rm_test', 'lay_test', 'ts_gd', 10, true, columns, rows, rle(tiles), 0);
  return { floorY, ceilY: floorY - 11 * CELL, cellX, cellY, columns };
}

/** Start the room and set the physics bounds the controller normally sets. */
function begin(e, geo) {
  e.start('rm_test');
  e.run(`__API['gd_set_bounds'](${geo.floorY}, ${geo.ceilY}, ${geo.columns * CELL})`);
}

/** Standard start: player at column `col` on the floor, with an obj_start named `startName`. */
function playerAt(col, startName = 'start') {
  return [
    { obj: 'obj_start', col, row: 0, name: startName },
    { obj: 'obj_player', col, row: 0, name: 'player' },
  ];
}

const MOUSE = '|0,0,0,0,0,0';
const INPUT = {
  idle: '||' + '|0,0,0,0,0,0',
  held: 'space||' + MOUSE,
  press: 'space|space|' + MOUSE,
  release: '||space' + MOUSE,
};

/** Input for frame `i` given hold intervals [[from, to], ...] (inclusive, frame indices from 0). */
function inputAt(i, intervals) {
  for (const [from, to] of intervals) {
    if (i === from) return INPUT.press;
    if (i > from && i <= to) return INPUT.held;
    if (i === to + 1) return INPUT.release;
  }
  return INPUT.idle;
}

function parseState(text) {
  const f = text.split(';');
  return {
    raw: text,
    x: Number(f[0]), y: Number(f[1]), vy: Number(f[2]), g: Number(f[3]), mode: f[4],
    on_ground: f[5] === '1', dead: f[6] === '1', won: f[7] === '1', speed: Number(f[8]), mini: f[9] === '1',
  };
}

function probe(e) {
  return parseState(e.probeFn());
}

function field(e, name) {
  return e.fieldFn(name);
}

/** Drive `frames` steps; returns the state after each one (index n-1 = after frame n). */
function trace(e, frames, intervals = [], stopWhen = null) {
  const states = [];
  for (let i = 0; i < frames; i++) {
    e.frame(inputAt(i, intervals));
    const s = probe(e);
    states.push(s);
    if (stopWhen && stopWhen(s)) break;
  }
  return states;
}

/** Set a field on a live instance found by name. */
function setField(e, name, fieldName, pyLiteral) {
  e.run(`workspace.FindFirstChild(${JSON.stringify(name)}).${fieldName} = ${pyLiteral}`);
}

/** instance_create + fields, for objects that do not need to survive a restart. */
function spawn(e, obj, x, y, fields = {}) {
  const sets = Object.entries(fields).map(([k, v]) => `__gd_i.${k} = ${v}`).join('; ');
  e.run(`__gd_i = instance_create(${x}, ${y}, ${JSON.stringify(obj)})${sets ? '; ' + sets : ''}`);
}

const maxRise = (states, baseY) => Math.max(...states.map((s) => baseY - s.y));

const V0 = [9.558, 10.062, 10.278, 10.107, 10.107];
const G = [0.76156, 0.77614, 0.77533, 0.77857, 0.77857];
const DX = [4.186, 5.193, 6.457, 7.8, 9.6];

// ---- 1. cube apex ------------------------------------------------------------

await section('1. cube jump: apex 65.2 px at step 13, back on the ground at 26', async () => {
  const e = await setup();
  const geo = roomWith(e, { placements: playerAt(2) });
  begin(e, geo);
  const y0 = geo.cellY(0);
  const s = trace(e, 40, [[0, 0]]);
  const h = (n) => y0 - s[n - 1].y;
  check('apex height 65.2 at step 13', near(h(13), 65.2, POS), `h(13)=${h(13).toFixed(2)}`);
  check('step 13 is the apex', h(13) >= h(12) && h(13) >= h(14), `h12=${h(12).toFixed(2)} h14=${h(14).toFixed(2)}`);
  check('airborne through step 25', !s[24].on_ground && h(25) > 0, `h25=${h(25).toFixed(2)}`);
  check('on the ground at step 26', s[25].on_ground && near(s[25].y, y0, 0.01), s[25].raw);
  check('vy is zero after landing', near(s[25].vy, 0, VEL), `vy=${s[25].vy}`);
  check('x advances 5.193 per step', near(s[9].x - s[8].x, DX[1], VEL), `${s[9].x - s[8].x}`);
  check('mode/speed/g reported', s[0].mode === 'cube' && s[0].speed === 1 && s[0].g === 1, s[0].raw);
  check('jumped exactly once', field(e, 'jumps') === '1', field(e, 'jumps'));
});

// ---- 2. apex per speed ---------------------------------------------------------

await section('2. cube apex per speed: 60.0 / 65.2 / 68.1 / 65.6 / 65.6', async () => {
  const expected = [60.0, 65.2, 68.1, 65.6, 65.6];
  for (let speed = 0; speed < 5; speed++) {
    const e = await setup();
    const geo = roomWith(e, { placements: playerAt(2, `start:cube:${speed}`) });
    begin(e, geo);
    const s = trace(e, 40, [[0, 0]]);
    const rise = maxRise(s, geo.cellY(0));
    check(`speed ${speed}: apex ${expected[speed]}`, near(rise, expected[speed], POS) && s[0].speed === speed,
      `rise=${rise.toFixed(2)} speed=${s[0].speed}`);
    check(`speed ${speed}: dx ${DX[speed]}`, near(s[3].x - s[2].x, DX[speed], VEL), `${s[3].x - s[2].x}`);
  }
});

// ---- 3. mini -------------------------------------------------------------------

await section('3. mini cube: apex 41.7 px, 18 px box', async () => {
  const e = await setup();
  const geo = roomWith(e, { placements: playerAt(2, 'start:cube:1:1') });
  begin(e, geo);
  // The marker is a cell centre: a mini cube spawns 6 px up, drops, then the held jump fires.
  const s = trace(e, 40, [[0, 4]]);
  const rise = maxRise(s, geo.floorY - 9);
  check('mini apex 41.7', near(rise, 41.7, POS), `rise=${rise.toFixed(2)}`);
  check('mini flag reported', s[0].mini, s[0].raw);
  check('outer box is 18 px', Number(field(e, 'size')) === 18 && Number(field(e, 'hb')) === 9, `${field(e, 'size')}/${field(e, 'hb')}`);
  const bbox = e.eval("instance_find('obj_player').bbox()");
  const [l, , r] = bbox.replace(/[()]/g, '').split(',').map(Number);
  check('engine bbox width follows image scale (18)', near(r - l, 18, 0.01), bbox);
  check('mini stands on the floor', near(s[39].y + 9, geo.floorY, 0.01) && s[39].on_ground, s[39].raw);
});

// ---- 4. auto jump ---------------------------------------------------------------

await section('4. holding jump: a new jump every 26 steps', async () => {
  const e = await setup();
  const geo = roomWith(e, { placements: playerAt(2) });
  begin(e, geo);
  const s = trace(e, 120, [[0, 119]]);
  const takeoffs = [];
  for (let n = 1; n <= s.length; n++) {
    if (near(s[n - 1].vy, -V0[1] + G[1], VEL)) takeoffs.push(n);
  }
  const gaps = takeoffs.slice(1).map((n, i) => n - takeoffs[i]);
  check('first takeoff at step 1', takeoffs[0] === 1, takeoffs.join(','));
  check('takeoffs 26 steps apart', gaps.length >= 3 && gaps.every((gap) => gap === 26), `takeoffs=${takeoffs.join(',')}`);
  check('jump counter matches', field(e, 'jumps') === String(takeoffs.length), field(e, 'jumps'));
});

// ---- 5. ship ----------------------------------------------------------------------

await section('5. ship: hold curve, 7.2 clamp, release curve, 5.76 clamp', async () => {
  const e = await setup();
  const geo = roomWith(e, { placements: playerAt(2, 'start:ship:1') });
  begin(e, geo);
  const s = trace(e, 80, [[0, 23]]);
  const vy = (n) => s[n - 1].vy;
  check('vy -3.10 after 10 held steps', near(vy(10), -3.1046, VEL), `vy=${vy(10)}`);
  check('vy clamped to -7.2 at step 24', near(vy(24), -7.2, VEL), `vy=${vy(24)}`);
  check('still -7.2 while held at 23', vy(23) < -7.1, `vy=${vy(23)}`);
  // 7.2 / 0.37255 = 19.33 steps: the sign flips between +19 and +20 (the addendum's "0 at +19").
  check('vy about 0 at +19 after release (-0.12: 19.33 steps to zero)', near(vy(24 + 19), -0.1215, 0.02), `vy=${vy(43)}`);
  check('vy positive at +20 after release', vy(24 + 20) > 0, `vy=${vy(44)}`);
  // 19.33 steps to zero, then (5.76 - 0.25) / 0.24836 = 22.2 more: 5.715 at +42, clamped at +43.
  check('vy 5.715 at +42 (one step short of the clamp)', near(vy(24 + 42), 5.7149, VEL), `vy=${vy(66)}`);
  check('vy clamped to +5.76 at +43', near(vy(24 + 43), 5.76, VEL), `vy=${vy(67)}`);
  check('never below the floor', s.every((st) => st.y + 15 <= geo.floorY + 0.001), '');
  check('ship tilts toward its velocity', Number(field(e, 'image_angle')) < 0, field(e, 'image_angle'));

  // Mini ship: accelerations / 0.85 and clamps 8.47 / 6.78.
  const m = await setup();
  const geo2 = roomWith(m, { placements: playerAt(2, 'start:ship:1:1') });
  begin(m, geo2);
  const t = trace(m, 90, [[0, 29]]);
  check('mini ship vy after 10 held steps -3.65', near(t[9].vy, -3.1046 / 0.85, VEL), `vy=${t[9].vy}`);
  check('mini ship clamps at -8.47', near(t[29].vy, -8.47, VEL), `vy=${t[29].vy}`);
  check('mini ship clamps at +6.78 falling', near(t[89].vy, 6.78, VEL), `vy=${t[89].vy}`);
});

// ---- 6. UFO -----------------------------------------------------------------------

await section('6. UFO: flap sets vy -6.3, apex 42.6 px', async () => {
  const e = await setup();
  const geo = roomWith(e, { placements: playerAt(2, 'start:ufo:1') });
  begin(e, geo);
  const y0 = geo.cellY(0);
  const s = trace(e, 40, [[0, 0]]);
  // The flap happens before the step's integration: vy after = -6.3 + G_rise.
  check('flap gave -6.3 (vy after step 1 = -6.3 + 0.46568)', near(s[0].vy, -6.3 + 0.46568, VEL), `vy=${s[0].vy}`);
  check('first step moved -6.3 + a/2', near(y0 - s[0].y, 6.3 - 0.46568 / 2, VEL), `dy=${y0 - s[0].y}`);
  const rise = maxRise(s, y0);
  check('UFO apex 42.6', near(rise, 42.6, POS), `rise=${rise.toFixed(2)}`);
  check('falls with 0.31046 (vy grows by it while falling)', near(s[29].vy - s[28].vy, 0.31046, VEL) || s[29].on_ground,
    `${s[28].vy} -> ${s[29].vy}`);
  // Holding does not re-flap; a second press while already rising faster keeps the higher speed.
  const h = await setup();
  const geo2 = roomWith(h, { placements: playerAt(2, 'start:ufo:1') });
  begin(h, geo2);
  const t = trace(h, 20, [[0, 19]]);
  check('holding flaps once', near(t[3].vy, -6.3 + 4 * 0.46568, VEL), `vy4=${t[3].vy}`);
  const m = await setup();
  const geo3 = roomWith(m, { placements: playerAt(2, 'start:ufo:1:1') });
  begin(m, geo3);
  const u = trace(m, 3, [[0, 0]]);
  check('mini flap 5.76', near(u[0].vy, -5.76 + 0.46568, VEL), `vy=${u[0].vy}`);
});

// ---- 7. wave ----------------------------------------------------------------------

await section('7. wave: 45 degrees, mini 63.43, tile = death', async () => {
  const e = await setup();
  const geo = roomWith(e, { placements: [{ obj: 'obj_start', col: 2, row: 5, name: 'start:wave:1' }, { obj: 'obj_player', col: 2, row: 5 }] });
  begin(e, geo);
  const y0 = geo.cellY(5);
  const s = trace(e, 40, [[0, 19]]);
  check('20 held steps rise 20*dx', near(y0 - s[19].y, 20 * DX[1], POS), `rise=${y0 - s[19].y}`);
  check('dy per step = -dx while held', near(s[9].y - s[8].y, -DX[1], VEL) && near(s[9].vy, -DX[1], VEL), `${s[9].y - s[8].y}`);
  check('20 released steps fall back 20*dx', near(s[39].y, y0, POS), `y=${s[39].y}`);
  check('dy per step = +dx released', near(s[29].y - s[28].y, DX[1], VEL), `${s[29].y - s[28].y}`);
  check('wave hitbox is 10 px', Number(field(e, 'hb')) === 5, field(e, 'hb'));
  check('wave tilts to about 45 degrees', Number(field(e, 'image_angle')) < -40, field(e, 'image_angle'));

  const m = await setup();
  const geo2 = roomWith(m, { placements: [{ obj: 'obj_start', col: 2, row: 5, name: 'start:wave:1:1' }, { obj: 'obj_player', col: 2, row: 5 }] });
  begin(m, geo2);
  const t = trace(m, 10, [[0, 9]]);
  check('mini wave rises 2*dx per step', near(geo2.cellY(5) - t[9].y, 20 * DX[1], POS), `rise=${geo2.cellY(5) - t[9].y}`);
  check('mini wave hitbox 6 px', near(Number(field(m, 'hb')), 3, 1e-9), field(m, 'hb'));

  // A wall of tiles ahead: any solid overlap kills the wave.
  const w = await setup();
  const blocks = [];
  for (let r = 0; r < 9; r++) blocks.push([8, r]);
  const geo3 = roomWith(w, { blocks, placements: [{ obj: 'obj_start', col: 2, row: 3, name: 'start:wave:1' }, { obj: 'obj_player', col: 2, row: 3 }] });
  begin(w, geo3);
  const u = trace(w, 60, [], (st) => st.dead);
  check('wave dies on a solid tile', u[u.length - 1].dead, u[u.length - 1].raw);
  check('died at the wall (x about 235)', near(u[u.length - 1].x, 240, 8), `x=${u[u.length - 1].x}`);

  // Sliding along the floor bound is not death.
  const f = await setup();
  const geo4 = roomWith(f, { placements: [{ obj: 'obj_start', col: 2, row: 0, name: 'start:wave:1' }, { obj: 'obj_player', col: 2, row: 0 }] });
  begin(f, geo4);
  const v = trace(f, 30, []);
  check('wave slides along the floor alive', !v[29].dead && v[29].on_ground && near(v[29].y + 5, geo4.floorY, 0.01), v[29].raw);
});

// ---- 8. ball ------------------------------------------------------------------------

await section('8. ball: flip on a surface with a 3.019 kick, no mid-air flip', async () => {
  const e = await setup();
  const blocks = [];
  for (let c = 0; c < 30; c++) blocks.push([c, 4]);
  const geo = roomWith(e, { blocks, placements: playerAt(2, 'start:ball:1') });
  begin(e, geo);
  const s = trace(e, 40, [[1, 1], [3, 3]]);
  check('idle first step keeps it on the floor', s[0].on_ground && s[0].g === 1, s[0].raw);
  check('press flips gravity', s[1].g === -1 && !s[1].on_ground, s[1].raw);
  check('kick 3.019 in the new direction (vy after step = -3.019 - 0.46568)', near(s[1].vy, -3.0186 - 0.46568, VEL), `vy=${s[1].vy}`);
  check('mid-air press does not flip', s[3].g === -1 && s[4].g === -1, `${s[3].raw} / ${s[4].raw}`);
  const landed = s.find((st) => st.on_ground && st.g === -1);
  check('lands on the underside of the ceiling row', landed && near(landed.y, geo.cellY(4) + 15 + 15, 0.01), landed?.raw);
  check('ball rolls (angle changes)', Number(field(e, 'image_angle')) !== 0, field(e, 'image_angle'));
  // Holding flips again on the next surface.
  const t = trace(e, 40, [[0, 39]]);
  check('holding on the ceiling flips back down', t.some((st) => st.g === 1), t[0].raw);
});

// ---- 9. robot -------------------------------------------------------------------------

await section('9. robot: tap 23.1 px, full hold 103.6 px with 17 constant steps', async () => {
  const e = await setup();
  const geo = roomWith(e, { placements: playerAt(2, 'start:robot:1') });
  begin(e, geo);
  const y0 = geo.cellY(0);
  const s = trace(e, 40, [[1, 1]]);
  check('tap rises 23.1', near(maxRise(s, y0), 23.1, POS), `rise=${maxRise(s, y0).toFixed(2)}`);
  check('tap first step is the constant 0.5*V0', near(s[0].y - s[1].y, 0.5 * V0[1], VEL), `${s[0].y - s[1].y}`);

  const h = await setup();
  const geo2 = roomWith(h, { placements: playerAt(2, 'start:robot:1') });
  begin(h, geo2);
  const t = trace(h, 80, [[1, 60]]);
  let constant = 0;
  for (let n = 1; n < t.length; n++) {
    if (!near(t[n - 1].y - t[n].y, 0.5 * V0[1], 1e-6)) break;
    constant++;
  }
  check('hold rises 103.6', near(maxRise(t, y0), 103.6, POS), `rise=${maxRise(t, y0).toFixed(2)}`);
  check('17 constant-rise steps', constant === 17, `constant=${constant}`);
  check('gravity 0.69853 after the boost', near(t[19].vy - t[18].vy, 0.69853, VEL), `${t[18].vy} -> ${t[19].vy}`);
  check('robot stays upright', field(h, 'image_angle') === '0', field(h, 'image_angle'));
});

// ---- 10. spider -------------------------------------------------------------------------

await section('10. spider: teleports to the ceiling 4 blocks up and back', async () => {
  const e = await setup();
  const blocks = [];
  for (let c = 0; c < 30; c++) blocks.push([c, 4]);
  const geo = roomWith(e, { blocks, placements: playerAt(2, 'start:spider:1') });
  begin(e, geo);
  const s = trace(e, 12, [[1, 1], [5, 5]]);
  const ceilingBottom = geo.cellY(4) + 15;
  check('on the floor first', s[0].on_ground && s[0].g === 1, s[0].raw);
  check('press teleports under the ceiling, gravity flipped', s[1].g === -1 && near(s[1].y, ceilingBottom + 15, 0.01) && s[1].on_ground, s[1].raw);
  check('x keeps moving during the teleport step', near(s[1].x - s[0].x, DX[1], VEL), `${s[1].x - s[0].x}`);
  check('stays on the ceiling', s[3].on_ground && s[3].g === -1 && near(s[3].y, ceilingBottom + 15, 0.01), s[3].raw);
  check('second press teleports back to the floor', s[5].g === 1 && near(s[5].y, geo.cellY(0), 0.01) && s[5].on_ground, s[5].raw);
  check('sprite flips with gravity', field(e, 'image_yscale') === '1.0' || field(e, 'image_yscale') === '1', field(e, 'image_yscale'));

  // No ceiling tiles: the level bound is the opposite surface.
  const b = await setup();
  const geo2 = roomWith(b, { placements: playerAt(2, 'start:spider:1') });
  begin(b, geo2);
  const t = trace(b, 4, [[1, 1]]);
  check('teleports to the ceiling bound without tiles', t[1].g === -1 && near(t[1].y, geo2.ceilY + 15, 0.01), t[1].raw);
});

// ---- 11. swing ---------------------------------------------------------------------------

await section('11. swing: flip keeps 80 % of vy', async () => {
  const e = await setup();
  const geo = roomWith(e, { placements: [{ obj: 'obj_start', col: 2, row: 5, name: 'start:swing:1' }, { obj: 'obj_player', col: 2, row: 5 }] });
  begin(e, geo);
  const s = trace(e, 30, [[6, 6]]);
  const before = s[5].vy;
  check('falls at 0.31046 per step', near(before, 6 * 0.31046, VEL), `vy=${before}`);
  check('press flips gravity', s[6].g === -1, s[6].raw);
  check('vy after flip = 0.8 * vy - 0.31046', near(s[6].vy, before * 0.8 - 0.31046, VEL), `vy=${s[6].vy}`);
  check('keeps flying up afterwards', s[20].y < s[6].y, `${s[6].y} -> ${s[20].y}`);
  const c = trace(e, 60, []);
  check('clamps at 7.2', c.every((st) => Math.abs(st.vy) <= 7.2 + 1e-9), '');
});

// ---- 12. gravity portal ---------------------------------------------------------------------

await section('12. gravity portal: halves and flips vy, cube lands on an underside', async () => {
  const e = await setup();
  const blocks = [];
  for (let c = 0; c < 30; c++) blocks.push([c, 5]);
  const geo = roomWith(e, {
    blocks,
    placements: [...playerAt(2), { obj: 'obj_portal_gravity', col: 4, row: 1, name: 'portal' }],
  });
  begin(e, geo);
  setField(e, 'portal', 'kind', '1');
  const s = trace(e, 60, [[0, 0]]);
  const flipAt = s.findIndex((st) => st.g === -1);
  check('gravity flipped inside the portal', flipAt >= 1 && flipAt <= 5, `flipAt=${flipAt}`);
  const prev = s[flipAt - 1].vy;
  const expected = -(prev + G[1]) / 2;
  check('vy halved and sign flipped', near(s[flipAt].vy, expected, VEL), `before=${prev} after=${s[flipAt].vy} expected=${expected}`);
  const landed = s.find((st) => st.on_ground && st.g === -1);
  const underside = geo.cellY(5) + 15;
  check('cube lands on the underside of the ceiling', landed && near(landed.y, underside + 15, 0.01), landed?.raw);
  check('sprite is flipped', field(e, 'image_yscale') === '-1' || field(e, 'image_yscale') === '-1.0', field(e, 'image_yscale'));
  check('cube angle snapped to 90 degrees on landing', Number(field(e, 'image_angle')) % 90 === 0, field(e, 'image_angle'));
  check('alive', !s[59].dead, s[59].raw);
  // Holding jumps "down" from the ceiling.
  const t = trace(e, 3, [[0, 2]]);
  check('jumping from the ceiling goes toward the floor', t[0].vy > 0 && t[0].vy > 9, t[0].raw);
});

// ---- 13. pads ---------------------------------------------------------------------------------

await section('13. pads: yellow 14.4, pink 9.36, red 18.0, blue flip, one-shot, ship clamp 69.6', async () => {
  const cases = [
    ['yellow', -14.4, 1], ['pink', -9.36, 1], ['red', -18.0, 1],
  ];
  for (const [kind, vy, g] of cases) {
    const e = await setup();
    const geo = roomWith(e, { placements: [...playerAt(2), { obj: 'obj_pad', col: 5, row: 0, name: 'pad' }] });
    begin(e, geo);
    setField(e, 'pad', 'kind', JSON.stringify(kind));
    const s = trace(e, 30, []);
    const hit = s.findIndex((st) => st.vy < -1);
    check(`${kind} pad launches at ${vy}`, hit >= 0 && near(s[hit].vy, vy, VEL) && s[hit].g === g, s[hit]?.raw);
    check(`${kind} pad is one-shot (next step integrates, no re-launch)`, near(s[hit + 1].vy, vy + G[1], VEL), s[hit + 1]?.raw);
    check(`${kind} pad: airborne afterwards`, !s[hit].on_ground && !s[hit + 1].on_ground, '');
  }
  {
    const e = await setup();
    const geo = roomWith(e, { placements: [...playerAt(2), { obj: 'obj_pad', col: 5, row: 0, name: 'pad' }] });
    begin(e, geo);
    setField(e, 'pad', 'kind', '"blue"');
    const s = trace(e, 60, []);
    const hit = s.findIndex((st) => st.g === -1);
    check('blue pad flips gravity with 7.1 toward the new floor', hit >= 0 && near(s[hit].vy, -7.1, VEL), s[hit]?.raw);
    check('blue pad: cube lands on the ceiling bound', s.some((st) => st.on_ground && st.g === -1 && near(st.y, geo.ceilY + 15, 0.01)), '');
  }
  {
    const e = await setup();
    const geo = roomWith(e, { placements: [...playerAt(2, 'start:cube:1:1'), { obj: 'obj_pad', col: 5, row: 0, name: 'pad' }] });
    begin(e, geo);
    setField(e, 'pad', 'kind', '"yellow"');
    const s = trace(e, 30, []);
    const hit = s.findIndex((st) => st.vy < -1);
    check('mini: yellow pad x0.8 = 11.52', hit >= 0 && near(s[hit].vy, -14.4 * 0.8, VEL), s[hit]?.raw);
  }
  {
    const e = await setup();
    const geo = roomWith(e, { placements: [...playerAt(2, 'start:ball:1'), { obj: 'obj_pad', col: 5, row: 0, name: 'pad' }] });
    begin(e, geo);
    setField(e, 'pad', 'kind', '"yellow"');
    const s = trace(e, 30, []);
    const hit = s.findIndex((st) => st.vy < -1);
    check('ball: yellow pad x0.6 = 8.64 (then ball gravity)', hit >= 0 && near(s[hit].vy, -14.4 * 0.6, VEL), s[hit]?.raw);
  }
  {
    const e = await setup();
    const geo = roomWith(e, { placements: [...playerAt(2, 'start:ship:1'), { obj: 'obj_pad', col: 5, row: 0, name: 'pad' }] });
    begin(e, geo);
    setField(e, 'pad', 'kind', '"yellow"');
    const s = trace(e, 60, []);
    const hit = s.findIndex((st) => st.vy < -1);
    check('ship: pad clamped to 7.2', hit >= 0 && near(s[hit].vy, -7.2, VEL), s[hit]?.raw);
    check('ship: rises 69.6 px after a yellow pad with no input', near(maxRise(s, geo.cellY(0)), 69.6, POS), `rise=${maxRise(s, geo.cellY(0)).toFixed(2)}`);
  }
  {
    const e = await setup();
    const geo = roomWith(e, { placements: [...playerAt(2, 'start:spider:1'), { obj: 'obj_pad', col: 5, row: 0, name: 'pad' }] });
    begin(e, geo);
    setField(e, 'pad', 'kind', '"spider"');
    const s = trace(e, 30, []);
    check('spider pad: flip + teleport to the ceiling bound', s.some((st) => st.g === -1 && near(st.y, geo.ceilY + 15, 0.01) && st.on_ground), '');
  }
  {
    const e = await setup();
    const geo = roomWith(e, { placements: [...playerAt(2, 'start:wave:1'), { obj: 'obj_pad', col: 5, row: 0, name: 'pad' }] });
    begin(e, geo);
    setField(e, 'pad', 'kind', '"yellow"');
    const s = trace(e, 30, []);
    check('wave ignores jump pads', s.every((st) => Math.abs(st.vy) <= DX[1] + 1e-9), '');
  }
});

// ---- 14. orbs -----------------------------------------------------------------------------------

/** Cube jumps at frame 0 through an orb 2 blocks up at column 6; `intervals` adds the orb input. */
async function orbRoom(kind, intervals, startName = 'start') {
  const e = await setup();
  const geo = roomWith(e, { placements: [...playerAt(2, startName), { obj: 'obj_orb', col: 6, row: 2, name: 'orb' }] });
  begin(e, geo);
  setField(e, 'orb', 'kind', JSON.stringify(kind));
  const s = trace(e, 40, intervals);
  return { e, geo, s };
}

await section('14. orbs: press on the orb, buffered press, ground-jump exclusion, one-shot, kinds', async () => {
  {
    const { s } = await orbRoom('yellow', [[0, 0], [17, 18]]);
    check('press while overlapping: vy = -V0', near(s[17].vy, -V0[1], VEL), s[17].raw);
    check('one-shot: next step integrates', near(s[18].vy, -V0[1] + G[1], VEL), s[18].raw);
    check('overlap geometry sane (cube within 30 px of the orb)', Math.abs(s[17].x - 195) < 30 && Math.abs(s[17].y - 285) < 30, s[17].raw);
  }
  {
    const { s } = await orbRoom('yellow', [[0, 0], [8, 30]]);
    const fired = s.findIndex((st, i) => i >= 9 && near(st.vy, -V0[1], VEL));
    check('buffered press in the air fires the orb on contact', fired >= 14 && fired <= 22, `fired=${fired}`);
  }
  {
    const e = await setup();
    const geo = roomWith(e, { placements: [...playerAt(2), { obj: 'obj_orb', col: 6, row: 2, name: 'orb' }] });
    begin(e, geo);
    const s = trace(e, 40, [[0, 39]]);
    const refire = s.findIndex((st, i) => i >= 1 && i <= 24 && near(st.vy, -V0[1], VEL));
    check('a hold that began with a ground jump does not fire the orb', refire === -1, `refire=${refire}`);
    check('orb still unused', e.eval("workspace.FindFirstChild('orb').used") === 'False', '');
    check('auto-jump resumes on landing', s.some((st, i) => i >= 25 && near(st.vy, -V0[1] + G[1], VEL)), '');
  }
  {
    const { s } = await orbRoom('pink', [[0, 0], [17, 17]]);
    check('pink orb 0.72 V0', near(s[17].vy, -0.72 * V0[1], VEL), s[17].raw);
  }
  {
    const { s } = await orbRoom('red', [[0, 0], [17, 17]]);
    check('red orb 1.38 V0', near(s[17].vy, -1.38 * V0[1], VEL), s[17].raw);
  }
  {
    const { s } = await orbRoom('blue', [[0, 0], [17, 17]]);
    check('blue orb flips and gives 7.1 toward the new floor', s[17].g === -1 && near(s[17].vy, -7.1, VEL), s[17].raw);
  }
  {
    const { s } = await orbRoom('green', [[0, 0], [17, 17]]);
    check('green orb flips then full jump in the new frame', s[17].g === -1 && near(s[17].vy, V0[1], VEL), s[17].raw);
  }
  {
    const { s } = await orbRoom('black', [[0, 0], [17, 17]]);
    check('black orb slams down at 13.5', near(s[17].vy, 13.5, VEL), s[17].raw);
    check('lands right after', s.slice(18, 24).some((st) => st.on_ground), '');
  }
  {
    // An 8-step boost puts the robot at about 55 px up when it reaches the orb.
    const { s } = await orbRoom('yellow', [[0, 7], [17, 17]], 'start:robot:1');
    check('robot: yellow orb 0.9 V0', near(s[17].vy, -0.9 * V0[1], VEL), s[17].raw);
  }
  {
    const { s } = await orbRoom('spider', [[0, 0], [17, 17]], 'start:cube:1');
    check('spider orb teleports any mode to the opposite surface', s[17].g === -1 && s[17].on_ground, s[17].raw);
  }
});

// ---- 15. dash orb --------------------------------------------------------------------------------

await section('15. dash orb: straight while held, gravity off, release stops', async () => {
  const e = await setup();
  const geo = roomWith(e, { placements: [...playerAt(2), { obj: 'obj_orb', col: 6, row: 2, name: 'orb' }] });
  begin(e, geo);
  setField(e, 'orb', 'kind', '"dash"');
  const s = trace(e, 18, [[0, 0], [17, 24]]);
  check('dash starts on contact', field(e, 'dashing') === 'True' && s[17].vy === 0, `${field(e, 'dashing')} ${s[17].raw}`);
  for (let i = 18; i < 40; i++) {
    e.frame(inputAt(i, [[0, 0], [17, 24]]));
    s.push(probe(e));
  }
  check('dash ends on release', field(e, 'dashing') === 'False', field(e, 'dashing'));
  check('y constant while dashing at angle 0', s.slice(18, 25).every((st) => near(st.y, s[17].y, 1e-6) && st.vy === 0), `${s[18].y} ${s[24].y}`);
  check('x keeps its speed', near(s[20].x - s[19].x, DX[1], VEL), '');
  check('release: gravity returns from vy 0', near(s[25].vy, G[1], VEL) && s[25].y > s[24].y, s[25].raw);

  const d = await setup();
  const geo2 = roomWith(d, { placements: [...playerAt(2), { obj: 'obj_orb', col: 6, row: 2, name: 'orb', angle: 45 }] });
  begin(d, geo2);
  setField(d, 'orb', 'kind', '"dash"');
  const t = trace(d, 30, [[0, 0], [17, 24]]);
  check('45 degree dash rises dx per step', near(t[19].y - t[20].y, DX[1], VEL) && near(t[20].vy, -DX[1], VEL), `${t[19].y - t[20].y}`);

  const g2 = await setup();
  const geo3 = roomWith(g2, { placements: [...playerAt(2), { obj: 'obj_orb', col: 6, row: 2, name: 'orb' }] });
  begin(g2, geo3);
  setField(g2, 'orb', 'kind', '"gdash"');
  const u = trace(g2, 25, [[0, 0], [17, 24]]);
  check('gravity dash also flips gravity', u[17].g === -1 && u[20].vy === 0, u[17].raw);

  const s2 = await setup();
  const geo4 = roomWith(s2, { placements: [...playerAt(2), { obj: 'obj_orb', col: 6, row: 2, name: 'orb', angle: 85 }] });
  begin(s2, geo4);
  setField(s2, 'orb', 'kind', '"dash"');
  trace(s2, 18, [[0, 0], [17, 17]]);
  check('dash slope clamped to |tan| <= 5.67', near(Number(field(s2, 'dash_tan')), 5.67, 1e-6), field(s2, 'dash_tan'));
});

// ---- 16. spike hitbox -----------------------------------------------------------------------------

await section('16. spike: 20 px hitbox -- graze at 21 px, death inside it', async () => {
  const grazeRoom = async (feetAbove) => {
    const e = await setup();
    const geo = roomWith(e, { placements: playerAt(2) });
    begin(e, geo);
    // Spike base `feetAbove` px below the cube's feet, horizontally under the cube after one step.
    spawn(e, 'obj_spike', 80, geo.floorY + feetAbove - 15);
    const s = trace(e, 2, []);
    return s[1];
  };
  const graze = await grazeRoom(21);
  check('feet 21 px above the base: graze, alive', !graze.dead, graze.raw);
  const touch = await grazeRoom(20);
  check('feet exactly 20 px above: touching the top edge, alive (half-open boxes)', !touch.dead, touch.raw);
  const inside = await grazeRoom(19.5);
  check('feet 19.5 px above: inside the 20 px box, dead', inside.dead, inside.raw);

  // Horizontal extent: 20 wide, centred.
  const e = await setup();
  const geo = roomWith(e, { placements: playerAt(2) });
  begin(e, geo);
  spawn(e, 'obj_spike', 75 + DX[1] + 15 + 10 + 0.5, geo.floorY - 15);
  const beside = trace(e, 1, [])[0];
  check('cube beside a spike (edges 0.5 px apart) is alive', !beside.dead, beside.raw);
  const next = trace(e, 1, [])[0];
  check('one more step into it is death', next.dead, next.raw);

  // A down spike (kind 1, image_yscale -1) hangs from its cell top.
  const d = await setup();
  const geo2 = roomWith(d, { placements: [...playerAt(2), { obj: 'obj_spike', col: 4, row: 1, name: 'down', yscale: -1 }] });
  begin(d, geo2);
  setField(d, 'down', 'kind', '1');
  const t = trace(d, 20, [], (st) => st.dead);
  check('down spike at row 1 hangs 20 px: the cube passes under it alive', !t[t.length - 1].dead && t[t.length - 1].x > 150, t[t.length - 1].raw);
  const d2 = await setup();
  const geo3 = roomWith(d2, { placements: [...playerAt(2), { obj: 'obj_spike', col: 4, row: 1, name: 'down', yscale: -1 }] });
  begin(d2, geo3);
  setField(d2, 'down', 'kind', '1');
  const u = trace(d2, 20, [[2, 2]], (st) => st.dead);
  check('jumping into the down spike is death', u[u.length - 1].dead, u[u.length - 1].raw);
});

// ---- 17. landing vs face vs sweep -----------------------------------------------------------------

await section('17. landing on a block, face death, sweep landing at 9 px over-penetration', async () => {
  const platform = [[8, 0], [9, 0]];
  {
    const e = await setup();
    const geo = roomWith(e, { blocks: platform, placements: playerAt(2) });
    begin(e, geo);
    const s = trace(e, 45, [[10, 10]]);
    const landed = s.findIndex((st) => st.on_ground && near(st.y, geo.cellY(1), 0.01));
    check('jump from column 2 at step 11 lands on top of the platform', landed >= 30 && landed <= 36 && !s[landed].dead, `landed=${landed} ${s[landed]?.raw}`);
    check('stays on it', s[40].on_ground && near(s[40].y, geo.cellY(1), 0.01) && !s[40].dead, s[40].raw);
  }
  {
    const e = await setup();
    const geo = roomWith(e, { blocks: platform, placements: playerAt(2) });
    begin(e, geo);
    const s = trace(e, 45, [], (st) => st.dead);
    const last = s[s.length - 1];
    check('running into the face is death', last.dead, last.raw);
    check('death once the inner box enters (x + 4.5 > 240)', last.x + 4.5 > 240 && last.x - 4.5 < 250, `x=${last.x}`);
    check('x was never pushed back', s.every((st, i) => i === 0 || st.x > s[i - 1].x), '');
  }
  const teleport = async (feet, vy) => {
    const e = await setup();
    const geo = roomWith(e, { blocks: platform, placements: playerAt(2) });
    begin(e, geo);
    trace(e, 1, []);
    e.run(`__p = instance_find('obj_player'); __p.x = 270; __p.y = ${feet - 15}; __p.vy = ${vy}; __p.on_ground = False`);
    return { geo, s: trace(e, 1, [])[0] };
  };
  {
    const { geo, s } = await teleport(329, 19.61);
    check('sweep: feet were above the top, 19 px penetration lands', s.on_ground && near(s.y, geo.cellY(1), 0.01) && !s.dead, s.raw);
  }
  {
    const { s } = await teleport(349, 0);
    check('19 px inside from the side (not above last step) is death', s.dead, s.raw);
  }
  {
    const { geo, s } = await teleport(339, 0);
    check('9 px inside from the side snaps up (within the 10 px snap)', s.on_ground && near(s.y, geo.cellY(1), 0.01) && !s.dead, s.raw);
  }
  {
    const { s } = await teleport(339.8, 0);
    check('10.2 px inside from the side: neither landing nor death (inner box still clear)', !s.on_ground && !s.dead, s.raw);
    const { s: deep } = await teleport(340.5, 0);
    check('10.9 px inside from the side: the inner box enters, death', deep.dead, deep.raw);
  }
  {
    // Flying snap is 6 px: a ship 8 px into a block from the side is not landed.
    const e = await setup();
    const geo = roomWith(e, { blocks: platform, placements: playerAt(2, 'start:ship:1') });
    begin(e, geo);
    trace(e, 1, []);
    e.run("__p = instance_find('obj_player'); __p.x = 270; __p.y = 323; __p.vy = 0; __p.on_ground = False");
    const s = trace(e, 1, [])[0];
    check('ship 8 px into a block from the side: no landing (snap 6)', !s.on_ground, s.raw);
    e.run("__p = instance_find('obj_player'); __p.x = 270; __p.y = 320; __p.vy = 0; __p.on_ground = False");
    const t = trace(e, 1, [])[0];
    check('ship 5 px into a block: lands', t.on_ground && near(t.y, geo.cellY(1), 0.01), t.raw);
  }
  {
    // Ship head into a ceiling block: stops instead of dying.
    const e = await setup();
    const blocks = [];
    for (let c = 0; c < 30; c++) blocks.push([c, 3]);
    const geo = roomWith(e, { blocks, placements: playerAt(2, 'start:ship:1') });
    begin(e, geo);
    const s = trace(e, 80, [[0, 79]]);
    const ceiling = geo.cellY(3) + 15;
    check('ship holds against the ceiling alive', !s[79].dead && near(s[79].y, ceiling + 15, 0.01) && s[79].vy === 0, s[79].raw);
  }
  {
    // Cube jumping into a low ceiling dies on the face.
    const e = await setup();
    const blocks = [];
    for (let c = 0; c < 30; c++) blocks.push([c, 1]);
    const geo = roomWith(e, { blocks, placements: playerAt(2) });
    begin(e, geo);
    const s = trace(e, 30, [[0, 0]], (st) => st.dead);
    check('cube jumping into a 1-block ceiling dies', s[s.length - 1].dead, s[s.length - 1].raw);
  }
});

// ---- 18. spike matrix -------------------------------------------------------------------------------

await section('18. spike runs: 0.5x 2 yes 3 no; 1x 3 yes 4 no; 2x 4 yes 5 no', async () => {
  const e = await setup();
  const survives = (speed, count) => {
    const placements = playerAt(2, `start:cube:${speed}`);
    for (let i = 0; i < count; i++) placements.push({ obj: 'obj_spike', col: 12 + i, row: 0 });
    const geo = roomWith(e, { placements });
    const firstLeft = geo.cellX(12) - 10;
    const lastRight = geo.cellX(12 + count - 1) + 10;
    const dx = DX[speed];
    for (let offset = 0; offset < dx; offset += 1) {
      // A jump covers at most ~210 px: presses earlier than that cannot reach the spikes.
      const firstPress = Math.max(0, Math.floor((firstLeft - 230 - geo.cellX(2) - offset) / dx));
      for (let press = firstPress; press < 150; press++) {
        begin(e, geo);
        e.run(`__p = instance_find('obj_player'); __p.x += ${offset}`);
        const x0 = geo.cellX(2) + offset;
        if (x0 + (press + 1) * dx + 15 > firstLeft) break;
        let ok = false;
        for (let i = 0; i < 220; i++) {
          e.frame(inputAt(i, [[press, press]]));
          const s = probe(e);
          if (s.dead) break;
          if (s.x - 15 > lastRight + 1) { ok = true; break; }
        }
        if (ok) return true;
      }
    }
    return false;
  };
  const matrix = [[0, 2, true], [0, 3, false], [1, 3, true], [1, 4, false], [2, 4, true], [2, 5, false]];
  for (const [speed, count, expected] of matrix) {
    const got = survives(speed, count);
    check(`${['0.5x', '1x', '2x'][speed]}: ${count} spikes ${expected ? 'possible' : 'impossible'}`, got === expected, `got ${got}`);
  }
});

// ---- 19. death, respawn, practice --------------------------------------------------------------------

await section('19. death -> explosion -> restart after 60 steps; practice restores the checkpoint', async () => {
  const e = await setup();
  const geo = roomWith(e, {
    placements: [...playerAt(2), { obj: 'obj_checkpoint', col: 4, row: 0 }, { obj: 'obj_spike', col: 7, row: 0 }],
  });
  begin(e, geo);
  const s = trace(e, 40, [], (st) => st.dead);
  const deathStep = s.length;
  check('cube dies on the spike', s[deathStep - 1].dead, s[deathStep - 1].raw);
  check('explosion created', e.instance_number('obj_explosion') === 1, `${e.instance_number('obj_explosion')}`);
  check('player hidden', field(e, 'visible') === 'False', field(e, 'visible'));
  check('death x recorded', Number(e.eval("ReplicatedStorage.Get('gd.last_death_x')")) > 100, '');
  const cp = e.eval("ReplicatedStorage.Get('gd.checkpoint')['x']");
  check('checkpoint stored a snapshot near column 4', Math.abs(Number(cp) - geo.cellX(4)) < 30, cp);
  const still = trace(e, 59, []);
  check('still dead 59 steps later', still[58].dead && e.instance_number('obj_player') === 1, still[58].raw);
  const after = trace(e, 1, [])[0];
  check('room restarted on step 60: fresh player at the start (not yet stepped)', !after.dead && near(after.x, geo.cellX(2), 0.01), after.raw);
  check('explosion gone after the restart', e.instance_number('obj_explosion') === 0, '');
  const frames = e.eval('instance_number("obj_explosion")');
  check('explosion counter probe sane', frames === '0', frames);

  // Practice: the same death now respawns at the stored snapshot.
  e.run("ReplicatedStorage.Set('gd.run', {'mode': 'play', 'practice': True})");
  const t = trace(e, 40, [], (st) => st.dead);
  trace(e, 60, []);
  const respawn = probe(e);
  trace(e, 1, []);
  const stepped = probe(e);
  check('practice respawn restores the checkpoint x', Math.abs(respawn.x - Number(cp)) < DX[1] + 0.01 && !respawn.dead, `${respawn.raw} cp=${cp}`);
  check('practice respawn keeps mode and gravity, stands on the floor after one step', stepped.mode === 'cube' && stepped.g === 1 && stepped.on_ground, stepped.raw);
  check('restored player is visible', field(e, 'visible') === 'True', '');

  // gd_snapshot / gd_restore round trip directly.
  e.run("__p = instance_find('obj_player'); __snap = __API['gd_snapshot'](__p); __p.x = 1; __p.vy = 5; __API['gd_restore'](__p, __snap)");
  const back = probe(e);
  check('gd_restore puts x and vy back', near(back.x, stepped.x, 0.01) && near(back.vy, stepped.vy, 1e-9), back.raw);
});

// ---- 20. coins and finish -------------------------------------------------------------------------------

await section('20. coins collect once; the finish stops the run', async () => {
  const e = await setup();
  const geo = roomWith(e, {
    placements: [
      ...playerAt(2),
      { obj: 'obj_coin', col: 4, row: 0, name: 'c0' },
      { obj: 'obj_coin', col: 6, row: 0, name: 'c2' },
      { obj: 'obj_finish', col: 12, row: 0 }, { obj: 'obj_finish', col: 12, row: 1 }, { obj: 'obj_finish', col: 12, row: 2 },
    ],
  });
  begin(e, geo);
  setField(e, 'c0', 'index', '0');
  setField(e, 'c2', 'index', '2');
  const s = trace(e, 120, [], (st) => st.won);
  check('both coins collected in order', field(e, 'coins') === '[0, 2]', field(e, 'coins'));
  check('coin instances destroyed', e.instance_number('obj_coin') === 0, `${e.instance_number('obj_coin')}`);
  check('finish sets won', s[s.length - 1].won && !s[s.length - 1].dead, s[s.length - 1].raw);
  const wonAt = s.length;
  const later = trace(e, 5, [[0, 4]]);
  check('player stops after the finish (x frozen, input ignored)', near(later[4].x, s[wonAt - 1].x, 1e-9) && later[4].won, later[4].raw);
  check('gd.won flagged', e.eval("ReplicatedStorage.Get('gd.won')") === 'True', '');
  const pct = Number(e.eval("__API['gd_percent'](instance_find('obj_player'))"));
  check('gd_percent is between 0 and 100 (level end = room width)', pct > 5 && pct < 100, `${pct}`);
  e.run("__API['gd_set_bounds'](360, 30, instance_find('obj_player').x)");
  check('gd_percent hits 100 at gd_end_x', Number(e.eval("__API['gd_percent'](instance_find('obj_player'))")) === 100, '');
});

// ---- 21. determinism and cost ----------------------------------------------------------------------------

await section('21. byte-identical replay and per-step cost < 8 ms', async () => {
  const build = async () => {
    const e = await setup();
    const placements = [...playerAt(2)];
    for (let i = 0; i < 12; i++) placements.push({ obj: 'obj_spike', col: 12 + i * 5, row: 0 });
    for (let i = 0; i < 8; i++) placements.push({ obj: 'obj_orb', col: 14 + i * 7, row: 2, name: `o${i}` });
    for (let i = 0; i < 6; i++) placements.push({ obj: 'obj_pad', col: 20 + i * 9, row: 0, name: `p${i}` });
    for (let i = 0; i < 3; i++) placements.push({ obj: 'obj_coin', col: 25 + i * 11, row: 1 });
    placements.push({ obj: 'obj_portal_gravity', col: 60, row: 1, name: 'pg' });
    placements.push({ obj: 'obj_portal_mode', col: 70, row: 1, name: 'pm' });
    for (let i = 0; i < 10; i++) placements.push({ obj: 'obj_spike', col: 16 + i * 4, row: 3, yscale: -1 });
    const blocks = [];
    for (let i = 0; i < 20; i++) blocks.push([30 + i * 2, 4]);
    const geo = roomWith(e, { columns: 120, blocks, placements });
    begin(e, geo);
    setField(e, 'pg', 'kind', '1');
    setField(e, 'pm', 'kind', '1');
    for (let i = 0; i < 8; i++) setField(e, `o${i}`, 'kind', JSON.stringify(['yellow', 'pink', 'red', 'blue', 'green', 'black', 'dash', 'yellow'][i]));
    for (let i = 0; i < 6; i++) setField(e, `p${i}`, 'kind', JSON.stringify(['yellow', 'pink', 'red', 'blue', 'yellow', 'pink'][i]));
    return e;
  };
  const intervals = [[0, 0], [9, 22], [40, 41], [70, 90], [131, 131], [150, 200], [230, 233], [260, 299]];
  const a = await build();
  const ra = trace(a, 300, intervals).map((s) => s.raw);
  const b = await build();
  const rb = trace(b, 300, intervals).map((s) => s.raw);
  check('300-step replay is byte-identical', ra.join('\n') === rb.join('\n'), ra.find((line, i) => line !== rb[i]) ?? '');
  check('the run did something (moved far, used objects)', Number(ra[299].split(';')[0]) > 600 || ra.some((l) => l.split(';')[6] === '1'), ra[299]);

  const c = await build();
  c.frame(INPUT.idle);
  const t0 = performance.now();
  const FRAMES = 300;
  for (let i = 0; i < FRAMES; i++) c.frame(inputAt(i, intervals));
  const per = (performance.now() - t0) / FRAMES;
  console.log(`       -> ${per.toFixed(3)} ms/step with ${c.instance_number('obj_spike') + c.instance_number('obj_orb') + c.instance_number('obj_pad')} live objects`);
  check(`per-step cost ${per.toFixed(3)} ms < 8 ms`, per < 8, `${per.toFixed(3)} ms`);

  // The physics alone: a room with just the player, so the engine's per-instance cost is out of the picture.
  const solo = await setup();
  begin(solo, roomWith(solo, { columns: 120, placements: playerAt(2) }));
  solo.frame(INPUT.idle);
  const t1 = performance.now();
  for (let i = 0; i < FRAMES; i++) solo.frame(inputAt(i, intervals));
  const perSolo = (performance.now() - t1) / FRAMES;
  console.log(`       -> ${perSolo.toFixed(3)} ms/step player only`);
  check(`player-only step ${perSolo.toFixed(3)} ms < 2 ms`, perSolo < 2, `${perSolo.toFixed(3)} ms`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
