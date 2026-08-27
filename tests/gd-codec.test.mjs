/**
 * Geometry Dash level format: the TS codec in `src/demo/gd/levels.ts` and the
 * Python one in `src/demo/gd/scripts/gd_codec.py` must agree byte for byte.
 *
 * Runs the Python side on MicroPython in Node the way python-smoke.test.mjs
 * does, and loads the TS modules through Vite's ssrLoadModule.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const script = (name) => read('src', 'demo', 'gd', 'scripts', name);

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
    const detail = String(error?.stack ?? error?.message ?? error).split('\n').slice(0, 12).join(' | ');
    console.log(`  FAIL ${name} threw -- ${detail}`);
  }
}

// ---- the TS side ----------------------------------------------------------------

async function loadModules(paths) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const out = [];
    for (const path of paths) out.push(await server.ssrLoadModule(path));
    return out;
  } finally {
    await server.close();
  }
}
const [C, L] = await loadModules(['/src/demo/gd/constants.ts', '/src/demo/gd/levels.ts']);

// ---- the Python side --------------------------------------------------------------

const { loadMicroPython } = await import(pathToFileURL(join(root, 'src', 'vendor', 'micropython.js')).href);
const printed = [];
const mp = await loadMicroPython({ stdout: (line) => printed.push(line), stderr: (line) => console.error('  py:', line) });
const hostStore = new Map();
mp.registerJsModule('__host', {
  store_get: (key) => hostStore.get(key) ?? '',
  store_set: (key, value) => (value === '' ? hostStore.delete(key) : hostStore.set(key, value)),
});
mp.runPython(read('src', 'python', 'roblox.py'));
mp.runPython(read('src', 'python', 'prelude.py'));
const g = (name) => mp.globals.get(name);

/** JSON with sorted keys, so Python's dict order does not matter. */
function norm(value) {
  return JSON.stringify(value, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
}

function freshPython() {
  g('__reset')();
  g('__register_module')('gd_const', C.constantsPython());
  g('__register_module')('gd_codec', script('gd_codec.py'));
  g('__register_module')('gd_levels', L.builtInPython());
  mp.runPython(`
_C = require("gd_codec")
_K = require("gd_const")
_LV = require("gd_levels")
def J(value):
    print(HttpService.JSONEncode(value))
def H(level):
    return {k: v for k, v in level.items() if k != "objects"}
`);
}
/** Evaluate a Python expression and return its JSON value. */
function py(expr) {
  printed.length = 0;
  mp.runPython(`J(${expr})`);
  return JSON.parse(printed.pop());
}
function pyRun(source) {
  mp.runPython(source);
}
function pyError(source) {
  try {
    mp.runPython(source);
    return '';
  } catch (error) {
    return String(error?.message ?? error);
  }
}
const q = (text) => JSON.stringify(text);

// ---- tests ---------------------------------------------------------------------------

await section('gd_const mirrors constants.ts', async () => {
  freshPython();
  for (const name of ['CELL', 'ROWS', 'FLOOR_ROWS', 'LAYER_ROWS', 'MAX_COLUMNS', 'FLOOR_Y', 'ROOM_H', 'VIEW_W', 'VIEW_H', 'SPAWN_COLS', 'MAX_OBJECTS', 'MAX_LEN']) {
    check(`${name} agrees`, py(`_K.${name}`) === C[name], `py ${py(`_K.${name}`)} ts ${C[name]}`);
  }
  check('VIEW is 570x330', C.VIEW_W === 570 && C.VIEW_H === 330);
  check('cell_y(0) puts the first row on the floor', py('_K.cell_y(0)') === C.FLOOR_Y - 15 && C.cellY(0) === C.FLOOR_Y - 15);
  check('cell_y(row) = FLOOR_Y - row*30 - 15', py('_K.cell_y(7)') === C.cellY(7) && C.cellY(7) === C.FLOOR_Y - 7 * 30 - 15);
  check('cell_x(col) centres the column', py('_K.cell_x(12)') === C.cellX(12) && C.cellX(12) === 375);
  check('tile_y counts from the top of the layer', py('_K.tile_y(0)') === C.ROWS - 1 && C.tileY(0) === 29);
  check('col_at / row_at invert cell_x / cell_y', py('_K.col_at(_K.cell_x(40))') === 40 && py('_K.row_at(_K.cell_y(9))') === 9
    && C.colAt(C.cellX(40)) === 40 && C.rowAt(C.cellY(9)) === 9);
  check('key/unkey round trip', JSON.stringify(py('_K.unkey(_K.key(123, 17))')) === '[123,17]' && C.unkey(C.key(123, 17)).join(',') === '123,17');
  check('TYPES has the nine codes', py('sorted(_K.TYPES.keys())').join('') === 'BCGMOPSVZ' && Object.keys(C.TYPES).length === 9);
  for (const code of C.TYPE_ORDER) {
    check(`TYPES.${code} params/object agree`, py(`_K.TYPES[${q(code)}]["params"]`) === C.TYPES[code].params
      && py(`_K.TYPES[${q(code)}]["object"]`) === C.TYPES[code].object);
  }
  check('S params are up/down', C.TYPES.S.params === '01' && C.TYPES.S.object === 'obj_spike');
  check('P/O params are colour letters', C.TYPES.P.params === 'yprbw' && C.TYPES.O.params === 'yprbgkwd');
  check('M has eight modes, V five speeds', C.TYPES.M.params === '01234567' && C.TYPES.V.params === '01234');
  check('PALETTE has 34 entries and starts with the block', C.PALETTE.length === 34 && C.PALETTE[0].code === 'B'
    && py('len(_K.PALETTE)') === 34);
});

await section('built-in levels round trip TS -> Python -> TS', async () => {
  freshPython();
  const builtin = py('_LV.BUILTIN');
  check('gd_levels holds three levels b1 b2 b3', builtin.map((l) => l.id).join(',') === 'b1,b2,b3');
  for (const level of L.LEVELS) {
    const data = L.levelData(level);
    const entry = builtin.find((l) => l.id === level.id);
    check(`${level.id} data in gd_levels equals levelData`, entry?.data === data);
    const back = py(`_C.encode_level(_C.decode_level(${q(data)}))`);
    check(`${level.id} Python decode/encode is the identity`, back === data, `${back.slice(0, 80)} vs ${data.slice(0, 80)}`);
    const ts = L.decodeLevel(data);
    check(`${level.id} TS decode/encode is the identity`, L.encodeLevel(ts.header, ts.objects) === data);
    check(`${level.id} TS decode keeps every object`, ts.objects.length === L.levelObjects(level).length);
    check(`${level.id} Python sees the same object count`, py(`len(_C.decode_level(${q(data)})["objects"])`) === ts.objects.length);
    check(`${level.id} header survives`, ts.header.name === level.name && ts.header.len === L.chunksWidth(level.chunks) && ts.header.diff === level.difficulty);
    check(`${level.id} solution is sorted hold intervals`, entry.solution.every(([a, b], i) => a <= b && (i === 0 || entry.solution[i - 1][1] < a)));
  }
});

await section('synthetic level with every type, parameter and runs', async () => {
  freshPython();
  const objects = [];
  let col = 8;
  for (const code of C.TYPE_ORDER) {
    const params = C.TYPES[code].params === '' ? [''] : [...C.TYPES[code].params];
    for (const param of params) {
      const run = code === 'C' ? 1 : 1 + (col % 4);
      for (let i = 0; i < run; i++) objects.push({ code, col: col + i, row: (col * 7) % C.ROWS, param });
      col += run + 1;
    }
  }
  const header = { name: 'All Types', author: 'tests', len: col + 20, mode: 3, speed: 4, size: 1, diff: 9, bg: 5, beat: 12 };
  const data = L.encodeLevel(header, objects);
  check('every type and parameter is present', L.allParams().size === new Set(objects.map((o) => `${o.code}${o.param}`)).size);
  check('runs are collapsed', /\*\d/.test(data) && !/S\d+\.\d+;S\d+\.\d+;S/.test(data.replace(/\*\d+/g, '')));
  check('default parameters are omitted', /(^|;)S\d+\.\d+(\*|;|$)/.test(data) && !/(^|;)S\d+\.\d+u/.test(data));
  const entries = data.slice(data.indexOf('|') + 1).split(';').map((e) => e.replace(/\*\d+$/, ''));
  const paramChars = entries.map((e) => e.match(/^[A-Z]\d+\.\d+(.?)$/)?.[1] ?? '?');
  check('digit parameters are written as letters', /(^|;)S\d+\.\d+d/.test(data) && /(^|;)M\d+\.\d+s/.test(data)
    && paramChars.every((p) => p === '' || /[a-z]/.test(p)), paramChars.join(''));
  const back = py(`_C.encode_level(_C.decode_level(${q(data)}))`);
  check('Python round trip is the identity', back === data, back.slice(0, 120));
  const ts = L.decodeLevel(data);
  check('TS round trip is the identity', L.encodeLevel(ts.header, ts.objects) === data);
  check('TS decode restores the header', JSON.stringify(ts.header) === JSON.stringify(L.newHeader(header)));
  const pyHeader = py(`[_C.decode_level(${q(data)})[k] for k in _K.HEADER_KEYS]`);
  check('Python decode restores the header', JSON.stringify(pyHeader) === JSON.stringify(C.HEADER_KEYS.map((k) => header[k])));
  check('object count agrees', py(`len(_C.decode_level(${q(data)})["objects"])`) === objects.length && ts.objects.length === objects.length);

  // A non-canonical string: unsorted, uncollapsed, explicit defaults, spaces.
  const messy = 'GD1;len=60;speed=1;name=Messy;mode=0 | S30.0; S20.0u ;S21.0*1;P25.3y;P26.3y;B12.4;B10.4*2 ; C40.0a;O50.2y';
  const canonical = 'GD1;name=Messy;len=60|B10.4*3;S20.0*2;P25.3*2;S30.0;C40.0;O50.2';
  check('Python canonicalises a messy string', py(`_C.encode_level(_C.decode_level(${q(messy)}))`) === canonical,
    py(`_C.encode_level(_C.decode_level(${q(messy)}))`));
  const messyTs = L.decodeLevel(messy);
  check('TS canonicalises the same string identically', L.encodeLevel(messyTs.header, messyTs.objects) === canonical);
  check('later objects at the same cell win', L.encodeObjects([{ code: 'S', col: 9, row: 0, param: '0' }, { code: 'O', col: 9, row: 0, param: 'y' }]) === 'O9.0');
});

await section('decode errors and tolerance', async () => {
  freshPython();
  const cases = [
    ['nope', 'not a GD1 level'],
    ['GD1;len=40|Q1.2', "unknown object code 'Q'"],
    ['GD1|S5', 'bad object entry'],
    ['GD1|S5x2', "missing '.'"],
    ['GD1|S5.30', 'row 30 outside 0-29'],
    ['GD1|Sx.2', 'bad column'],
    ['GD1|S5.x', 'bad row'],
    ['GD1|S5.2zz', 'bad parameter'],
    ['GD1|P5.2q', "unknown parameter 'q'"],
    ['GD1|S5.2*0', 'bad run'],
    ['GD1|B5.2x', "unknown parameter 'x' for block"],
    ['GD1|G5.2x', "unknown parameter 'x' for gravity portal"],
  ];
  for (const [text, message] of cases) {
    const pyMessage = pyError(`_C.decode_level(${q(text)})`);
    let tsMessage = '';
    try {
      L.decodeLevel(text);
    } catch (error) {
      tsMessage = String(error.message);
    }
    check(`'${text}' fails with '${message}' on both sides`, pyMessage.includes(message) && tsMessage.includes(message), `py: ${pyMessage.slice(-80)} | ts: ${tsMessage}`);
  }
  const tolerant = 'GD1;name=Keep;len=40;future=yes;flag;beat=abc|S10.0';
  const level = py(`H(_C.decode_level(${q(tolerant)}))`);
  check('unknown header keys are tolerated (Python)', level.extra.future === 'yes' && 'flag' in level.extra && level.name === 'Keep');
  check('a non-numeric known value falls back to its default', level.beat === C.HEADER_DEFAULTS.beat);
  const ts = L.decodeLevel(tolerant);
  check('unknown header keys are tolerated (TS)', ts.extra.future === 'yes' && ts.header.beat === C.HEADER_DEFAULTS.beat);
  check('re-encoding drops unknown keys identically', py(`_C.encode_level(_C.decode_level(${q(tolerant)}))`) === L.encodeLevel(ts.header, ts.objects)
    && !L.encodeLevel(ts.header, ts.objects).includes('future'));
  check('a header-only string decodes to an empty level', py(`len(_C.decode_level("GD1;len=40")["objects"])`) === 0 && L.decodeLevel('GD1;len=40').objects.length === 0);
  check('whitespace around the text is ignored', py(`_C.encode_level(_C.decode_level("  GD1;len=40|S9.0 \\n"))`) === 'GD1;name=Untitled;len=40|S9.0');
});

await section('validation messages agree', async () => {
  freshPython();
  const scenarios = [
    { label: 'a valid level', header: { name: 'Fine', len: 40 }, objects: [{ code: 'S', col: 10, row: 0, param: '0' }], expect: [] },
    { label: 'run-up occupied', header: { name: 'Fine', len: 40 }, objects: [{ code: 'S', col: 3, row: 0, param: '0' }], expect: ['columns 0-7 must be empty (the run-up)'] },
    { label: 'out of bounds', header: { name: 'Fine', len: 40 }, objects: [{ code: 'S', col: 45, row: 0, param: '0' }, { code: 'B', col: 40, row: 3, param: '' }], expect: ['2 object(s) outside the level (columns 0-39, rows 0-29)'] },
    { label: 'duplicate and too many coins', header: { name: 'Fine', len: 40 }, objects: [0, 1, 2, 3].map((i) => ({ code: 'C', col: 10 + i, row: 0, param: String(i % 3) })), expect: ['coin 0 is placed 2 times (each index once)', 'at most 3 coins'] },
    { label: 'length too short', header: { name: 'Fine', len: 5 }, objects: [], expect: [`length must be between ${C.MIN_LEN} and ${C.MAX_LEN} columns`] },
    { label: 'bad start settings', header: { name: 'Fine', len: 40, mode: 9, speed: 7, size: 2, diff: 0 }, objects: [], expect: ['start mode must be 0-7', 'start speed must be 0-4', 'size must be 0 (normal) or 1 (mini)', 'difficulty must be 1-10'] },
  ];
  for (const s of scenarios) {
    const data = L.encodeLevel(s.header, s.objects);
    const pyProblems = py(`_C.validate_level(_C.decode_level(${q(data)}))`);
    const tsProblems = L.validateLevel(s.header, s.objects);
    check(`${s.label}: Python`, JSON.stringify(pyProblems) === JSON.stringify(s.expect), JSON.stringify(pyProblems));
    check(`${s.label}: TS`, JSON.stringify(tsProblems) === JSON.stringify(s.expect), JSON.stringify(tsProblems));
  }
  const nameMessage = 'name must be 1-20 printable characters without ; or |';
  for (const bad of ['', '   ', 'x'.repeat(21), 'semi;colon', 'bar|bar', 'tab\there']) {
    pyRun(`_bad = _C.new_level(${q(bad)}); _bad["len"] = 40`);
    check(`name ${JSON.stringify(bad)} is rejected on both sides`, py('_C.validate_level(_bad)')[0] === nameMessage && L.validateLevel({ name: bad, len: 40 }, [])[0] === nameMessage);
  }
  // Too many objects.
  const many = [];
  for (let col = 8; col < 109; col++) for (let row = 0; row < C.ROWS; row++) many.push({ code: 'S', col, row, param: '0' });
  const manyData = L.encodeLevel({ name: 'Many', len: 200 }, many);
  check('too many objects (Python)', py(`_C.validate_level(_C.decode_level(${q(manyData)}))`)[0] === `too many objects (${many.length}, the limit is ${C.MAX_OBJECTS})`);
  check('too many objects (TS)', L.validateLevel({ name: 'Many', len: 200 }, many)[0] === `too many objects (${many.length}, the limit is ${C.MAX_OBJECTS})`);
  check('exactly MAX_OBJECTS is allowed', L.validateLevel({ name: 'Many', len: 200 }, many.slice(0, C.MAX_OBJECTS)).length === 0);
});

await section('state_at_column across a portal chain', async () => {
  freshPython();
  const objects = [
    { code: 'M', col: 20, row: 1, param: '1' },
    { code: 'V', col: 30, row: 1, param: '3' },
    { code: 'G', col: 40, row: 1, param: '1' },
    { code: 'Z', col: 50, row: 1, param: '1' },
    { code: 'M', col: 60, row: 1, param: '0' },
    { code: 'P', col: 70, row: 0, param: 'b' },
    { code: 'G', col: 80, row: 1, param: '0' },
  ];
  const header = { name: 'Chain', len: 100, mode: 0, speed: 1 };
  const data = L.encodeLevel(header, objects);
  const expected = {
    10: { mode: 0, speed: 1, gravity: 0, mini: 0 },
    20: { mode: 1, speed: 1, gravity: 0, mini: 0 },
    29: { mode: 1, speed: 1, gravity: 0, mini: 0 },
    30: { mode: 1, speed: 3, gravity: 0, mini: 0 },
    45: { mode: 1, speed: 3, gravity: 1, mini: 0 },
    55: { mode: 1, speed: 3, gravity: 1, mini: 1 },
    65: { mode: 0, speed: 3, gravity: 1, mini: 1 },
    75: { mode: 0, speed: 3, gravity: 0, mini: 1 },
    99: { mode: 0, speed: 3, gravity: 0, mini: 1 },
  };
  for (const [col, want] of Object.entries(expected)) {
    const pyState = py(`_C.state_at_column(_C.decode_level(${q(data)}), ${col})`);
    const tsState = L.stateAtColumn(header, objects, Number(col));
    check(`column ${col}: ${JSON.stringify(want)}`, norm(pyState) === norm(want) && norm(tsState) === norm(want),
      `py ${JSON.stringify(pyState)} ts ${JSON.stringify(tsState)}`);
  }
  const strip = py(`_C.level_states(_C.decode_level(${q(data)}))`);
  const tsStrip = L.levelStates(header, objects);
  check('level_states strip has one entry per column and matches TS', strip.length === 100 && norm(strip) === norm(tsStrip));
  check('start settings seed the state', norm(py(`_C.state_at_column(_C.decode_level("GD1;len=40;mode=4;speed=2;size=1"), 5)`)) === norm({ mode: 4, speed: 2, gravity: 0, mini: 1 }));
});

await section('level helpers', async () => {
  freshPython();
  const data = L.levelData(L.LEVELS[0]);
  pyRun(`_b1 = _C.decode_level(${q(data)})`);
  const objects = L.levelObjects(L.LEVELS[0]);
  const blocks = objects.filter((o) => o.code === 'B');
  const tiles = py('[[k[0], k[1], v] for k, v in _C.level_tiles(_b1).items()]');
  check('level_tiles has one cell per block at tile index 0', tiles.length === blocks.length && tiles.every(([, , v]) => v === C.TILE_BLOCK));
  check('level_tiles converts rows to tile rows', tiles.some(([tx, ty]) => tx === 30 && ty === C.tileY(0)) && tiles.some(([tx, ty]) => tx === 80 && ty === C.tileY(5)));
  const columns = py('sorted(_C.level_columns(_b1).keys())');
  check('level_columns lists every non-empty column', columns.length === new Set(objects.map((o) => o.col)).size && columns[0] === 12);
  const col30 = py('_C.objects_in_column(_b1, 30)');
  check('objects_in_column returns (row, code, param) rows ascending', JSON.stringify(col30) === JSON.stringify([[0, 'B', '']]));
  const col78 = py('_C.objects_in_column(_b1, 78)');
  check('the gravity portal is at column 78 row 1 under the ceiling block', JSON.stringify(col78) === JSON.stringify([[1, 'G', '1'], [5, 'B', '']]), JSON.stringify(col78));
  check('two-digit rows with a parameter round trip', py('_C.encode_level(_C.decode_level("GD1;len=40|G9.11f;C9.12c;S9.13d"))') === 'GD1;name=Untitled;len=40|G9.11f;C9.12c;S9.13d'
    && JSON.stringify(py('_C.objects_in_column(_C.decode_level("GD1;len=40|G9.11f;C9.12c;S9.13d"), 9)')) === JSON.stringify([[11, 'G', '1'], [12, 'C', '2'], [13, 'S', '1']]));
  const summary = py('_C.level_summary(_b1)');
  check('level_summary counts', summary.objects === objects.length && summary.coins === 3 && summary.blocks === blocks.length && summary.len === 116
    && summary.modes.join() === '0' && summary.speeds.join() === '1');
  check('new_level uses the defaults', py('_C.new_level("Hi")').name === 'Hi' && py('_C.new_level()').len === C.HEADER_DEFAULTS.len);
  pyRun('_n = _C.new_level("Hi"); _C.place_object(_n, "S", 10, 0); _C.place_object(_n, "O", 11, 2, "r")');
  check('place_object fills in the default parameter', py('_C.encode_objects(_n["objects"])') === 'S10.0;O11.2r');
  check('place_object rejects rows outside the grid', pyError('_C.place_object(_n, "S", 10, 30)').includes('outside the grid'));
  check('level_key / level_unkey', JSON.stringify(py('_C.level_unkey(_C.level_key(77, 3))')) === '[77,3]');
  check('mapToObjects numbers coins left to right', objects.filter((o) => o.code === 'C').map((o) => o.param).join('') === '012');
  check('objectsToMap renders the legend back', L.objectsToMap(objects, 116)[11].slice(10, 20) === '..c.....^.');
  let threw = '';
  try {
    L.mapToObjects([['..x']]);
  } catch (error) {
    threw = String(error.message);
  }
  check('mapToObjects rejects unknown characters', threw.includes("unknown map character 'x'"));
});

await section('built-in levels: validity, coverage and balance', async () => {
  freshPython();
  const used = L.usedParams();
  const all = L.allParams();
  const missing = [...all].filter((p) => !used.has(p));
  check(`every code/param is used across the set (${all.size} pairs)`, missing.length === 0, `missing ${missing.join(' ')}`);
  for (const level of L.LEVELS) {
    const header = L.levelHeader(level);
    const objects = L.levelObjects(level);
    const data = L.levelData(level);
    check(`${level.id} validate_level (Python) is clean`, py(`_C.validate_level(_C.decode_level(${q(data)}))`).length === 0, JSON.stringify(py(`_C.validate_level(_C.decode_level(${q(data)}))`)));
    check(`${level.id} validateLevel (TS) is clean`, L.validateLevel(header, objects).length === 0);
    check(`${level.id} run-up columns 0-7 are empty`, objects.every((o) => o.col >= C.SPAWN_COLS));
    const issues = L.balanceIssues(header, objects);
    check(`${level.id} obeys the mechanical balance rules`, issues.length === 0, issues.slice(0, 5).join(' / '));
    check(`${level.id} has three coins`, objects.filter((o) => o.code === 'C').length === 3);
    check(`${level.id} finish column is inside the layer`, header.len < C.MAX_COLUMNS - 8);
  }
  const [b1, b2, b3] = L.LEVELS;
  const states = (lv) => L.levelStates(L.levelHeader(lv), L.levelObjects(lv));
  check('b1 is cube-only at 1x, normal size', states(b1).every((s) => s.mode === 0 && s.speed === 1 && s.mini === 0));
  const b1Objects = L.levelObjects(b1);
  const firstCoin = b1Objects.find((o) => o.code === 'C');
  check('b1 first coin is on the ground before any hazard', firstCoin.row === 0 && b1Objects.every((o) => o.code === 'C' || o.code === 'B' || o.col > firstCoin.col));
  check('b1 has a gravity portal pair, one yellow pad and one yellow orb', b1Objects.filter((o) => o.code === 'G').map((o) => o.param).sort().join('') === '01'
    && b1Objects.filter((o) => o.code === 'P').map((o) => o.param).join('') === 'y' && b1Objects.filter((o) => o.code === 'O').map((o) => o.param).join('') === 'y');
  const s2 = states(b2);
  check('b2 visits ship, mini and 2x', s2.some((s) => s.mode === 1) && s2.some((s) => s.mini === 1) && s2.some((s) => s.speed === 2));
  const s3 = states(b3);
  check('b3 visits all eight modes', new Set(s3.map((s) => s.mode)).size === 8);
  check('b3 visits all five speeds and both sizes', new Set(s3.map((s) => s.speed)).size === 5 && new Set(s3.map((s) => s.mini)).size === 2);
  check('difficulty rises', b1.difficulty < b2.difficulty && b2.difficulty < b3.difficulty);
  // The balance checker itself catches the things it claims to.
  const bad = (objects, header = { name: 'Bad', len: 60 }) => L.balanceIssues(header, objects);
  check('checker: four ground spikes at 1x', bad([0, 1, 2, 3].map((i) => ({ code: 'S', col: 20 + i, row: 0, param: '0' }))).some((m) => m.includes('more than 3 spikes')));
  check('checker: three spikes at 1x pass', bad([0, 1, 2].map((i) => ({ code: 'S', col: 20 + i, row: 0, param: '0' }))).length === 0);
  check('checker: 3-block wall', bad([0, 1, 2].map((r) => ({ code: 'B', col: 20, row: r, param: '' }))).some((m) => m.includes('wall 3 blocks')));
  check('checker: 2-block step passes', bad([0, 1].map((r) => ({ code: 'B', col: 20, row: r, param: '' }))).length === 0);
  check('checker: spike inside a mode portal clearance', bad([{ code: 'M', col: 20, row: 1, param: '1' }, { code: 'S', col: 22, row: 0, param: '0' }]).some((m) => m.includes('within 4 columns')));
  check('checker: low ceiling over a jump', bad([{ code: 'S', col: 20, row: 0, param: '0' }, { code: 'B', col: 21, row: 3, param: '' }]).some((m) => m.includes('above the jump')));
  check('checker: UFO corridor too low', bad([{ code: 'M', col: 10, row: 1, param: '3' }, { code: 'B', col: 20, row: 2, param: '' }]).some((m) => m.includes('corridor only 2')));
  check('checker: the same corridor is fine for a ship', bad([{ code: 'M', col: 10, row: 1, param: '1' }, { code: 'B', col: 20, row: 2, param: '' }]).length === 0);
  check('checker: flipped gravity without a ceiling', bad([{ code: 'G', col: 20, row: 1, param: '1' }]).some((m) => m.includes('no ceiling')));
  check('checker: spike pit wider than 4 at 1x from a ledge', bad([
    { code: 'B', col: 20, row: 0, param: '' }, ...[0, 1, 2, 3, 4].map((i) => ({ code: 'S', col: 21 + i, row: 0, param: '0' })), { code: 'B', col: 26, row: 0, param: '' },
  ]).some((m) => m.includes('spike pit 5 wide')));
});

await section('generated Python modules', async () => {
  freshPython();
  const constText = C.constantsPython();
  const levelsText = L.builtInPython();
  check('gd_const text names the generator', constText.startsWith('# Generated by src/demo/gd/constants.ts'));
  check('gd_levels text holds BUILTIN with data strings', levelsText.includes('BUILTIN = [') && levelsText.includes('"data": "GD1;'));
  check('builtin_level finds by id', py('_LV.builtin_level("b2")["name"]') === 'Sky Lanes' && py('_LV.builtin_level("nope")') === null);
  check('generated text has no f-strings or tabs (MicroPython-safe)', !/\bf"/.test(constText + levelsText) && !/\t/.test(constText + levelsText));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
